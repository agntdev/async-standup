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

registerMainMenuItem({ label: "➕ Create Team", data: "team:create", order: 10 });

const composer = new Composer<Ctx>();

const DEFAULT_QUESTIONS = [
  "What did you accomplish yesterday?",
  "What are you working on today?",
  "Any blockers or impediments?",
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
      step !== "awaiting_team_cutoff_hour") {
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
  await completeTeamCreation(ctx, parseInt(val, 10));
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
    await completeTeamCreation(ctx, hour);
    return;
  }

  return next();
});

// ── Completion ─────────────────────────────────────────────────────────────

async function completeTeamCreation(ctx: Ctx, cutoffHour: number) {
  const promptHour = ctx.session.tempPromptHour as number;
  const channelId = ctx.session.tempChannelId as number;
  const teamName = ctx.session.tempTeamName as string;

  const inviteCode = generateInviteCode();
  const teamId = inviteCode; // Use the invite code as the team's short ID

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
    createdAt: new Date().toISOString().split("T")[0],
  };

  await createTeam(team);

  // Add the creator as a member
  await createMember({
    telegramId: ctx.from!.id,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ""),
    timezone: "UTC",
    teamId,
    joinedAt: new Date().toISOString(),
  });

  // Clean up session
  ctx.session.step = "idle";
  delete ctx.session.tempTeamName;
  delete ctx.session.tempChannelId;
  delete ctx.session.tempPromptHour;
  delete ctx.session.tempCutoffHour;

  const botUsername = ctx.me.username;
  const link = `https://t.me/${botUsername}?start=${inviteCode}`;

  await ctx.reply(
    `✅ **${teamName}** is ready!\n\n` +
      `• Prompts at ${promptHour}:00 UTC\n` +
      `• Cutoff at ${cutoffHour}:00 UTC\n` +
      `• 3 default questions (editable from Team Settings)\n\n` +
      `🔗 Share this invite link with your teammates:\n` +
      `\`${link}\`\n\n` +
      `Or tell them to use join code: \`${inviteCode}\``,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Team Settings", "team:settings")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
      parse_mode: "Markdown",
    },
  );
}

export default composer;
