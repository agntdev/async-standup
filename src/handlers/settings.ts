import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "⚙️ Team Settings", data: "team:settings", order: 15 });

const composer = new Composer<Ctx>();

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
  { label: "UTC+5", offset: 5, tz: "Asia/Karachi" },
  { label: "UTC+5:30 (India)", offset: 5.5, tz: "Asia/Kolkata" },
  { label: "UTC+7", offset: 7, tz: "Asia/Bangkok" },
  { label: "UTC+8 (China)", offset: 8, tz: "Asia/Shanghai" },
  { label: "UTC+9 (Japan)", offset: 9, tz: "Asia/Tokyo" },
  { label: "UTC+10", offset: 10, tz: "Australia/Sydney" },
  { label: "UTC+12", offset: 12, tz: "Pacific/Auckland" },
];

// ── Team settings menu ─────────────────────────────────────────────────────

composer.callbackQuery("team:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Look up member's team
  const { getMember, getTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) {
    await ctx.editMessageText(
      "You're not in a team yet — tap 🔗 Join Team to get started.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }
  const team = await getTeam(member.teamId);
  if (!team) {
    await ctx.editMessageText(
      "Your team couldn't be found. Try joining again.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const isAdmin = team.createdBy === ctx.from!.id;
  const members = await (await import("../domain.js")).getMembersByIds(team.memberIds);

  let text = `⚙️ **${team.name}**\n\n`;
  text += `Members: ${members.length}\n`;
  text += `Schedule: ${team.schedule.promptHourUTC}:00 UTC (prompt), ${team.schedule.cutoffHourUTC}:00 UTC (cutoff)\n`;
  text += `Timezone policy: ${team.timezonePolicy === "member" ? "per-member" : "team-wide"}\n`;
  text += `Questions: ${team.questions.length}\n`;
  text += `Join code: \`${team.inviteCode}\`\n`;

  const buttons: ReturnType<typeof inlineButton>[][] = [];

  if (isAdmin) {
    buttons.push([inlineButton("✏️ Edit schedule", "team:edit:schedule")]);
    buttons.push([inlineButton("📝 Edit questions", "team:edit:questions")]);
    buttons.push([inlineButton("🏷️ Rename team", "team:edit:name")]);
    buttons.push([inlineButton("📢 Change channel", "team:edit:channel")]);
    buttons.push([inlineButton("🌍 Timezone policy", "team:edit:policy")]);
    buttons.push([inlineButton("🔗 Manage invite", "team:invite")]);
    buttons.push([inlineButton("📊 View members", "team:members")]);
  }
  // Every member can edit their own timezone
  buttons.push([inlineButton("🕐 My timezone", "settings:my:timezone")]);
  buttons.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(buttons),
    parse_mode: "Markdown",
  });
});

// ── Edit schedule flow ────────────────────────────────────────────────────

composer.callbackQuery("team:edit:schedule", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_prompt_hour";
  await ctx.editMessageText(
    "What hour (UTC, 0-23) should standup prompts go out?",
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:settings")]]) },
  );
});

