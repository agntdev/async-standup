import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getKV } from "../store.js";
import { now, formatDate, timeToday } from "../clock.js";
import { generateInviteCode, registerInviteCode } from "../invite-helpers.js";
import { registerTeamSchedule } from "./standup.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

registerMainMenuItem({ label: "➕ Create Team", data: "team:create", order: 10 });
registerMainMenuItem({ label: "⚙️ Manage Team", data: "team:manage", order: 15 });

// ── Team data types ────────────────────────────────────────────────────

export interface TeamData {
  id: string;
  name: string;
  channelId: string;
  scheduleTime: string;    // HH:MM
  scheduleDays: string[];  // ["mon","tue",…]
  timezone: string;        // IANA tz of the team
  questionSet: string[];   // default questions
  inviteCode: string;
  createdAt: string;       // ISO date
}

export interface MemberData {
  telegramId: number;
  displayName: string;
  teamId: string;
  timezone: string;       // IANA tz
  joinedAt: string;       // ISO date
}

export interface StandupRunData {
  runId: string;           // teamId:YYYY-MM-DD
  teamId: string;
  runDate: string;         // YYYY-MM-DD
  status: "prompting" | "collecting" | "digested";
  responses: ResponseData[];
  pendingUserIds: number[];
  promptMessages: Record<number, number>;  // userId → msgId
}

export interface ResponseData {
  userId: number;
  displayName: string;
  answers: Record<number, string>;  // qIndex → answer
  hasBlocker: boolean;
  submittedAt: string;              // ISO
  skipped: boolean;
}

export interface DigestData {
  digestId: string;        // teamId:YYYY-MM-DD
  teamId: string;
  runDate: string;
  messageId?: number;      // channel message id
  responses: ResponseData[];
  blockers: { userId: number; displayName: string; blocker: string }[];
  pendingUsers: { userId: number; displayName: string }[];
  postedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const KEY_TEAM_PREFIX = "team:";
const KEY_MEMBER_PREFIX = "member:";
const KEY_TEAM_MEMBERS = (teamId: string) => `team:${teamId}:members`;
const KEY_MEMBER_TEAM = (userId: number) => `member:${userId}:team`;
const KEY_RUN_PREFIX = "run:";
const KEY_RUNS = (teamId: string) => `team:${teamId}:runs`;
const KEY_DIGEST_PREFIX = "digest:";

export function teamKey(teamId: string): string {
  return KEY_TEAM_PREFIX + teamId;
}

export function memberKey(userId: number): string {
  return KEY_MEMBER_PREFIX + String(userId);
}

export function runKey(teamId: string, date: string): string {
  return KEY_RUN_PREFIX + teamId + ":" + date;
}

export function digestKey(teamId: string, date: string): string {
  return KEY_DIGEST_PREFIX + teamId + ":" + date;
}

export async function getTeam(teamId: string): Promise<TeamData | null> {
  const kv = getKV();
  const raw = await kv.get(teamKey(teamId));
  if (!raw) return null;
  return JSON.parse(raw) as TeamData;
}

export async function getMember(userId: number): Promise<MemberData | null> {
  const kv = getKV();
  const raw = await kv.get(memberKey(userId));
  if (!raw) return null;
  return JSON.parse(raw) as MemberData;
}

export async function getMemberTeamId(userId: number): Promise<string | null> {
  const kv = getKV();
  return kv.hget(KEY_MEMBER_TEAM(userId), "teamId");
}

export async function getTeamMemberIds(teamId: string): Promise<number[]> {
  const kv = getKV();
  const ids = await kv.lrange(KEY_TEAM_MEMBERS(teamId), 0, -1);
  return ids.map(Number);
}

export async function getTeamMembers(teamId: string): Promise<MemberData[]> {
  const ids = await getTeamMemberIds(teamId);
  const members: MemberData[] = [];
  for (const id of ids) {
    const m = await getMember(id);
    if (m) members.push(m);
  }
  return members;
}

export async function saveTeam(team: TeamData): Promise<void> {
  const kv = getKV();
  await kv.set(teamKey(team.id), JSON.stringify(team));
}

export async function saveMember(member: MemberData): Promise<void> {
  const kv = getKV();
  const memberListKey = KEY_TEAM_MEMBERS(member.teamId);
  // Remove any previous entry for this user in the team's member list
  await kv.lrem(memberListKey, 0, String(member.telegramId));
  // Save member record
  await kv.set(memberKey(member.telegramId), JSON.stringify(member));
  await kv.hset(KEY_MEMBER_TEAM(member.telegramId), "teamId", member.teamId);
  // Add to team's member list
  await kv.lpush(memberListKey, String(member.telegramId));
}

export async function saveRun(run: StandupRunData): Promise<void> {
  const kv = getKV();
  await kv.set(runKey(run.teamId, run.runDate), JSON.stringify(run));
}

export async function getRun(teamId: string, date: string): Promise<StandupRunData | null> {
  const kv = getKV();
  const raw = await kv.get(runKey(teamId, date));
  if (!raw) return null;
  return JSON.parse(raw) as StandupRunData;
}

export async function saveDigest(digest: DigestData): Promise<void> {
  const kv = getKV();
  await kv.set(digestKey(digest.teamId, digest.runDate), JSON.stringify(digest));
}

export async function getDigest(teamId: string, date: string): Promise<DigestData | null> {
  const kv = getKV();
  const raw = await kv.get(digestKey(teamId, date));
  if (!raw) return null;
  return JSON.parse(raw) as DigestData;
}

export async function getTeamRunDates(teamId: string, limit = 30): Promise<string[]> {
  const kv = getKV();
  return kv.lrange(KEY_RUNS(teamId), 0, limit - 1);
}

export async function addRunDate(teamId: string, date: string): Promise<void> {
  const kv = getKV();
  await kv.lpush(KEY_RUNS(teamId), date);
}

// ── Default questions ───────────────────────────────────────────────────

const DEFAULT_QUESTIONS = [
  "What did you work on yesterday?",
  "What are you focusing on today?",
  "Any blockers or challenges?",
];

// ── Composer ────────────────────────────────────────────────────────────

const composer = new Composer<Ctx>();

// ── Create Team — multi-step wizard ─────────────────────────────────────

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "team:name";
  ctx.session.teamName = undefined;
  ctx.session.teamSchedule = undefined;
  ctx.session.teamQuestions = undefined;
  ctx.session.teamChannelId = undefined;
  ctx.session.teamInviteCode = undefined;

