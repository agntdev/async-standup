import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  createTeam,
  createMember,
  getMember,
  generateInviteCode,
  type Team,
} from "../domain.js";
import { getClock } from "../clock.js";

registerMainMenuItem({ label: "➕ Create Team", data: "team:create", order: 10 });

const composer = new Composer<Ctx>();

const DEFAULT_QUESTIONS = [
  "What did you accomplish yesterday?",
  "What are you working on today?",
  "Any blockers or impediments?",
];

/** Common timezone offsets for quick selection */
const TZ_OPTIONS: { label: string; offset: number; tz: string }[] = [
  { label: "UTC−12", offset: -12, tz: "Etc/GMT+12" },
  { label: "UTC−10 (Hawaiʻi)", offset: -10, tz: "Pacific/Honolulu" },
  { label: "UTC−8 (US Pacific)", offset: -8, tz: "America/Los_Angeles" },
  { label: "UTC−7 (US Mountain)", offset: -7, tz: "America/Denver" },
  { label: "UTC−6 (US Central)", offset: -6, tz: "America/Chicago" },
  { label: "UTC−5 (US Eastern)", offset: -5, tz: "America/New_York" },
  { label: "UTC−3 (Brazil)", offset: -3, tz: "America/Sao_Paulo" },
  { label: "UTC+0 (UK)", offset: 0, tz: "Europe/London" },
  { label: "UTC+1 (Central EU)", offset: 1, tz: "Europe/Berlin" },
  { label: "UTC+2 (Eastern EU)", offset: 2, tz: "Europe/Kyiv" },
  { label: "UTC+3 (Moscow)", offset: 3, tz: "Europe/Moscow" },
  { label: "UTC+4 (Dubai)", offset: 4, tz: "Asia/Dubai" },
  { label: "UTC+5 (Pakistan)", offset: 5, tz: "Asia/Karachi" },
  { label: "UTC+5:30 (India)", offset: 5.5, tz: "Asia/Kolkata" },
  { label: "UTC+7 (Bangkok)", offset: 7, tz: "Asia/Bangkok" },
  { label: "UTC+8 (China)", offset: 8, tz: "Asia/Shanghai" },
  { label: "UTC+9 (Japan)", offset: 9, tz: "Asia/Tokyo" },
  { label: "UTC+10 (Sydney)", offset: 10, tz: "Australia/Sydney" },
  { label: "UTC+12 (Auckland)", offset: 12, tz: "Pacific/Auckland" },
];

// ── Step 1: Name the team ──────────────────────────────────────────────────

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_team_name";
  await ctx.editMessageText(
    "Let's create your team! First — what would you like to name it?",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

// ── Handle text during team creation ───────────────────────────────────────

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step as string;
  if (step !== "awaiting_team_name" &&
      step !== "awaiting_team_channel" &&
      step !== "awaiting_team_prompt_hour" &&
      step !== "awaiting_team_cutoff_hour" &&
      step !== "awaiting_team_timezone") {
    return next();
  }

  if (step === "awaiting_team_name") {
    const name = ctx.message.text.trim();
    if (name.length < 2 || name.length > 64) {
      await ctx.reply("Team name should be 2 to 64 characters. Try again.");
      return;
    }
    ctx.session.tempTeamName = name;
    ctx.session.step = "awaiting_team_channel";
    await ctx.reply(
      "Great! Now send me the Telegram channel ID where the daily digest should be posted.\n\n_Add this bot as an admin to your channel first, then forward a message from the channel here, or type the channel ID (e.g. -1001234567890)._",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back", "menu:main")],
        ]),
      },
    );
    return;
  }

  if (step === "awaiting_team_channel") {
    const raw = ctx.message.text.trim();
    // Accept a forwarded message or direct ID
    let channelId: number;
    // forwarded messages carry the source chat in this property
    const fwd = (ctx.message as unknown as { forward_from_chat?: { id: number } }).forward_from_chat;
    if (fwd) {
      channelId = fwd.id;
    } else {
      channelId = parseInt(raw.replace(/[^\-0-9]/g, ""), 10);
    }
    if (isNaN(channelId)) {
      await ctx.reply(
        "Couldn't read that channel ID. Forward a message from the channel, or type the channel ID directly (it usually starts with -100).",
      );
      return;
    }
    ctx.session.tempChannelId = channelId;
    ctx.session.step = "awaiting_team_prompt_hour";
    await ctx.reply(
      "At what UTC hour (0–23) should I send the standup prompts?",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⏰ 09:00 UTC", "team:pick_prompt:9")],
          [inlineButton("⏰ 10:00 UTC", "team:pick_prompt:10")],
          [inlineButton("⏰ 14:00 UTC", "team:pick_prompt:14")],
          [inlineButton("⌨️ Enter manually", "team:pick_prompt:manual")],
        ]),
      },
    );
    return;
  }
});

