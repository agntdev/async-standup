import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  getTeamByInviteCode,
  getMember,
  createMember,
  addMemberToTeam,
  addLateJoinerToRun,
  setMemberTimezone,
} from "../domain.js";
import { getClock } from "../clock.js";

registerMainMenuItem({ label: "🔗 Join Team", data: "join:link", order: 20 });

const composer = new Composer<Ctx>();

/** Common timezone offsets for quick selection. Kept in a reasonable set. */
const TZ_OPTIONS: { label: string; offset: number; tz: string }[] = [
  { label: "UTC−12 (Baker Island)", offset: -12, tz: "Etc/GMT+12" },
  { label: "UTC−10 (Hawaiʻi)", offset: -10, tz: "Pacific/Honolulu" },
  { label: "UTC−8 (US Pacific)", offset: -8, tz: "America/Los_Angeles" },
  { label: "UTC−7 (US Mountain)", offset: -7, tz: "America/Denver" },
  { label: "UTC−6 (US Central)", offset: -6, tz: "America/Chicago" },
  { label: "UTC−5 (US Eastern)", offset: -5, tz: "America/New_York" },
  { label: "UTC−3 (Brazil, Argentina)", offset: -3, tz: "America/Sao_Paulo" },
  { label: "UTC+0 (UK, Portugal)", offset: 0, tz: "Europe/London" },
  { label: "UTC+1 (Central Europe)", offset: 1, tz: "Europe/Berlin" },
  { label: "UTC+2 (Eastern Europe)", offset: 2, tz: "Europe/Kyiv" },
  { label: "UTC+3 (Moscow, East Africa)", offset: 3, tz: "Europe/Moscow" },
  { label: "UTC+4 (Dubai, Caucasus)", offset: 4, tz: "Asia/Dubai" },
  { label: "UTC+5 (Pakistan)", offset: 5, tz: "Asia/Karachi" },
  { label: "UTC+5:30 (India)", offset: 5.5, tz: "Asia/Kolkata" },
  { label: "UTC+7 (Thailand, Vietnam)", offset: 7, tz: "Asia/Bangkok" },
  { label: "UTC+8 (China, Singapore)", offset: 8, tz: "Asia/Shanghai" },
  { label: "UTC+9 (Japan, Korea)", offset: 9, tz: "Asia/Tokyo" },
  { label: "UTC+10 (Sydney)", offset: 10, tz: "Australia/Sydney" },
  { label: "UTC+12 (New Zealand)", offset: 12, tz: "Pacific/Auckland" },
];

function tzPickerKeyboard(code: string): ReturnType<typeof inlineKeyboard> {
  const rows: ReturnType<typeof inlineButton>[][] = [];
  // Show 3 per row to keep it compact
  for (let i = 0; i < TZ_OPTIONS.length; i += 3) {
    rows.push(
      TZ_OPTIONS.slice(i, i + 3).map((opt) =>
        inlineButton(opt.label, `join:tz:${code}:${opt.offset}:${encodeURIComponent(opt.tz)}`),
      ),
    );
  }
  // Add a custom/manual entry option
  rows.push([inlineButton("⌨️ Enter UTC offset manually", `join:tz:${code}:manual`)]);
  return inlineKeyboard(rows);
}

/**
 * Finalize a join — creates the member record and adds to the team.
 * The timezone offset is set from the selection.
 */
async function finalizeJoin(
  ctx: Ctx,
  teamId: string,
  telegramId: number,
  displayName: string,
  tz: string,
  offset: number,
) {
  const clock = getClock();
  await createMember({
    telegramId,
    displayName,
    timezone: tz,
    timezoneOffsetHours: offset,
    teamId,
    joinedAt: clock.nowISO(),
  });
  await addMemberToTeam(teamId, telegramId);
  await addLateJoinerToRun(teamId, clock.todayISO(), telegramId);
}

// ── Team switch confirmation ──────────────────────────────────────────────

