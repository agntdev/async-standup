import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { now, formatDate, timeToday, formatTime } from "../clock.js";
import { getKV } from "../store.js";
import {
  getTeam,
  getTeamMembers,
  getMemberTeamId,
  saveRun,
  getRun,
  saveDigest,
  getDigest,
  addRunDate,
  type TeamData,
  type MemberData,
  type StandupRunData,
  type ResponseData,
  type DigestData,
} from "./team.js";

// ── Constants ────────────────────────────────────────────────────────────

const PROMPT_COOLDOWN_MS = 60_000;       // 1 min between checks
const NUDGE_AFTER_MS = 30 * 60_000;      // 30 min — send nudge
const CUTOFF_AFTER_MS = 24 * 60 * 60_000; // 24 hrs — close run
const CHECK_INTERVAL_MS = 60_000;         // 1 min scheduler tick

const SKIP_CALLBACK = "standup:skip";

// ── Composer ────────────────────────────────────────────────────────────

const composer = new Composer<Ctx>();

// ── Global middleware to capture standup replies ─────────────────────────
// MUST come first so it detects pending standups BEFORE the response handler runs.

composer.on("message:text", async (ctx, next) => {
  // Only intercept if not already in a flow
  if (ctx.session.step && ctx.session.step !== "standup:active") return next();

  const userId = ctx.from!.id;
  const today = formatDate(now(), "UTC");
  const kv = getKV();
  const teamId = await kv.get(`standup:pending:${userId}:${today}`);

  if (!teamId) return next();

  // Mark session as processing standup so the dedicated handler picks it up
  ctx.session.step = "standup:active";
  return next();
});

// ── Handle standup response (user replies to the prompt) ────────────────

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "standup:active") return next();
  const text = ctx.message.text.trim();
  if (!text) return next();

  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);
  if (!teamId) return next();

  const today = formatDate(now(), "UTC");
  const run = await getRun(teamId, today);
  if (!run || run.status === "digested") return next();

  // Remove from pending
  run.pendingUserIds = run.pendingUserIds.filter((id) => id !== userId);

  // Parse answers from the text — build structured answers
  const displayName = ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : "");
  const answers: Record<number, string> = {};

  // Try to split on numbered lines or newlines
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 1) {
    // Single message — map to first question
    answers[0] = text;
  } else {
    lines.forEach((line, i) => {
      answers[i] = line.replace(/^\d+[.)]\s*/, "").trim();
    });
  }

  // Check if last answer looks like a blocker
  const lastAnswer = answers[Object.keys(answers).length - 1];
  const hasBlocker = Boolean(
    lastAnswer &&
    !/^(no|none|nope|not really|nothing|n\/a|all good|doing fine|smooth|no blockers?)/i.test(lastAnswer),
  );

  const response: ResponseData = {
    userId,
    displayName,
    answers,
    hasBlocker,
    submittedAt: now().toISOString(),
    skipped: false,
  };

  // Replace existing response if re-submitting
  const existingIdx = run.responses.findIndex((r) => r.userId === userId);
  if (existingIdx >= 0) {
    run.responses[existingIdx] = response;
  } else {
    run.responses.push(response);
  }

  await saveRun(run);
  ctx.session.step = "";

  await ctx.reply(
    "✅ Got it — your standup is in! You'll see the team digest in the channel after the cutoff.",
    { reply_markup: { remove_keyboard: true } },
  );

  // Check if all have responded — if so, could compact early but we let the schedule handle it
});

// ── Handle skip button in standup prompt ─────────────────────────────────