// ── Quick-pick prompt hours ────────────────────────────────────────────────

composer.callbackQuery(/^team:pick_prompt:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const val = ctx.callbackQuery.data.split(":")[2];
  if (val === "manual") {
    ctx.session.step = "awaiting_team_prompt_hour";
    await ctx.editMessageText("Enter the UTC hour (0–23) for standup prompts:");
    return;
  }
  const hour = parseInt(val, 10);
  ctx.session.tempPromptHour = hour;
  ctx.session.step = "awaiting_team_cutoff_hour";
  await ctx.editMessageText(
    `Prompts at ${hour}:00 UTC. What UTC hour for the digest cutoff?`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🕐 17:00 UTC", "team:pick_cutoff:17")],
        [inlineButton("🕐 18:00 UTC", "team:pick_cutoff:18")],
        [inlineButton("🕐 20:00 UTC", "team:pick_cutoff:20")],
        [inlineButton("⌨️ Enter manually", "team:pick_cutoff:manual")],
      ]),
    },
  );
});

composer.callbackQuery(/^team:pick_cutoff:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const val = ctx.callbackQuery.data.split(":")[2];
  if (val === "manual") {
    ctx.session.step = "awaiting_team_cutoff_hour";
    await ctx.editMessageText("Enter the UTC hour (0–23) for the digest cutoff:");
    return;
  }
  const cutoffHour = parseInt(val, 10);
  const promptHour = ctx.session.tempPromptHour as number;
  if (cutoffHour <= promptHour) {
    await ctx.editMessageText(
      `The cutoff hour (${cutoffHour}:00 UTC) needs to be after the prompt hour (${promptHour}:00 UTC). Tap to try again.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("🕐 17:00 UTC", "team:pick_cutoff:17")],
          [inlineButton("🕐 18:00 UTC", "team:pick_cutoff:18")],
          [inlineButton("🕐 20:00 UTC", "team:pick_cutoff:20")],
          [inlineButton("⌨️ Enter manually", "team:pick_cutoff:manual")],
        ]),
      },
    );
    return;
  }
  // Store cutoff and prompt for timezone
  ctx.session.tempCutoffHour = cutoffHour;
  ctx.session.step = "awaiting_team_timezone";
  await ctx.editMessageText(
    `Now — what's your timezone? I'll use it to send standup prompts at your local time.`,
    { reply_markup: buildTzKeyboard("team:tz") },
  );
});

// ── Manual hour input ──────────────────────────────────────────────────────

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step as string;
  if (step !== "awaiting_team_prompt_hour" && step !== "awaiting_team_cutoff_hour") {
    return next();
  }

  if (step === "awaiting_team_prompt_hour") {
    const hour = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      await ctx.reply("Enter a number from 0 to 23.");
      return;
    }
    ctx.session.tempPromptHour = hour;
    ctx.session.step = "awaiting_team_cutoff_hour";
    await ctx.reply(`Prompts at ${hour}:00 UTC. What UTC hour for the digest cutoff? (0–23)`);
    return;
  }

  if (step === "awaiting_team_cutoff_hour") {
    const hour = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      await ctx.reply("Enter a number from 0 to 23.");
      return;
    }
    const promptHour = ctx.session.tempPromptHour as number;
    if (hour <= promptHour) {
      await ctx.reply(
        `The cutoff hour (${hour}:00 UTC) needs to be after the prompt hour (${promptHour}:00 UTC). Try again with a later hour (0–23):`,
      );
      return;
    }
    ctx.session.tempCutoffHour = hour;
    ctx.session.step = "awaiting_team_timezone";
    await ctx.reply(
      "Now — what's your timezone? I'll use it to send standup prompts at your local time.",
      { reply_markup: buildTzKeyboard("team:tz") },
    );
    return;
  }

  return next();
});

// ── Completion ─────────────────────────────────────────────────────────────

/** Build the timezone picker keyboard */
function buildTzKeyboard(prefix: string): ReturnType<typeof inlineKeyboard> {
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (let i = 0; i < TZ_OPTIONS.length; i += 3) {
    rows.push(
      TZ_OPTIONS.slice(i, i + 3).map((opt) =>
        inlineButton(opt.label, `${prefix}:${opt.offset}:${encodeURIComponent(opt.tz)}`),
      ),
    );
  }
  rows.push([inlineButton("⌨️ Enter offset manually", `${prefix}:manual`)]);
  return inlineKeyboard(rows);
}

// ── Team creation timezone picker ──────────────────────────────────────────

composer.callbackQuery(/^team:tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  // team:tz:(offset|manual)[:tzName]
  const val = parts[2];
  if (val === "manual") {
    ctx.session.step = "awaiting_team_timezone";
    await ctx.editMessageText(
      "Enter your UTC offset as a number, e.g. `-5`, `+0`, `+8`:",
      { parse_mode: "Markdown" },
    );
    return;
  }
  const offset = parseFloat(val);
  const tz = decodeURIComponent(parts.slice(3).join(":"));
  if (isNaN(offset)) return;
  (ctx.session as any).tempTimezoneOffset = offset;
  (ctx.session as any).tempTimezoneName = tz;
  await completeTeamCreation(ctx);
});

// Manual timezone input for team creation
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_team_timezone") return next();
  const raw = ctx.message.text.trim();
  const offset = parseFloat(raw.replace(/[^\-0-9.]/g, ""));
  if (isNaN(offset) || offset < -12 || offset > 14) {
    await ctx.reply("Enter a UTC offset between -12 and +14 (e.g. `-5`, `+3`, `+5.5`):", { parse_mode: "Markdown" });
    return;
  }
  (ctx.session as any).tempTimezoneOffset = offset;
  (ctx.session as any).tempTimezoneName = offset >= 0 ? `UTC+${offset}` : `UTC${offset}`;
  await completeTeamCreation(ctx);
  ctx.session.step = "idle";
});

async function completeTeamCreation(ctx: Ctx) {
  const promptHour = ctx.session.tempPromptHour as number;
  const cutoffHour = ctx.session.tempCutoffHour as number;
  const channelId = ctx.session.tempChannelId as number;
  const teamName = ctx.session.tempTeamName as string;
  const tzOffset = ((ctx.session as any).tempTimezoneOffset as number) ?? 0;
  const tzName = ((ctx.session as any).tempTimezoneName as string) ?? "UTC";

  const clock = getClock();
  const inviteCode = generateInviteCode();
  const teamId = inviteCode;

  const team: Team = {
    id: teamId,
    name: teamName,
    createdBy: ctx.from!.id,
    channelId,
    schedule: {
      promptHourUTC: promptHour,
      cutoffHourUTC: cutoffHour,
    },
    questions: [...DEFAULT_QUESTIONS],
    timezonePolicy: "member",
    inviteCode,
    memberIds: [ctx.from!.id],
    createdAt: clock.todayISO(),
    inviteCreatedAt: clock.timestamp(),
    previousInviteCodes: [],
  };

  await createTeam(team);

  await createMember({
    telegramId: ctx.from!.id,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ""),
    timezone: tzName,
    timezoneOffsetHours: tzOffset,
    teamId,
    joinedAt: clock.nowISO(),
  });

  // Clean up session
  ctx.session.step = "idle";
  delete ctx.session.tempTeamName;
  delete ctx.session.tempChannelId;
  delete ctx.session.tempPromptHour;
  delete ctx.session.tempCutoffHour;
  delete (ctx.session as any).tempTimezoneOffset;
  delete (ctx.session as any).tempTimezoneName;

  const botUsername = ctx.me.username;
  const link = `https://t.me/${botUsername}?start=${inviteCode}`;

  await ctx.reply(
    `✅ *${escapeMdV2(teamName)}* is ready!\n\n` +
      `• Prompts at ${promptHour}:00 UTC\n` +
      `• Cutoff at ${cutoffHour}:00 UTC\n` +
      `• Your timezone: ${tzName}\n` +
      `• 3 default questions \\(editable from Team Settings\\)\n\n` +
      `🔗 Share this invite link with your teammates:\n` +
      `\`${link}\`\n\n` +
      `Or tell them to use join code: \`${inviteCode}\``,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Team Settings", "team:settings")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
      parse_mode: "MarkdownV2",
    },
  );
}

function escapeMdV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export default composer;