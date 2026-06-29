import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import type { InlineButton } from "../toolkit/index.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  paginate,
} from "../toolkit/index.js";
import { now, formatDate } from "../clock.js";
import {
  getMemberTeamId,
  getTeam,
  getDigest,
  getTeamRunDates,
  type DigestData,
} from "./team.js";

registerMainMenuItem({ label: "📜 View History", data: "history:recent", order: 30 });

const composer = new Composer<Ctx>();

const HISTORY_PER_PAGE = 5;

// ── Show recent standup history ─────────────────────────────────────────

composer.callbackQuery("history:recent", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showHistoryPage(ctx, 0);
});

// Pagination
composer.callbackQuery(/^history:page:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = Number(ctx.match[1]);
  await showHistoryPage(ctx, page);
});

// Filter to a specific team (if member of multiple — not supported yet, but wiring ready)
composer.callbackQuery(/^history:team:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showHistoryPage(ctx, 0);
});

async function showHistoryPage(ctx: Ctx, page: number): Promise<void> {
  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);

  if (!teamId) {
    await ctx.editMessageText(
      "You're not in a team yet. Join one to see standup history.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const team = await getTeam(teamId);
  if (!team) {
    await ctx.editMessageText(
      "Your team wasn't found. It may have been deleted.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const dates = await getTeamRunDates(teamId, 30);
  if (dates.length === 0) {
    await ctx.editMessageText(
      `📜 No standup history yet for "${team.name}".\n\nDaily standups will start appearing here once the first run completes.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  // Load digest summaries for paginated view
  const digests: (DigestData | null)[] = [];
  for (const d of dates) {
    digests.push(await getDigest(teamId, d));
  }

  const items = digests.filter(Boolean) as DigestData[];
  const { pageItems, controls, totalPages, page: actualPage } = paginate(items, {
    page,
    perPage: HISTORY_PER_PAGE,
    callbackPrefix: "history:page",
  });

  if (pageItems.length === 0) {
    await ctx.editMessageText(
      `📜 Standup history for "${team.name}" (page ${actualPage + 1} of ${totalPages})\n\nNo digests on this page — something went wrong.`,
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const lines: string[] = [
    `📜 Standup history for *${team.name}* (page ${actualPage + 1} of ${totalPages})`,
    "",
  ];

  for (const d of pageItems) {
    const responded = d.responses.filter((r) => !r.skipped).length;
    const total = d.responses.length + d.pendingUsers.length;
    const blockerCount = d.blockers.length;
    const statusIcon = d.blockers.length > 0 ? "🟡" : "✅";

    lines.push(
      `${statusIcon} *${d.runDate}* — ${responded}/${total} responded` +
      (blockerCount > 0 ? ` (${blockerCount} blocker${blockerCount > 1 ? "s" : ""})` : ""),
    );
  }

  const buttons: InlineButton[] = [];

  // Add "View detail" buttons for each digest on this page
  buttons.push(inlineButton("📋 Latest digest", `history:detail:${pageItems[0]!.runDate}`));

  // Combine controls with nav
  const navRow = controls.inline_keyboard.flat();
  const rows: InlineButton[][] = [
    buttons,
    navRow,
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ];

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "MarkdownV2",
  });
}

// ── Digest detail view ──────────────────────────────────────────────────

composer.callbackQuery(/^history:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const date = ctx.match[1]!;
  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);
  if (!teamId) return;

  const digest = await getDigest(teamId, date);
  if (!digest) {
    await ctx.editMessageText(
      `No digest found for ${date}. It may not have run yet.`,
      { reply_markup: inlineKeyboard([[inlineButton("📜 Back to history", "history:recent")]]) },
    );
    return;
  }

  const lines: string[] = [
    `📋 *Standup Digest — ${digest.runDate}*`,
    "",
  ];

  if (digest.responses.length > 0) {
    lines.push("*Responses:*");
    for (const r of digest.responses) {
      lines.push(`*${r.displayName}* ${r.skipped ? "(⏭ Skipped)" : ""}`);
      if (!r.skipped && r.answers) {
        for (let i = 0; i < Object.keys(r.answers).length; i++) {
          const ans = r.answers[i];
          if (ans) lines.push(`  _${ans.slice(0, 120)}${ans.length > 120 ? "…" : ""}_`);
        }
      }
      if (r.hasBlocker) {
        const blockerAnswer = r.answers[Object.keys(r.answers).length - 1];
        if (blockerAnswer) lines.push(`  🚧 Blocker: ${blockerAnswer.slice(0, 120)}`);
      }
    }
    lines.push("");
  }

  if (digest.blockers.length > 0) {
    lines.push("*🚧 Blockers flagged:*");
    for (const b of digest.blockers) {
      lines.push(`• ${b.displayName}: ${b.blocker.slice(0, 150)}`);
    }
    lines.push("");
  }

  if (digest.pendingUsers.length > 0) {
    lines.push("*⏳ Didn't respond:*");
    lines.push(digest.pendingUsers.map((p) => `• ${p.displayName}`).join("\n"));
    lines.push("");
  }

  lines.push(`_Posted: ${digest.postedAt.slice(0, 16).replace("T", " at ")}_`);

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard([[inlineButton("📜 Back to history", "history:recent")]]),
    parse_mode: "MarkdownV2",
  });
});

export default composer;