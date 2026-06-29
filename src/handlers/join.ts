import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { resolveTeamByInvite } from "../invite-helpers.js";
import { getMemberTeamId, getTeam } from "./team.js";
import { handleJoin } from "./start.js";

registerMainMenuItem({ label: "🔗 Join Team", data: "join:link", order: 20 });

const composer = new Composer<Ctx>();

// ── Join via button (manual code entry) ────────────────────────────────

composer.callbackQuery("join:link", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "join:enter_code";
  await ctx.editMessageText(
    "Got an invite code from your team admin? Send it here — it looks like ABCD-EFGH.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
    },
  );
});

// Handle typed invite code
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "join:enter_code") return next();
  const code = ctx.message.text.trim().replace(/\s/g, "");
  if (!code) return next();
  await handleJoin(ctx, code);
});

export default composer;