composer.callbackQuery(/^join:switch:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const newTeamCode = ctx.match[1];
  const { deleteMember } = await import("../domain.js");
  await deleteMember(ctx.from!.id);

  // Now join the new team
  const team = await getTeamByInviteCode(newTeamCode);
  if (!team) {
    ctx.session.step = "idle";
    await ctx.editMessageText(
      "That team is no longer available. The invite may have expired.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const displayName = ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : "");
  ctx.session.step = "awaiting_timezone";
  (ctx.session as any).tempTeamId = team.id;

  await ctx.editMessageText(
    `Joining ${team.name}! Pick your timezone so your standup prompts arrive at the right time:`,
    { reply_markup: tzPickerKeyboard(team.id) },
  );
});

// ── Join via deep link ────────────────────────────────────────────────────

composer.command("start", async (ctx, next) => {
  const payload = ctx.match;
  if (!payload || typeof payload !== "string" || payload.trim().length < 1) {
    return next(); // plain /start → main menu
  }

  const code = payload.trim();

  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    if (existingMember.teamId === code) {
      await ctx.reply(
        `You're already on team "${existingMember.teamId}". Use the main menu to get around.`,
        { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
      );
      return;
    }
    // Joining a different team — ask to leave current first
    ctx.session.step = "awaiting_switch_team";
    (ctx.session as any).pendingTeamCode = code;
    const { getTeam } = await import("../domain.js");
    const currentTeam = await getTeam(existingMember.teamId);
    await ctx.reply(
      `You're currently on team "${currentTeam?.name ?? existingMember.teamId}". Switching to a new team means leaving the current one. Continue?`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Yes, switch teams", `join:switch:${code}`)],
          [inlineButton("⬅️ No, stay put", "menu:main")],
        ]),
      },
    );
    return;
  }

  const team = await getTeamByInviteCode(code);
  if (!team) {
    await ctx.reply(
      "That invite code doesn't match any team, or it may have expired. Check with your team admin for the right link, or create your own team.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const displayName = ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : "");
  ctx.session.tempTeamId = team.id;
  ctx.session.step = "awaiting_timezone";
  ctx.session.tempAnswers = undefined; // reuse for tz code storage
  delete ctx.session.tempAnswers;

  await ctx.reply(
    `Almost there! First — pick your timezone so I send your standup prompts at the right time:`,
    { reply_markup: tzPickerKeyboard(team.id) },
  );
});

// ── Timezone picker callback (during join) ────────────────────────────────

composer.callbackQuery(/^join:tz:(.+):/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  // Format: join:tz:<teamId>:(offset|manual)[:tzName]
  const teamId = parts[2];
  const val = parts[3];

  if (val === "manual") {
    ctx.session.step = "awaiting_manual_tz";
    delete (ctx.session as any).tempTeamId;
    (ctx.session as any).tempTeamId = teamId;
    await ctx.editMessageText(
      "Enter your UTC offset as a number, e.g. `-5`, `+0`, `+8`, `+5.5`:",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to tz picker", `join:back:${teamId}`)]]),
        parse_mode: "Markdown",
      },
    );
    return;
  }

  const offset = parseFloat(val);
  const tz = decodeURIComponent(parts.slice(4).join(":")); // tz name may contain colons

  if (isNaN(offset)) return;

  const displayName = ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : "");

  await finalizeJoin(ctx, teamId, ctx.from!.id, displayName, tz, offset);
  ctx.session.step = "idle";

  const team = await getTeamByInviteCode(teamId);
  await ctx.editMessageText(
    `🎉 Welcome to *${escapeMd(team?.name ?? "your team")}*! You're all set — I'll send you standup prompts at your local time.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Team Settings", "team:settings")],
        [inlineButton("⬅️ Main menu", "menu:main")],
      ]),
      parse_mode: "MarkdownV2",
    },
  );
});

// ── Back button from manual TZ to picker ──────────────────────────────────

composer.callbackQuery(/^join:back:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  ctx.session.step = "awaiting_timezone";
  await ctx.editMessageText(
    "Pick your timezone:",
    { reply_markup: tzPickerKeyboard(teamId) },
  );
});

// ── Manual TZ offset input during join ────────────────────────────────────

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step === "awaiting_manual_tz") {
    const teamId = (ctx.session as any).tempTeamId as string | undefined;
    if (!teamId) {
      ctx.session.step = "idle";
      return;
    }
    const raw = ctx.message.text.trim();
    const offset = parseFloat(raw.replace(/[^\-0-9.]/g, ""));
    if (isNaN(offset) || offset < -12 || offset > 14) {
      await ctx.reply("Enter a UTC offset between -12 and +14 (e.g. `-5`, `+3`, `+5.5`):", { parse_mode: "Markdown" });
      return;
    }
    const team = await getTeamByInviteCode(teamId);
    if (!team) {
      ctx.session.step = "idle";
      await ctx.reply("That team doesn't seem to exist anymore.", {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Main menu", "menu:main")]]),
      });
      return;
    }
    const displayName = ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : "");
    const tzLabel = offset >= 0 ? `UTC+${offset}` : `UTC${offset}`;
    await finalizeJoin(ctx, teamId, ctx.from!.id, displayName, tzLabel, offset);
    ctx.session.step = "idle";
    await ctx.reply(
      `🎉 Welcome to *${escapeMd(team.name)}*! You're all set. I'll send you standup prompts at your local time.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⚙️ Team Settings", "team:settings")],
          [inlineButton("⬅️ Main menu", "menu:main")],
        ]),
        parse_mode: "MarkdownV2",
      },
    );
    return;
  }
  return next();
});