  await ctx.editMessageText(
    "Let's set up your team! First, what would you like to name it?\n\nJust type the name below.",
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "menu:main")]]),
    },
  );
});

// Handle text input for team creation flow
composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step || !step.startsWith("team:")) return next();

  const text = ctx.message.text.trim();

  switch (step) {
    case "team:name": {
      if (text.length < 2 || text.length > 100) {
        await ctx.reply(
          "Team name should be 2–100 characters — try something shorter or more descriptive.",
          { reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "menu:main")]]) },
        );
        return;
      }
      ctx.session.teamName = text;
      ctx.session.step = "team:schedule";
      await ctx.reply(
        `Great, "${text}" it is!\n\nWhat time should daily standups go out? Send it in HH:MM format (24-hour), for example "09:00". Standup prompts go to each member at their local time.`,
        {
          reply_markup: { force_reply: true, input_field_placeholder: "09:00" },
        },
      );
      return;
    }

    case "team:schedule": {
      const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
      if (!match) {
        await ctx.reply(
          "Hmm, that doesn't look like a valid time. Please send it in HH:MM format (24-hour), like 09:00 or 14:30.",
          { reply_markup: { force_reply: true, input_field_placeholder: "09:00" } },
        );
        return;
      }
      ctx.session.teamSchedule = text;
      ctx.session.step = "team:timezone";
      await ctx.reply(
        `Standups will go out at ${text} local time for each member.\n\nWhat timezone are YOU in? Send it as an IANA timezone like "America/New_York", "Europe/London", or "Asia/Tokyo".`,
        {
          reply_markup: { force_reply: true, input_field_placeholder: "America/New_York" },
        },
      );
      return;
    }

    case "team:timezone": {
      const validTz = isValidTimezone(text);
      if (!validTz) {
        await ctx.reply(
          "That doesn't look like a recognised timezone. Try one like \"America/New_York\", \"Europe/London\", or \"Asia/Tokyo\".",
          { reply_markup: { force_reply: true, input_field_placeholder: "America/New_York" } },
        );
        return;
      }
      ctx.session.teamTimezone = text;
      ctx.session.step = "team:questions";
      ctx.session.teamQuestions = [...DEFAULT_QUESTIONS];
      await ctx.reply(
        `Here are the default standup questions:\n\n${DEFAULT_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nWant to customise these? Send your questions separated by new lines (or tap Skip to use the defaults).`,
        {
          reply_markup: inlineKeyboard([
            [inlineButton("⏭ Skip — use defaults", "team:use_defaults")],
            [inlineButton("⬅️ Cancel", "menu:main")],
          ]),
        },
      );
      return;
    }

    case "team:questions": {
      const questions = text
        .split("\n")
        .map((q) => q.replace(/^\d+[.)]\s*/, "").trim())
        .filter((q) => q.length > 0);
      if (questions.length < 1 || questions.length > 10) {
        await ctx.reply(
          "Please send 1–10 questions, one per line.",
          { reply_markup: inlineKeyboard([[inlineButton("⏭ Use defaults", "team:use_defaults")]]) },
        );
        return;
      }
      ctx.session.teamQuestions = questions;
      ctx.session.step = "team:channel";
      await ctx.reply(
        `Got it — ${questions.length} custom question(s).\n\nOne last thing: send me the Telegram channel ID where daily digests should be posted. The bot must be added as an admin to that channel.\n\nExample: -1001234567890`,
        {
          reply_markup: { force_reply: true, input_field_placeholder: "-1001234567890" },
        },
      );
      return;
    }

    case "team:channel": {
      const channelId = text.replace(/\s/g, "");
      if (!/^-?\d+$/.test(channelId)) {
        await ctx.reply(
          "That doesn't look like a channel ID — it should be a number, like -1001234567890. Add the bot as an admin to your channel first, then paste the ID.",
          { reply_markup: { force_reply: true, input_field_placeholder: "-1001234567890" } },
        );
        return;
      }
      ctx.session.teamChannelId = channelId; // real channel id
      await finalizeTeamCreation(ctx);
      return;
    }

    default:
      return next();
  }
});

