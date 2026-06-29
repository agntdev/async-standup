import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import {
  getTeam,
  getMember,
  createMember,
  addMemberToTeam,
} from "../domain.js";

registerMainMenuItem({ label: "🔗 Join Team", data: "join:link", order: 20 });

const composer = new Composer<Ctx>();

// ── Join via deep link ────────────────────────────────────────────────────

// Telegram deep link: https://t.me/<bot>?start=<code>
// grammY exposes this as ctx.match in a command handler with the "start" filter.

composer.command("start", async (ctx, next) => {
  const payload = ctx.match;
  if (!payload || typeof payload !== "string" || payload.trim().length < 1) {
    return next(); // plain /start → main menu
  }

  const code = payload.trim();

  // Check if already on a team
  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    await ctx.reply(
      `You're already on team "${existingMember.teamId}". Use the main menu to get around.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Look up team by invite code
  const team = await getTeam(code);
  if (!team) {
    await ctx.reply(
      "That invite code doesn't match any team. Check with your team admin for the right link, or create your own team.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Join the team
  await createMember({
    telegramId: ctx.from!.id,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ""),
    timezone: "UTC",
    teamId: team.id,
    joinedAt: new Date().toISOString(),
  });
  await addMemberToTeam(team.id, ctx.from!.id);

  await ctx.reply(
    `🎉 Welcome to **${team.name}**! You're all set — I'll send you standup prompts at your local time.`,
    { reply_markup: inlineKeyboard([
      [inlineButton("⚙️ Team Settings", "team:settings")],
      [inlineButton("⬅️ Main menu", "menu:main")],
    ]),
    parse_mode: "Markdown",
    },
  );
});

// ── Join via button (manual code entry) ───────────────────────────────────

composer.callbackQuery("join:link", async (ctx) => {
  await ctx.answerCallbackQuery();

  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    const team = await getTeam(existingMember.teamId);
    await ctx.editMessageText(
      `You're already on team "${team?.name ?? existingMember.teamId}". Use the main menu for other options.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
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

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_join_code") return next();

  // Check if already on a team
  const existingMember = await getMember(ctx.from!.id);
  if (existingMember) {
    ctx.session.step = "idle";
    await ctx.reply("You're already on a team.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Main menu", "menu:main")]]),
    });
    return;
  }

  // Extract code from the message (handle full links like t.me/bot?start=CODE)
  let code = ctx.message.text.trim();
  const linkMatch = code.match(/[?&]start=([A-Za-z0-9_-]+)/);
  if (linkMatch) {
    code = linkMatch[1];
  }
  code = code.slice(0, 32); // safety cap

  if (code.length < 4) {
    await ctx.reply(
      "That doesn't look like a valid code. It should be around 8 characters — check with your team admin.",
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
    ctx.session.step = "idle";
    return;
  }

  const team = await getTeam(code);
  if (!team) {
    await ctx.reply(
      `No team found with code "${code}". Check the spelling and try again, or ask your admin for the right link.`,
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
    return;
  }

  // Join
  await createMember({
    telegramId: ctx.from!.id,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ""),
    timezone: "UTC",
    teamId: team.id,
    joinedAt: new Date().toISOString(),
  });
  await addMemberToTeam(team.id, ctx.from!.id);

  ctx.session.step = "idle";
  await ctx.reply(
    `🎉 Welcome to **${team.name}**! You're all set. I'll send you standup prompts at your local time.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Team Settings", "team:settings")],
        [inlineButton("⬅️ Main menu", "menu:main")],
      ]),
      parse_mode: "Markdown",
    },
  );
});

export default composer;