// Handle text during schedule editing
composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step as string | undefined;
  if (step === "awaiting_prompt_hour") {
    const hour = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      await ctx.reply("That doesn't look right — enter a number from 0 to 23.");
      return;
    }
    ctx.session.tempPromptHour = hour;
    ctx.session.step = "awaiting_cutoff_hour";
    await ctx.reply("Got it. What hour (UTC, 0-23) should the digest cutoff be?");
    return;
  }

  if (step === "awaiting_cutoff_hour") {
    const hour = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      await ctx.reply("That doesn't look right — enter a number from 0 to 23.");
      return;
    }
    const promptHour = ctx.session.tempPromptHour as number;
    // Validate: cutoff must be after prompt
    if (hour <= promptHour) {
      await ctx.reply(
        `The cutoff hour (${hour}:00 UTC) needs to be after the prompt hour (${promptHour}:00 UTC). Try again with a later hour (0–23):`,
      );
      return;
    }
    const { getMember, getTeam, updateTeam } = await import("../domain.js");
    const member = await getMember(ctx.from!.id);
    if (!member) return;
    const team = await getTeam(member.teamId);
    if (!team || team.createdBy !== ctx.from!.id) {
      await ctx.reply("Only the team admin can change the schedule.");
      ctx.session.step = "idle";
      return;
    }
    await updateTeam(team.id, {
      schedule: { promptHourUTC: promptHour, cutoffHourUTC: hour },
    });
    ctx.session.step = "idle";
    delete ctx.session.tempPromptHour;
    await ctx.reply(
      `✅ Schedule updated! Prompts at ${promptHour}:00 UTC, cutoff at ${hour}:00 UTC.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
    );
    return;
  }

  return next();
});

// ── Edit questions flow ────────────────────────────────────────────────────

composer.callbackQuery("team:edit:questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team) return;

  let text = "📝 **Current questions:**\n";
  team.questions.forEach((q, i) => {
    text += `${i + 1}. ${q}\n`;
  });
  text += "\nSend new questions, one per line. Example:\n_What did you do yesterday?\nWhat are you working on today?\nAny blockers?_";

  ctx.session.step = "awaiting_questions";
  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "team:settings")]]),
    parse_mode: "Markdown",
  });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_questions") return next();
  const lines = ctx.message.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    await ctx.reply("Send at least one question, or tap Cancel to go back.");
    return;
  }
  const { getMember, getTeam, updateTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    await ctx.reply("Only the team admin can change the questions.");
    ctx.session.step = "idle";
    return;
  }
  await updateTeam(team.id, { questions: lines });
  ctx.session.step = "idle";
  await ctx.reply(
    `✅ Questions updated! Now ${lines.length} question(s).`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
  );
});

// ── Rename team ───────────────────────────────────────────────────────────

composer.callbackQuery("team:edit:name", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  ctx.session.step = "awaiting_team_rename";
  await ctx.editMessageText(
    `Current name: ${team.name}\n\nSend a new name for your team:`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "team:settings")]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_team_rename") return next();
  const name = ctx.message.text.trim();
  if (name.length < 2 || name.length > 64) {
    await ctx.reply("Team name should be 2 to 64 characters. Try again.");
    return;
  }
  const { getMember, getTeam, updateTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    ctx.session.step = "idle";
    await ctx.reply("Only the team admin can rename the team.");
    return;
  }
  await updateTeam(team.id, { name });
  ctx.session.step = "idle";
  await ctx.reply(
    `✅ Team renamed to "${name}".`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
  );
});

// ── Change channel ────────────────────────────────────────────────────────

composer.callbackQuery("team:edit:channel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  ctx.session.step = "awaiting_channel_change";
  await ctx.editMessageText(
    `Current channel ID: ${team.channelId}\n\nSend a new channel ID, or forward a message from the channel:`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "team:settings")]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_channel_change") return next();
  const raw = ctx.message.text.trim();
  let channelId: number;
  const fwd = (ctx.message as unknown as { forward_from_chat?: { id: number } }).forward_from_chat;
  if (fwd) {
    channelId = fwd.id;
  } else {
    channelId = parseInt(raw.replace(/[^\-0-9]/g, ""), 10);
  }
  if (isNaN(channelId)) {
    await ctx.reply("Couldn't read that channel ID. Forward a message from the channel, or type the ID directly.");
    return;
  }
  const { getMember, getTeam, updateTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    ctx.session.step = "idle";
    await ctx.reply("Only the team admin can change the channel.");
    return;
  }
  await updateTeam(team.id, { channelId });
  ctx.session.step = "idle";
  await ctx.reply(
    `✅ Digest channel updated to ${channelId}. Make sure the bot is an admin there.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
  );
});

// ── Timezone policy toggle ────────────────────────────────────────────────

composer.callbackQuery("team:edit:policy", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam, updateTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  const newPolicy: "member" | "team" = team.timezonePolicy === "member" ? "team" : "member";
  await updateTeam(team.id, { timezonePolicy: newPolicy });

  const desc = newPolicy === "member"
    ? "each member at their local time"
    : "all members at the same UTC hour";

  // Re-render settings
  const t = await getTeam(team.id);
  if (!t) return;
  let text = `⚙️ **${t.name}**\n\n`;
  text += `Timezone policy: ${desc}\n\n`;
  text += `Tap again to switch back.`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("🌍 Toggle policy", "team:edit:policy")],
      [inlineButton("⬅️ Back to settings", "team:settings")],
    ]),
    parse_mode: "Markdown",
  });
});