composer.callbackQuery("team:use_defaults", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.teamQuestions = [...DEFAULT_QUESTIONS];
  ctx.session.step = "team:channel";
  await ctx.editMessageText(
    `Using the ${DEFAULT_QUESTIONS.length} default questions.\n\nLast step: send me the Telegram channel ID where daily digests should be posted. The bot must be added as an admin to that channel.\n\nExample: -1001234567890`,
    {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Cancel", "menu:main")]]),
    },
  );
});

async function finalizeTeamCreation(ctx: Ctx): Promise<void> {
  const name = ctx.session.teamName!;
  const scheduleTime = ctx.session.teamSchedule!;
  const timezone = ctx.session.teamTimezone!;
  const channelId = ctx.session.teamChannelId!;
  const questions = ctx.session.teamQuestions!;
  const inviteCode = generateInviteCode();
  const teamId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const team: TeamData = {
    id: teamId,
    name,
    channelId,
    scheduleTime,
    scheduleDays: ["mon", "tue", "wed", "thu", "fri"],
    timezone,
    questionSet: questions,
    inviteCode,
    createdAt: now().toISOString(),
  };

  await saveTeam(team);
  await registerInviteCode(inviteCode, teamId);
  await registerTeamSchedule(team);

  // Add creator as first member
  const creatorId = ctx.from!.id;
  const member: MemberData = {
    telegramId: creatorId,
    displayName: ctx.from!.first_name + (ctx.from!.last_name ? " " + ctx.from!.last_name : ""),
    teamId,
    timezone,
    joinedAt: now().toISOString(),
  };
  await saveMember(member);

  // Resolve invite link
  const botUsername = ctx.me?.username ?? "bot";
  const inviteLink = `https://t.me/${botUsername}?start=join_${inviteCode}`;

  ctx.session.step = "";
  await ctx.reply(
    `✅ Team "${name}" is ready!\n\n` +
    `⏰ Daily standups at ${scheduleTime} (member local time)\n` +
    `📋 ${questions.length} questions per standup\n` +
    `📣 Digests posted to channel ${channelId}\n\n` +
    `🔗 Share this link with your team so they can join:\n${inviteLink}\n\n` +
    `You can also share the join code directly: \`${inviteCode}\``,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("👥 Manage team", "team:manage")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
      parse_mode: "MarkdownV2",
    },
  );
}

