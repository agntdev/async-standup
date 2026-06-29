import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "📜 View History", data: "history:recent", order: 30 });

const composer = new Composer<Ctx>();
composer.callbackQuery("history:recent", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Recent standups: none yet. Run your first standup to build history.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});
export default composer;
