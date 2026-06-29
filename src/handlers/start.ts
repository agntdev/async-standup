import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { resolveTeamByInvite } from "../invite-helpers.js";
import { getTeam, getMemberTeamId, saveMember, getTeamMembers } from "./team.js";
import type { MemberData } from "./team.js";
import { now } from "../clock.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Welcome! Tap a button below to get started.";

composer.command("start", async (ctx, next) => {
  const payload = (ctx.match?.trim() ?? "").toString();

  // Handle deep-link join invite: /start join_<code>
  if (payload.startsWith("join_")) {
    const code = payload.slice("join_".length);
    await handleJoin(ctx, code);
    return;
  }

  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

// ── Join via deep link (also used from join.ts for manual code entry) ──

export async function handleJoin(ctx: Ctx, code: string): Promise<void> {
  const team = await resolveTeamByInvite(code);
  if (!team) {
    ctx.session.step = "";
    await ctx.reply(
      "Couldn't find a team with that invite code — double-check the code and try again. Codes are case-sensitive.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const userId = ctx.from!.id;
  const existingTeamId = await getMemberTeamId(userId);

  if (existingTeamId) {
    if (existingTeamId === team.id) {
      ctx.session.step = "";
      await ctx.reply(
        `You're already a member of "${team.name}" — no need to join again.`,
        { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
      );
      return;
    }
  }

  const member: MemberData = {
    telegramId: userId,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : ""),
    teamId: team.id,
    timezone: team.timezone,
    joinedAt: now().toISOString(),
  };

  await saveMemberDedup(member);

  ctx.session.step = "";
  ctx.session.joinCode = undefined;

  const totalMembers = await getMemberCount(team.id);

  await ctx.reply(
    `👋 Welcome to "${team.name}"!\n\n` +
    `You're member #${totalMembers}. You'll get daily standup prompts at ${team.scheduleTime} in your local timezone.\n\n` +
    `Here's what to expect:\n` +
    `• A DM with ${team.questionSet.length} question(s) each weekday\n` +
    `• A nudge if you haven't responded after 30 minutes\n` +
    `• A digest of the team's responses posted to the team channel`,
    { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
  );
}

// Save a member, removing any previous entry first (dedup by userId).
import { getKV } from "../store.js";

async function saveMemberDedup(member: MemberData): Promise<void> {
  const kv = getKV();
  const memberListKey = `team:${member.teamId}:members`;
  // Remove existing entry for this user from the index list
  await kv.lrem(memberListKey, 0, String(member.telegramId));
  // Save the member record
  await kv.set(`member:${member.telegramId}`, JSON.stringify(member));
  await kv.hset(`member:${member.telegramId}:team`, "teamId", member.teamId);
  // Push to team's member list
  await kv.lpush(memberListKey, String(member.telegramId));
}

async function getMemberCount(teamId: string): Promise<number> {
  const kv = getKV();
  return kv.llen(`team:${teamId}:members`);
}

export default composer;