// ── Manage team ─────────────────────────────────────────────────────────

composer.callbackQuery("team:manage", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);

  if (!teamId) {
    await ctx.editMessageText(
      "You're not a member of any team yet. Create one or ask your admin for an invite link.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const team = await getTeam(teamId);
  if (!team) {
    await ctx.editMessageText(
      "Your team seems to be gone — it may have been deleted. Create a new one to get started.",
      { reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]) },
    );
    return;
  }

  const members = await getTeamMembers(teamId);
  const botUsername = ctx.me?.username ?? "bot";
  const inviteLink = `https://t.me/${botUsername}?start=join_${team.inviteCode}`;

  const lines = [
    `⚙️ *${team.name}*`,
    "",
    `⏰ Schedule: ${team.scheduleTime} (${team.scheduleDays.join(", ")})`,
    `👥 Members: ${members.length}`,
    `📋 Questions: ${team.questionSet.length}`,
    "",
    `🔗 Invite link: ${inviteLink}`,
    `🔑 Join code: \`${team.inviteCode}\``,
  ];

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard([
      [inlineButton("🔄 Regenerate invite", "team:regen_invite")],
      [inlineButton("📋 Edit questions", "team:edit_questions")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
    parse_mode: "MarkdownV2",
  });
});

composer.callbackQuery("team:regen_invite", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Generating new invite link…" });
  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);
  if (!teamId) return;

  const team = await getTeam(teamId);
  if (!team) return;

  team.inviteCode = generateInviteCode();
  await saveTeam(team);

  const botUsername = ctx.me?.username ?? "bot";
  const inviteLink = `https://t.me/${botUsername}?start=join_${team.inviteCode}`;

  const members = await getTeamMembers(teamId);
  const lines = [
    `⚙️ *${team.name}*`,
    "",
    `⏰ Schedule: ${team.scheduleTime} (${team.scheduleDays.join(", ")})`,
    `👥 Members: ${members.length}`,
    "",
    `✅ New invite link generated:`,
    `${inviteLink}`,
    `Join code: \`${team.inviteCode}\``,
  ];

  await ctx.editMessageText(lines.join("\n"), {
    reply_markup: inlineKeyboard([
      [inlineButton("🔄 Regenerate invite", "team:regen_invite")],
      [inlineButton("📋 Edit questions", "team:edit_questions")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
    parse_mode: "MarkdownV2",
  });
});

composer.callbackQuery("team:edit_questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teamId = await getMemberTeamId(userId);
  if (!teamId) return;

  const team = await getTeam(teamId);
  if (!team) return;

  ctx.session.step = "team:edit_q";
  ctx.session.teamId = teamId;

  await ctx.editMessageText(
    `Current questions:\n\n${team.questionSet.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nSend your new questions, one per line.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("🔙 Back", "team:manage")],
      ]),
    },
  );
});

// Handle edit questions text
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "team:edit_q") return next();
  const text = ctx.message.text.trim();
  const questions = text
    .split("\n")
    .map((q) => q.replace(/^\d+[.)]\s*/, "").trim())
    .filter((q) => q.length > 0);

  if (questions.length < 1 || questions.length > 10) {
    await ctx.reply("Send 1–10 questions, one per line.");
    return;
  }

  const teamId = ctx.session.teamId;
  if (!teamId) return;
  const team = await getTeam(teamId);
  if (!team) return;
  team.questionSet = questions;
  await saveTeam(team);
  ctx.session.step = "";

  await ctx.reply(
    `✅ Updated to ${questions.length} question(s).`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("⚙️ Back to manage", "team:manage")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;