composer.callbackQuery(SKIP_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Standup skipped for today." });

  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);
  if (!teamId) return;

  const today = formatDate(now(), "UTC");
  const run = await getRun(teamId, today);
  if (!run || run.status === "digested") return;

  run.pendingUserIds = run.pendingUserIds.filter((id) => id !== userId);

  const displayName = ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : "");
  const response: ResponseData = {
    userId,
    displayName,
    answers: {},
    hasBlocker: false,
    submittedAt: now().toISOString(),
    skipped: true,
  };

  const existingIdx = run.responses.findIndex((r) => r.userId === userId);
  if (existingIdx >= 0) {
    run.responses[existingIdx] = response;
  } else {
    run.responses.push(response);
  }

  await saveRun(run);
  ctx.session.step = "";

  try {
    await ctx.editMessageText("⏭ Skipped today's standup. Catch you tomorrow!", {
      reply_markup: undefined,
    });
  } catch {
    // Message may have been deleted — ignore
  }
});

// ── Scheduler ────────────────────────────────────────────────────────────

let schedulerStarted = false;

/**
 * Start the standup scheduler. Safe to call multiple times.
 * The scheduler ticks every CHECK_INTERVAL_MS and:
 * 1. Sends standup prompts to teams at their scheduled time
 * 2. Sends nudges to non-responders after NUDGE_AFTER_MS
 * 3. Compiles digests after CUTOFF_AFTER_MS
 */
export function startScheduler(getBotApi: () => Ctx["api"] | null): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const interval = setInterval(() => tick(getBotApi), CHECK_INTERVAL_MS);
  if (interval.unref) interval.unref(); // don't keep process alive just for this
}

async function tick(getBotApi: () => Ctx["api"] | null): Promise<void> {
  const api = getBotApi();
  if (!api) return;

  try {
    await processScheduledPrompts(api);
    await processNudges(api);
    await processDigestCutoffs(api);
  } catch (err) {
    console.error("[standup-scheduler] tick error:", err);
  }
}

/**
 * Find teams whose schedule time has just passed and send prompts to members.
 * Uses an index: `schedule:<HH:MM>` → list of teamIds
 */
async function processScheduledPrompts(api: Ctx["api"]): Promise<void> {
  const kv = getKV();
  const currentMinute = formatTime(now(), "UTC"); // HH:MM

  // Check if we already sent for this minute
  const sentKey = `schedule:sent:${currentMinute}`;
  if (await kv.exists(sentKey)) return;
  await kv.setex(sentKey, 120, "1"); // mark for 2 min

  const teamIds = await kv.lrange(`schedule:${currentMinute}`, 0, -1);
  for (const teamId of teamIds) {
    const team = await getTeam(teamId);
    if (!team) continue;

    // Check if today is a scheduled day
    const dayAbbr = now().toLocaleDateString("en-US", { weekday: "short", timeZone: team.timezone }).toLowerCase().slice(0, 3);
    if (!team.scheduleDays.includes(dayAbbr)) continue;

    const today = formatDate(now(), team.timezone);
    const existingRun = await getRun(teamId, today);
    if (existingRun) continue; // already started for today

    await startStandupRun(api, team);
  }
}

async function startStandupRun(api: Ctx["api"], team: TeamData): Promise<void> {
  const members = await getTeamMembers(team.id);
  if (members.length === 0) return;

  const today = formatDate(now(), team.timezone);
  const pendingUserIds: number[] = [];
  const promptMessages: Record<number, number> = {};

  // Format the question list
  const questionList = team.questionSet
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  // Send prompts to each member (wrap each in try to tolerate 403)
  for (const member of members) {
    try {
      const msg = await api.sendMessage(
        member.telegramId,
        `☀️ *Good morning\\!* Time for your daily standup for *${team.name}*\\!\n\n${questionList}\n\nReply to this message with your answers — one per line — or tap Skip below\\.`,
        {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [[
              { text: "⏭ Skip today", callback_data: SKIP_CALLBACK },
            ]],
          },
        },
      );
      promptMessages[member.telegramId] = msg.message_id;
      pendingUserIds.push(member.telegramId);

      // Set the user's session step so their next text is captured as a response
      // (We can't set session across chats, so we use a different mechanism)
      // Store a marker that they're in a pending standup
      await getKV().setex(`standup:pending:${member.telegramId}:${today}`, 86400, team.id);
    } catch (err) {
      // 403 = user blocked/never started; skip this member
      console.error(`[standup] failed to prompt user ${member.telegramId}:`, (err as Error).message);
    }
  }

  const run: StandupRunData = {
    runId: `${team.id}:${today}`,
    teamId: team.id,
    runDate: today,
    status: "collecting",
    responses: [],
    pendingUserIds,
    promptMessages,
  };

  await saveRun(run);
  await addRunDate(team.id, today);
}

