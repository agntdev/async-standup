/**
 * Schedule handler — manages the cron-like scheduling of standup runs.
 *
 * This handler provides admin controls to set up the automatic schedule
 * and exposes a simple manual trigger. The actual cron polling is done
 * by the polling loop in index.ts.
 */

import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { getMember, getTeam } from "../domain.js";
import { getClock } from "../clock.js";

registerMainMenuItem({ label: "⏰ Schedule", data: "schedule:view", order: 25 });

const composer = new Composer<Ctx>();

composer.callbackQuery("schedule:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  const member = await getMember(ctx.from!.id);
  if (!member) {
    await ctx.editMessageText(
      "You're not on a team yet.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }
  const team = await getTeam(member.teamId);
  if (!team) return;

  const clock = getClock();
  const now = clock.nowISO();

  const text =
    `⏰ **${team.name} — Schedule**\n\n` +
    `Prompt: ${team.schedule.promptHourUTC}:00 UTC\n` +
    `Cutoff: ${team.schedule.cutoffHourUTC}:00 UTC\n` +
    `Policy: ${team.timezonePolicy === "member" ? "per-member timezone" : "team-wide UTC"}\n\n` +
    `_Current time: ${now}_`;

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard([
      [inlineButton("📋 Today's Standup", "standup:today")],
      [inlineButton("⚙️ Team Settings", "team:settings")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
    parse_mode: "Markdown",
  });
});

export default composer;
