import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "🔗 Join Team", data: "join:link", order: 20 });

const composer = new Composer<Ctx>();
composer.callbackQuery("join:link", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Paste your invite link or code to join a team.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});
export default composer;
