import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import {
  getMember,
  getTeam,
  getStandupRun,
  setParticipantResponse,
  updateStandupRun,
} from "../domain.js";
import {
  sendStandupPrompts,
  sendNudges,
  compileAndPostDigest,
} from "../standup-runner.js";
import { getClock } from "../clock.js";

registerMainMenuItem({ label: "📋 Today's Standup", data: "standup:today", order: 5 });

const composer = new Composer<Ctx>();

// ── Today's Standup menu ──────────────────────────────────────────────────

composer.callbackQuery("standup:today", async (ctx) => {
  await ctx.answerCallbackQuery();
  const member = await getMember(ctx.from!.id);
  if (!member) {
    await ctx.editMessageText(
      "You're not on a team yet. Join one to take part in standups.",
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

  const clock = getClock();
  const today = clock.todayISO();
  const run = await getStandupRun(team.id, today);

  let text: string;
  const rows: ReturnType<typeof inlineButton>[][] = [];

  if (!run) {
    text = `📋 **${team.name}** — no standup has started yet today.`;
    if (team.createdBy === ctx.from!.id) {
      rows.push([inlineButton("▶️ Start standup", `standup:trigger`)]);
    }
  } else {
    const participant = run.participants.find((p) => p.telegramId === ctx.from!.id);
    const responded = run.participants.filter((p) => p.status === "responded").length;
    const total = run.participants.length;

    text = `📋 **${team.name}** — ${today}\n` +
      `Progress: ${responded}/${total} answered\n`;

    if (participant) {
      if (participant.status === "responded") {
        text += `\n✅ You've submitted your answers.`;
      } else if (participant.status === "skipped") {
        text += `\n⏭️ You've skipped today.`;
      } else if (run.status === "open") {
        text += `\n⏳ You haven't answered yet.`;
        rows.push([inlineButton("✍️ Answer now", `standup:answer:${team.id}:${today}`)]);
        rows.push([inlineButton("⏭️ Skip", `standup:skip:${team.id}:${today}`)]);
      } else {
        text += `\nStandup is complete.`;
      }
    }

    if (team.createdBy === ctx.from!.id) {
      if (run.status === "open") {
        rows.push([inlineButton("🔔 Send nudges", `standup:nudge:${team.id}`)]);
        rows.push([inlineButton("📊 Compile digest", `standup:digest:${team.id}`)]);
      }
    }
  }

  rows.push([inlineButton("⬅️ Back to menu", "menu:main")]);

  await ctx.editMessageText(text, {
    reply_markup: inlineKeyboard(rows),
    parse_mode: "Markdown",
  });
});

// ── Admin: start standup ──────────────────────────────────────────────────

composer.callbackQuery("standup:trigger", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Starting standup…" });
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(member.teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    await ctx.editMessageText("Only the team admin can start the standup.");
    return;
  }

  await sendStandupPrompts(ctx.api, team.id);
  await ctx.editMessageText(
    `📋 Standup prompts sent to ${team.memberIds.length} member(s). Check \"Today's Standup\" to track progress.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 Today's Standup", "standup:today")],
        [inlineButton("⬅️ Main menu", "menu:main")],
      ]),
    },
  );
});

// ── Admin: send nudges ────────────────────────────────────────────────────

composer.callbackQuery(/^standup:nudge:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Sending nudges…" });
  const teamId = ctx.match[1];
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    await ctx.editMessageText("Only the team admin can send nudges.");
    return;
  }

  await sendNudges(ctx.api, teamId);
  await ctx.editMessageText("🔔 Sent reminder nudges to anyone who hasn't responded yet.");
});

// ── Answer flow — start ───────────────────────────────────────────────────

composer.callbackQuery(/^standup:answer:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const date = ctx.match[2];

  const run = await getStandupRun(teamId, date);
  if (!run) {
    await ctx.editMessageText("This standup run isn't active anymore.");
    return;
  }
  if (run.status === "completed") {
    await ctx.editMessageText("This standup has already finished — the digest has been posted.");
    return;
  }

  const team = await getTeam(teamId);
  if (!team) return;

  // Set up flow state on the session
  ctx.session.step = "standup_answering";
  ctx.session.tempRunDate = date;
  ctx.session.tempTeamId = teamId;
  ctx.session.tempAnswers = team.questions.map(() => "");
  ctx.session.tempQuestionIndex = 0;

  const firstQuestion = team.questions[0];
  if (!firstQuestion) return;

  await ctx.editMessageText(
    `Question 1 of ${team.questions.length}:\n\n${firstQuestion}\n\n_Type your answer…_`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip question", `standup:q:${teamId}:${date}:0:skip`)],
      ]),
    },
  );
});

// ── Skip the whole standup ────────────────────────────────────────────────

composer.callbackQuery(/^standup:skip:(.+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Skipped" });
  const teamId = ctx.match[1];
  const date = ctx.match[2];

  await setParticipantResponse(teamId, date, ctx.from!.id, []);

  await ctx.editMessageText("⏭️ Skipped today's standup. Catch you tomorrow!");
});

// ── Skip a single question ────────────────────────────────────────────────

composer.callbackQuery(/^standup:q:(.+):(.+):(\d+):skip$/, async (ctx) => {
  const teamId = ctx.match[1];
  const date = ctx.match[2];
  const qIndex = parseInt(ctx.match[3], 10);

  await ctx.answerCallbackQuery({ text: "Skipped" });

  const team = await getTeam(teamId);
  if (!team) return;

  const nextIndex = qIndex + 1;
  const answers = ctx.session.tempAnswers as string[];

  if (nextIndex >= team.questions.length) {
    // All questions done — submit
    await finishStandup(teamId, date, ctx, answers);
    return;
  }

  ctx.session.tempQuestionIndex = nextIndex;
  await ctx.editMessageText(
    `Question ${nextIndex + 1} of ${team.questions.length}:\n\n${team.questions[nextIndex]}\n\n_Type your answer…_`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip question", `standup:q:${teamId}:${date}:${nextIndex}:skip`)],
      ]),
    },
  );
});

// ── Handle text answers during standup flow ───────────────────────────────

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "standup_answering") return next();

  const date = ctx.session.tempRunDate as string | undefined;
  const teamId = ctx.session.tempTeamId as string | undefined;
  const qIndex = (ctx.session.tempQuestionIndex as number) ?? 0;
  let answers = ctx.session.tempAnswers as string[] | undefined;

  if (!date || !teamId || !answers) {
    ctx.session.step = "idle";
    return;
  }

  const answer = ctx.message.text.trim();
  answers[qIndex] = answer;
  ctx.session.tempAnswers = answers;

  const team = await getTeam(teamId);
  if (!team) {
    ctx.session.step = "idle";
    return;
  }

  const nextIndex = qIndex + 1;
  if (nextIndex >= team.questions.length) {
    await finishStandup(teamId, date, ctx, answers);
    return;
  }

  ctx.session.tempQuestionIndex = nextIndex;
  await ctx.reply(
    `Question ${nextIndex + 1} of ${team.questions.length}:\n\n${team.questions[nextIndex]}\n\n_Type your answer…_`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⏭️ Skip question", `standup:q:${teamId}:${date}:${nextIndex}:skip`)],
      ]),
    },
  );
});

// ── Admin: compile digest ─────────────────────────────────────────────────

composer.callbackQuery(/^standup:digest:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Compiling digest…" });
  const teamId = ctx.match[1];
  const member = await getMember(ctx.from!.id);
  if (!member) return;
  const team = await getTeam(teamId);
  if (!team || team.createdBy !== ctx.from!.id) {
    await ctx.editMessageText("Only the team admin can compile the digest.");
    return;
  }

  const success = await compileAndPostDigest(ctx.api, teamId);
  if (success) {
    await ctx.editMessageText(
      `📊 Digest compiled and posted to the team channel.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📜 View history", "history:recent")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  } else {
    await ctx.editMessageText(
      `⚠️ Digest compiled but I couldn't post to the channel. Is the bot an admin there?`,
      {
        reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
      },
    );
  }
});

// ── Helper: finish answering ──────────────────────────────────────────────

async function finishStandup(
  teamId: string,
  date: string,
  ctx: Ctx,
  answers: string[],
) {
  await setParticipantResponse(teamId, date, ctx.from!.id, answers);
  ctx.session.step = "idle";
  delete ctx.session.tempRunDate;
  delete ctx.session.tempTeamId;
  delete ctx.session.tempAnswers;
  delete ctx.session.tempQuestionIndex;

  await ctx.reply("✅ Standup submitted! Your responses will appear in today's digest.");
}

export default composer;
