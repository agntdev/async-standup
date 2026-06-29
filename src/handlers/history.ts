import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
  paginate,
} from "../toolkit/index.js";
import { getMember, getRecentDigests, getDigest, getStandupRun, type Digest, type StandupRun } from "../domain.js";

registerMainMenuItem({ label: "📜 View History", data: "history:recent", order: 30 });

const composer = new Composer<Ctx>();
const PER_PAGE = 5;

// ── Show recent history with filters ──────────────────────────────────────

composer.callbackQuery("history:recent", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showHistory(ctx, 0);
});

// ── Pagination ─────────────────────────────────────────────────────────────

composer.callbackQuery(/^history:page:(next|prev):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[2], 10);
  await showHistory(ctx, page);
});

// ── Filter by date: show detailed per-user responses ───────────────────────

composer.callbackQuery("history:filter:date", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_history_date";
  await ctx.editMessageText(
    "Send the date you'd like to see (YYYY-MM-DD), e.g. 2026-06-15.",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⬅️ Back to history", "history:recent")],
      ]),
    },
  );
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_history_date") return next();
  const date = ctx.message.text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await ctx.reply("Use the format YYYY-MM-DD, like 2026-06-15.");
    return;
  }
  ctx.session.step = "idle";
  await showSingleDayHistory(ctx, date);
});

// ── Filter: show blockers only ────────────────────────────────────────────

composer.callbackQuery("history:filter:blockers", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.historyFilter = "blockers";
  await showHistory(ctx, 0);
});

composer.callbackQuery("history:filter:all", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.historyFilter = undefined;
  delete ctx.session.historyFilter;
  await showHistory(ctx, 0);
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function showHistory(ctx: Ctx, page: number) {
  const member = await getMember(ctx.from!.id);
  if (!member) {
    await ctx.editMessageText(
      "You're not on a team yet — join one to see standup history.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const filter = ctx.session.historyFilter as string | undefined;
  let digests = await getRecentDigests(member.teamId, 90);

  if (filter === "blockers") {
    digests = digests.filter((d) => d.blockers.length > 0);
  }

  if (digests.length === 0) {
    const filterText = filter === "blockers" ? "with blockers " : "";
    await ctx.editMessageText(
      `No standup history ${filterText}yet. Run your first standup, then come back here.`,
      { reply_markup: buildHistoryKeyboard(filter, 0, 0, []) },
    );
    return;
  }

  const { pageItems, totalPages, controls, page: clampedPage } = paginate(digests, { page, perPage: PER_PAGE, callbackPrefix: "history" });

  let text = `📜 **Standup History**\n`;
  if (filter === "blockers") text += `_Showing digests with blockers_\n`;
  text += `\n`;

  for (const d of pageItems) {
    text += `📅 ${d.runDate} — ${d.responseCount}/${d.totalMembers} responded`;
    if (d.skippedUsers && d.skippedUsers.length > 0) {
      text += `, ${d.skippedUsers.length} skipped`;
    }
    if (d.blockers.length > 0) text += ` 🚨`;
    text += `\n`;
  }

  if (pageItems.length === 0) {
    text += `\n_No digests on this page._\n`;
  }

  const rows = [...controls.inline_keyboard];
  // Add filter + refresh row
  rows.push(
    filter === "blockers"
      ? [inlineButton("📋 Show all", "history:filter:all")]
      : [inlineButton("🚨 Blockers only", "history:filter:blockers")],
  );
  rows.push([inlineButton("🔍 Search by date", "history:filter:date")]);
  rows.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
}

function buildHistoryKeyboard(
  filter: string | undefined,
  _page: number,
  _totalPages: number,
  _items: Digest[],
) {
  const rows: ReturnType<typeof inlineButton>[][] = [];
  if (filter === "blockers") {
    rows.push([inlineButton("📋 Show all", "history:filter:all")]);
  }
  rows.push([inlineButton("🔍 Search by date", "history:filter:date")]);
  rows.push([inlineButton("⬅️ Back to menu", "menu:main")]);
  return inlineKeyboard(rows);
}

async function showSingleDayHistory(ctx: Ctx, date: string) {
  const member = await getMember(ctx.from!.id);
  if (!member) return;

  // Try the digest first (compiled summary)
  const digest = await getDigest(member.teamId, date);

  if (digest) {
    // Show the digest summary — followed by per-user response details
    let text = digest.summary + `\n\n`;

    // Add per-user response details
    if (digest.responses && digest.responses.length > 0) {
      text += `**Individual responses:**\n`;
      for (const r of digest.responses) {
        const statusLabel = r.status === "skipped" ? " ⏭️" : "";
        text += `\n👤 ${r.displayName}${statusLabel}:\n`;
        if (r.status === "responded" && r.answers.some((a) => a?.trim())) {
          for (let i = 0; i < r.answers.length; i++) {
            const a = r.answers[i]?.trim();
            if (a) text += `  • ${a}\n`;
          }
        } else if (r.status === "skipped") {
          text += `  _Skipped today_\n`;
        }
      }
    }

    await ctx.reply(
      text,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📜 Back to history", "history:recent")],
          [inlineButton("⬅️ Main menu", "menu:main")],
        ]),
        parse_mode: "Markdown",
      },
    );
    return;
  }

  // No digest yet — try the raw standup run for in-progress or
  // not-yet-compiled data
  const run = await getStandupRun(member.teamId, date);
  if (run) {
    let text = `📋 **Standup — ${date}** (${run.status})\n\n`;
    for (const p of run.participants) {
      const statusLabel = p.status === "responded" ? "✅" : p.status === "skipped" ? "⏭️" : "⏳";
      text += `${statusLabel} User ${p.telegramId}: ${p.status}\n`;
    }
    await ctx.reply(
      text,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📜 Back to history", "history:recent")],
          [inlineButton("⬅️ Main menu", "menu:main")],
        ]),
        parse_mode: "Markdown",
      },
    );
    return;
  }

  await ctx.reply(
    `No standup found for ${date}.`,
    { reply_markup: inlineKeyboard([
      [inlineButton("📜 Back to history", "history:recent")],
      [inlineButton("⬅️ Main menu", "menu:main")],
    ]) },
  );
}

export default composer;