// ── Join via button (manual code entry) ───────────────────────────────────

composer.callbackQuery("join:link", async (ctx) => {
  await ctx.answerCallbackQuery();

  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    const { getTeam } = await import("../domain.js");
    const team = await getTeam(existingMember.teamId);
    await ctx.editMessageText(
      `You're on team "${team?.name ?? existingMember.teamId}". You can switch by tapping the invite link of another team. Use settings to edit your timezone.`,
      { reply_markup: inlineKeyboard([
        [inlineButton("🕐 My timezone", "settings:my:timezone")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]) },
    );
    return;
  }

  ctx.session.step = "awaiting_join_code";
  await ctx.editMessageText(
    "Got an invite link or a join code from your team admin? Send it here — it's usually an 8-letter code you tap or paste.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

/** Coerce a member to use a simple timezone heuristics and prompt them to pick.
 *  Since the Telegram Bot API does NOT expose the user's timezone directly,
 *  we MUST ask the user to select their timezone during onboarding. */
async function promptTimezoneSelection(ctx: Ctx, teamId: string) {
  ctx.session.step = "awaiting_timezone";
  (ctx.session as any).tempTeamId = teamId;
  await ctx.reply(
    "Pick your timezone so I schedule your standups at the right time:",
    { reply_markup: tzPickerKeyboard(teamId) },
  );
}

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_code") return next();
  return next(); // handle via the next handler below
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_code") return next();

  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    ctx.session.step = "idle";
    await ctx.reply("You're already on a team.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Main menu", "menu:main")]]),
    });
    return;
  }

  let code = ctx.message.text.trim();
  const linkMatch = code.match(/[?&]start=([A-Za-z0-9_-]+)/);
  if (linkMatch) code = linkMatch[1];
  code = code.slice(0, 32);

  if (code.length < 4) {
    await ctx.reply(
      "That doesn't look like a valid code. It should be around 8 characters — check with your team admin.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    ctx.session.step = "idle";
    return;
  }

  const team = await getTeamByInviteCode(code);
  if (!team) {
    await ctx.reply(
      `No team found with code "${code}". Check the spelling and try again, or ask your admin for the right link.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Team found — now prompt for timezone before completing join
  ctx.session.step = "awaiting_timezone";
  (ctx.session as any).tempTeamId = team.id;
  await ctx.reply(
    `Found team "${team.name}"! Pick your timezone so your standup prompts arrive at the right time:`,
    { reply_markup: tzPickerKeyboard(team.id) },
  );
});

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export default composer;