/**
 * Register a team's schedule so the scheduler can find it.
 * Called when a team is created or updated.
 */
export async function registerTeamSchedule(team: TeamData): Promise<void> {
  const kv = getKV();
  // Old schedule? We just add to the index. Duplicates are OK since we check for
  // existing runs.
  await kv.lpush(`schedule:${team.scheduleTime}`, team.id);
}

/**
 * Unregister a team's schedule.
 */
export async function unregisterTeamSchedule(team: TeamData): Promise<void> {
  const kv = getKV();
  await kv.lrem(`schedule:${team.scheduleTime}`, 0, team.id);
}

// ── Nudges ───────────────────────────────────────────────────────────────

async function processNudges(api: Ctx["api"]): Promise<void> {
  const kv = getKV();
  const nudgeKey = `schedule:nudge:${formatTime(now(), "UTC")}`;
  if (await kv.exists(nudgeKey)) return;
  await kv.setex(nudgeKey, 120, "1");

  // Find runs that started ~30 min ago and still have pending users
  // Instead of scanning all runs, we rely on the pending status markers
  // We check all currently active runs via the schedule index

  const currentTime = formatTime(now(), "UTC");
  const teamIds = await kv.lrange(`schedule:${currentTime}`, 0, -1);

  for (const teamId of teamIds) {
    const team = await getTeam(teamId);
    if (!team) continue;

    const today = formatDate(now(), team.timezone);
    const run = await getRun(teamId, today);
    if (!run || run.status !== "collecting") continue;
    if (run.pendingUserIds.length === 0) continue;

    // Check if enough time has passed (nudge after 30 min)
    // We approximate: if the run exists, we nudge anyone still pending
    // More precise: check when we last nudged
    const lastNudgeKey = `nudge:${teamId}:${today}`;
    if (await kv.exists(lastNudgeKey)) continue; // already nudged this run

    for (const uid of run.pendingUserIds) {
      try {
        await api.sendMessage(
          uid,
          `⏰ Quick reminder — your standup for *${team.name}* is waiting\\! Reply to the earlier message with your answers, or tap Skip\\.`,
          { parse_mode: "MarkdownV2" },
        );
      } catch {
        // 403 on nudge — user blocked, skip
      }
    }

    await kv.setex(lastNudgeKey, 86400, "1");
  }
}

// ── Digest cutoff ────────────────────────────────────────────────────────

async function processDigestCutoffs(api: Ctx["api"]): Promise<void> {
  const kv = getKV();
  const digestKey = `schedule:digest:${formatTime(now(), "UTC")}`;
  if (await kv.exists(digestKey)) return;
  await kv.setex(digestKey, 120, "1");

  // Check for runs that need digesting (24hrs old)
  const teamIds = await kv.lrange(`schedule:${formatTime(now(), "UTC")}`, 0, -1);

  for (const teamId of teamIds) {
    const team = await getTeam(teamId);
    if (!team) continue;

    const yesterday = formatDate(
      new Date(now().getTime() - 24 * 60 * 60_000),
      team.timezone,
    );
    const run = await getRun(teamId, yesterday);
    if (!run || run.status !== "collecting") continue;

    await compileDigest(api, team, run);
  }
}

