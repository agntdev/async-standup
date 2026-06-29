import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";

registerMainMenuItem({ label: "➕ Create Team", data: "team:create", order: 10 });

const composer = new Composer<Ctx>();
composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Let's set up your team. What would you like to name it?", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});
export default composer;