// ── My timezone (per-member self-edit) ────────────────────────────────────

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
  rows.push([inlineButton("⬅️ Back to settings", "team:settings")]);
  return inlineKeyboard(rows);
}

composer.callbackQuery("settings:my:timezone", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;

  await ctx.editMessageText(
    `Your current timezone: ${member.timezone} (offset ${member.timezoneOffsetHours ?? 0}h)\n\nPick a new timezone:`,
    { reply_markup: buildTzKeyboard("settings:tz") },
  );
});

composer.callbackQuery(/^settings:tz:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split(":");
  const val = parts[2];
  if (val === "manual") {
    ctx.session.step = "awaiting_my_timezone";
    await ctx.editMessageText(
      "Enter your UTC offset as a number, e.g. `-5`, `+0`, `+8`:",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "settings:my:timezone")]]),
        parse_mode: "Markdown",
      },
    );
    return;
  }
  const offset = parseFloat(val);
  const tz = decodeURIComponent(parts.slice(3).join(":"));
  if (isNaN(offset)) return;
  const { setMemberTimezone } = await import("../domain.js");
  await setMemberTimezone(ctx.from!.id, tz, offset);
  await ctx.editMessageText(
    `✅ Timezone set to ${tz} (UTC${offset >= 0 ? "+" : ""}${offset}). Your standup prompts will now arrive at your local time.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_my_timezone") return next();
  const raw = ctx.message.text.trim();
  const offset = parseFloat(raw.replace(/[^\-0-9.]/g, ""));
  if (isNaN(offset) || offset < -12 || offset > 14) {
    await ctx.reply("Enter a UTC offset between -12 and +14 (e.g. `-5`, `+3`, `+5.5`):", { parse_mode: "Markdown" });
    return;
  }
  const tzLabel = offset >= 0 ? `UTC+${offset}` : `UTC${offset}`;
  const { setMemberTimezone } = await import("../domain.js");
  await setMemberTimezone(ctx.from!.id, tzLabel, offset);
  ctx.session.step = "idle";
  await ctx.reply(
    `✅ Timezone set to ${tzLabel}. Your standup prompts will arrive at your local time.`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]) },
  );
});

// ── Invite management ─────────────────────────────────────────────────────

composer.callbackQuery("team:invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  const link = `https://t.me/${ctx.me.username}?start=${team.inviteCode}`;

  await ctx.editMessageText(
    `🔗 Share this link with team members:\n\n\`${link}\`\n\nOr tell them to use join code: \`${team.inviteCode}\``,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔄 Generate new code", "team:invite:new")],
        [inlineButton("⬅️ Back to settings", "team:settings")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

composer.callbackQuery("team:invite:new", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Generating new code…" });
  const { getMember, getTeam, generateInviteCode, regenerateInviteCode } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  const newCode = generateInviteCode();
  // Use regenerateInviteCode which properly re-keys the team record
  await regenerateInviteCode(team.id, newCode, true);

  const link = `https://t.me/${ctx.me.username}?start=${newCode}`;
  await ctx.editMessageText(
    `🔗 New invite link:\n\n\`${link}\`\n\nJoin code: \`${newCode}\`\n\n_Note: the old code still works for 7 days._`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔄 Generate new code", "team:invite:new")],
        [inlineButton("⬅️ Back to settings", "team:settings")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

// ── View members ───────────────────────────────────────────────────────────

composer.callbackQuery("team:members", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam, getMembersByIds } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team) return;

  const members = await getMembersByIds(team.memberIds);
  let text = `👥 **${team.name} — Members**\n\n`;
  for (const m of members) {
    const badge = m.telegramId === team.createdBy ? " 👑" : "";
    text += `• ${m.displayName}${badge} (${m.timezone || "no tz"})\n`;
  }
  if (members.length === 0) {
    text += "_No members yet. Share the invite link to add people._\n";
  }

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to settings", "team:settings")]]),
    parse_mode: "Markdown",
  });
});

export default composer;