import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "⚙️ Team Settings", data: "team:settings", order: 15 });

const composer = new Composer<Ctx>();

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
    buttons.push([inlineButton("🔗 Manage invite", "team:invite")]);
    buttons.push([inlineButton("📊 View members", "team:members")]);
  }
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

// ── Invite management ─────────────────────────────────────────────────────

composer.callbackQuery("team:invite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { getMember, getTeam, generateInviteCode, updateTeam } = await import("../domain.js");
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
  const { getMember, getTeam, generateInviteCode, updateTeam } = await import("../domain.js");
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) return;

  const newCode = generateInviteCode();
  await updateTeam(team.id, { inviteCode: newCode });

  const link = `https://t.me/${ctx.me.username}?start=${newCode}`;
  await ctx.editMessageText(
    `🔗 New invite link:\n\n\`${link}\`\n\nJoin code: \`${newCode}\``,
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