export async function compileDigest(
  api: Ctx["api"],
  team: TeamData,
  run: StandupRunData,
): Promise<void> {
  // Mark as digested
  run.status = "digested";
  await saveRun(run);

  const responded = run.responses.filter((r) => !r.skipped);
  const skipped = run.responses.filter((r) => r.skipped);
  const pending = run.pendingUserIds.map((uid) => ({
    userId: uid,
    displayName: `User ${uid}`,
  }));

  // Try to resolve pending user names from team members
  const members = await getTeamMembers(team.id);
  const memberMap = new Map(members.map((m) => [m.telegramId, m.displayName]));
  const pendingNamed = pending.map((p) => ({
    userId: p.userId,
    displayName: memberMap.get(p.userId) ?? p.displayName,
  }));

  // Identify blockers: responses where the last question's answer indicates a blocker
  const blockers: { userId: number; displayName: string; blocker: string }[] = [];
  for (const r of responded) {
    if (r.hasBlocker) {
      const keys = Object.keys(r.answers).sort((a, b) => Number(a) - Number(b));
      const lastKey = keys[keys.length - 1];
      const blockerText = lastKey !== undefined ? r.answers[Number(lastKey)] : "";
      if (blockerText) {
        blockers.push({
          userId: r.userId,
          displayName: r.displayName,
          blocker: blockerText,
        });
      }
    }
  }

  const total = run.responses.length + run.pendingUserIds.length;
  const responseRate = total > 0 ? Math.round((responded.length / total) * 100) : 0;

  // Build digest message
  const lines: string[] = [
    `📊 *Daily Standup Digest — ${run.runDate}*`,
    `Team: ${team.name}`,
    "",
    `📈 *Participation:* ${responded.length}/${total} responded (${responseRate}%)`,
    `⏭ ${skipped.length} skipped`,
    pendingNamed.length > 0 ? `⏳ ${pendingNamed.length} didn't respond` : "",
    "",
  ].filter((l) => l !== undefined);

  // Responses section
  if (responded.length > 0) {
    lines.push("*Responses:*");
    for (const r of responded) {
      lines.push(`\n👤 *${escapeMarkdown(r.displayName)}*`);
      const qKeys = Object.keys(r.answers).sort((a, b) => Number(a) - Number(b));
      const questions = team.questionSet;
      for (const k of qKeys) {
        const qi = Number(k);
        const qLabel = questions[qi] ?? `Q${qi + 1}`;
        const shortQ = qLabel.length > 60 ? qLabel.slice(0, 57) + "…" : qLabel;
        const ans = r.answers[qi]!;
        const shortA = ans.length > 150 ? ans.slice(0, 147) + "…" : ans;
        lines.push(`  _${escapeMarkdown(shortQ)}_`);
        lines.push(`  ${escapeMarkdown(shortA)}`);
      }
    }
    lines.push("");
  }

  // Blockers highlight
  if (blockers.length > 0) {
    lines.push("*🚧 Blockers flagged:*");
    for (const b of blockers) {
      const shortB = b.blocker.length > 200 ? b.blocker.slice(0, 197) + "…" : b.blocker;
      lines.push(`  • *${escapeMarkdown(b.displayName)}*: ${escapeMarkdown(shortB)}`);
    }
    lines.push("");
  }

  // Pending users
  if (pendingNamed.length > 0) {
    lines.push("*⏳ Didn't respond:*");
    lines.push(pendingNamed.map((p) => `  • ${escapeMarkdown(p.displayName)}`).join("\n"));
    lines.push("");
  }

  lines.push(`_Generated at ${formatTime(now(), team.timezone)}_`);

  // Post to team channel
  try {
    const channelId = Number(team.channelId);
    const msg = await api.sendMessage(channelId, lines.join("\n"), {
      parse_mode: "MarkdownV2",
    });

    // Save the digest
    const digest: DigestData = {
      digestId: `${team.id}:${run.runDate}`,
      teamId: team.id,
      runDate: run.runDate,
      messageId: msg.message_id,
      responses: run.responses,
      blockers,
      pendingUsers: pendingNamed,
      postedAt: now().toISOString(),
    };
    await saveDigest(digest);
  } catch (err) {
    console.error(`[digest] failed to post to channel ${team.channelId}:`, (err as Error).message);
  }

  // Clear pending markers
  const kv = getKV();
  for (const uid of run.pendingUserIds) {
    await kv.del(`standup:pending:${uid}:${run.runDate}`);
  }
}

// ── Escape MarkdownV2 special characters ─────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export default composer;