import type { Api } from "grammy";
import type { Ctx } from "./bot.js";
import { getClock } from "./clock.js";
import {
  getTeam,
  getMembersByIds,
  createStandupRun,
  getStandupRun,
  updateStandupRun,
  createDigest,
  compileDigest,
  addLateJoinerToRun,
  type StandupRun,
  type StandupParticipant,
} from "./domain.js";
import { inlineButton, inlineKeyboard } from "./toolkit/index.js";

/**
 * Send standup prompts to members of a team.
 * If `targetMemberIds` is provided, only those members receive prompts
 * (used for per-member timezone scheduling).
 *
 * Per-member scheduling: the first timezone wave creates the run with its due
 * members as participants. Subsequent waves add their members to the existing
 * run via addLateJoinerToRun (handles the "late-joining" edge case). Each wave
 * only DMs its own due members.
 *
 * Sends a DM with the questions and "Answer now" / "Skip" buttons.
 */
export async function sendStandupPrompts(
  api: Api,
  teamId: string,
  targetMemberIds?: number[],
): Promise<void> {
  const clock = getClock();
  const today = clock.todayISO();
  const team = await getTeam(teamId);
  if (!team) return;

  const allMembers = await getMembersByIds(team.memberIds);
  if (allMembers.length === 0) return;

  // Determine which members to prompt this wave
  const membersToPrompt = targetMemberIds
    ? allMembers.filter((m) => targetMemberIds.includes(m.telegramId))
    : allMembers;

  if (membersToPrompt.length === 0) return;

  const existing = await getStandupRun(teamId, today);

  if (existing) {
    // Per-member mode — a prior timezone wave already created the run.
    // Add this wave's members to the existing run if they aren't in it yet.
    for (const m of membersToPrompt) {
      if (!existing.participants.some((p) => p.telegramId === m.telegramId)) {
        await addLateJoinerToRun(teamId, today, m.telegramId);
      }
    }
  } else {
    // First wave — create the run with this batch's members as participants
    const participants: StandupParticipant[] = membersToPrompt.map((m) => ({
      telegramId: m.telegramId,
      status: "pending" as const,
      answers: team.questions.map(() => ""),
    }));

    const run: StandupRun = {
      id: `${teamId}:${today}`,
      teamId,
      runDate: today,
      status: "open",
      participants,
      promptSentAt: clock.nowISO(),
      cutoffAt: `${today}T${String(team.schedule.cutoffHourUTC).padStart(2, "0")}:00:00Z`,
    };

    await createStandupRun(run);
  }

  // Send DM prompts to this wave's members
  for (const m of membersToPrompt) {
    try {
      let text = `📋 *${team.name} — Standup for ${today}*\n\n`;
      for (let i = 0; i < team.questions.length; i++) {
        text += `${i + 1}\\. ${escapeMd(team.questions[i])}\n`;
      }
      text += `\n_Tap "Answer now" to respond — it only takes a couple minutes\\._`;

      await api.sendMessage(m.telegramId, text, {
        parse_mode: "MarkdownV2",
        reply_markup: inlineKeyboard([
          [inlineButton("✍️ Answer now", `standup:answer:${teamId}:${today}`)],
          [inlineButton("⏭️ Skip today", `standup:skip:${teamId}:${today}`)],
        ]),
      });
    } catch (err) {
      console.warn(`Failed to DM user ${m.telegramId}: ${(err as Error).message}`);
    }
  }
}

/** Escape special characters for MarkdownV2 parse mode. */
function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Send nudges to non-responsive members (those still "pending").
 * Only sends if the run is still open (not yet at cutoff).
 */
export async function sendNudges(api: Api, teamId: string): Promise<void> {
  const clock = getClock();
  const today = clock.todayISO();
  const run = await getStandupRun(teamId, today);
  if (!run || run.status === "completed") return;

  const team = await getTeam(teamId);
  if (!team) return;

  const pending = run.participants.filter((p) => p.status === "pending");
  for (const p of pending) {
    try {
      await api.sendMessage(
        p.telegramId,
        `👋 Quick reminder — your standup for *${escapeMd(team.name)}* is still waiting\\. Have a minute to answer?`,
        {
          reply_markup: inlineKeyboard([
            [inlineButton("✍️ Answer", `standup:answer:${teamId}:${today}`)],
            [inlineButton("⏭️ Skip", `standup:skip:${teamId}:${today}`)],
          ]),
          parse_mode: "MarkdownV2",
        },
      );
    } catch {
      // 403 — user not reachable; tolerates
    }
  }
}

/**
 * Compile and post the digest for a completed run, and mark it completed.
 * Posts to the team's configured channel.
 */
export async function compileAndPostDigest(api: Api, teamId: string): Promise<boolean> {
  const clock = getClock();
  const today = clock.todayISO();
  const run = await getStandupRun(teamId, today);
  if (!run) return false;

  const team = await getTeam(teamId);
  if (!team) return false;

  const members = await getMembersByIds(team.memberIds);

  const digest = compileDigest(run, team, members);
  await createDigest(digest);
  await updateStandupRun(teamId, today, { status: "completed" });

  try {
    await api.sendMessage(team.channelId, digest.summary, { parse_mode: "Markdown" });
    return true;
  } catch (err) {
    console.error(`Failed to post digest to channel ${team.channelId}: ${(err as Error).message}`);
    return false;
  }
}