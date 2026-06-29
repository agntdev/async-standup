/**
 * Domain entities for the Async Standup Bot.
 * Pure data shapes + repository functions (no bot wiring).
 */

import { getStore, type KvStore } from "./store.js";
import { getClock } from "./clock.js";

// ── Data shapes ─────────────────────────────────────────────────────────────

export interface Team {
  id: string; // short join code (e.g., "abc123")
  name: string;
  createdBy: number; // telegram user id of admin
  channelId: number; // channel to post digests
  schedule: {
    promptHourUTC: number; // 0-23, when to send prompts
    cutoffHourUTC: number; // 0-23, when to compile digest
  };
  questions: string[]; // ordered list of standup questions
  timezonePolicy: "member" | "team"; // member = each at their local time; team = same UTC
  inviteCode: string; // generated join code
  memberIds: number[]; // list of telegram user IDs (the INDEX)
  createdAt: string; // ISO date
}

export interface Member {
  telegramId: number;
  displayName: string;
  timezone: string; // IANA tz e.g. "America/New_York"
  teamId: string;
  joinedAt: string; // ISO date
}

export type StandupStatus = "open" | "completed";

export interface StandupRun {
  id: string; // "teamId:yyyy-mm-dd"
  teamId: string;
  runDate: string; // "yyyy-mm-dd"
  status: StandupStatus;
  participants: StandupParticipant[];
  promptSentAt: string; // ISO
  cutoffAt: string; // ISO
}

export interface StandupParticipant {
  telegramId: number;
  status: "pending" | "responded" | "skipped";
  answers: string[]; // one answer per question; empty string = skipped
  respondedAt?: string; // ISO when responded
}

export interface Digest {
  runDate: string;
  teamId: string;
  postedAt: string; // ISO
  responseCount: number;
  totalMembers: number;
  blockers: string[];
  pendingUsers: number[];
  summary: string; // markdown-formatted digest text
}

// ── Repository keys ─────────────────────────────────────────────────────────

function teamKey(teamId: string): string {
  return `team:${teamId}`;
}

function memberKey(telegramId: number): string {
  return `member:${telegramId}`;
}

function standupRunKey(teamId: string, date: string): string {
  return `run:${teamId}:${date}`;
}

function digestKey(teamId: string, date: string): string {
  return `digest:${teamId}:${date}`;
}

/** Index: all standup run dates for a team (sorted list of dates). */
function runsIndexKey(teamId: string): string {
  return `idx:runs:${teamId}`;
}

/** Index: all digest dates for a team. */
function digestsIndexKey(teamId: string): string {
  return `idx:digests:${teamId}`;
}

/** Index: all team IDs for the scheduler. */
function teamsIndexKey(): string {
  return "idx:teams";
}

// ── Generic helpers ─────────────────────────────────────────────────────────

function jsonParse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function appendToIndex(store: KvStore, key: string, value: string): Promise<void> {
  const raw = await store.get(key);
  const arr: string[] = raw ? (JSON.parse(raw) as string[]) : [];
  if (!arr.includes(value)) {
    arr.push(value);
  }
  await store.set(key, JSON.stringify(arr));
}

// ── Team operations ─────────────────────────────────────────────────────────

export async function createTeam(team: Team): Promise<void> {
  const store = getStore();
  await store.set(teamKey(team.id), JSON.stringify(team));
  await appendToIndex(store, teamsIndexKey(), team.id);
}

export async function getTeam(teamId: string): Promise<Team | null> {
  const store = getStore();
  return jsonParse<Team>(await store.get(teamKey(teamId)));
}

export async function updateTeam(teamId: string, updates: Partial<Team>): Promise<Team | null> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) return null;
  Object.assign(team, updates);
  await store.set(teamKey(teamId), JSON.stringify(team));
  return team;
}

export async function addMemberToTeam(teamId: string, telegramId: number): Promise<void> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);
  if (!team.memberIds.includes(telegramId)) {
    team.memberIds.push(telegramId);
    await store.set(teamKey(teamId), JSON.stringify(team));
  }
}

export async function removeMemberFromTeam(teamId: string, telegramId: number): Promise<void> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) return;
  team.memberIds = team.memberIds.filter((id) => id !== telegramId);
  await store.set(teamKey(teamId), JSON.stringify(team));
}

/** Get all teams by scanning the member's teamId pointer — NO key enumeration. */
export async function getTeamByMember(telegramId: number): Promise<Team | null> {
  const member = await getMember(telegramId);
  if (!member) return null;
  return getTeam(member.teamId);
}

// ── Member operations ───────────────────────────────────────────────────────

export async function createMember(member: Member): Promise<void> {
  const store = getStore();
  await store.set(memberKey(member.telegramId), JSON.stringify(member));
}

export async function getMember(telegramId: number): Promise<Member | null> {
  const store = getStore();
  return jsonParse<Member>(await store.get(memberKey(telegramId)));
}

export async function getMembersByIds(ids: number[]): Promise<Member[]> {
  const store = getStore();
  const results: Member[] = [];
  for (const id of ids) {
    const m = await getMember(id);
    if (m) results.push(m);
  }
  return results;
}

export async function setMemberTimezone(telegramId: number, tz: string): Promise<void> {
  const store = getStore();
  const member = await getMember(telegramId);
  if (!member) return;
  member.timezone = tz;
  await store.set(memberKey(telegramId), JSON.stringify(member));
}

export async function deleteMember(telegramId: number): Promise<void> {
  const store = getStore();
  const member = await getMember(telegramId);
  if (member) {
    await removeMemberFromTeam(member.teamId, telegramId);
    await store.del(memberKey(telegramId));
  }
}

// ── Standup Run operations ──────────────────────────────────────────────────

export async function createStandupRun(run: StandupRun): Promise<void> {
  const store = getStore();
  await store.set(standupRunKey(run.teamId, run.runDate), JSON.stringify(run));
  await appendToIndex(store, runsIndexKey(run.teamId), run.runDate);
}

export async function getStandupRun(teamId: string, date: string): Promise<StandupRun | null> {
  const store = getStore();
  return jsonParse<StandupRun>(await store.get(standupRunKey(teamId, date)));
}

export async function updateStandupRun(teamId: string, date: string, updates: Partial<StandupRun>): Promise<StandupRun | null> {
  const store = getStore();
  const run = await getStandupRun(teamId, date);
  if (!run) return null;
  Object.assign(run, updates);
  await store.set(standupRunKey(teamId, date), JSON.stringify(run));
  return run;
}

export async function setParticipantResponse(
  teamId: string,
  date: string,
  telegramId: number,
  answers: string[],
): Promise<StandupRun | null> {
  const run = await getStandupRun(teamId, date);
  if (!run) return null;
  const clock = getClock();
  const idx = run.participants.findIndex((p) => p.telegramId === telegramId);
  if (idx >= 0) {
    run.participants[idx].status = "responded";
    run.participants[idx].answers = answers;
    run.participants[idx].respondedAt = clock.nowISO();
  }
  return updateStandupRun(teamId, date, run);
}

// ── Digest operations ───────────────────────────────────────────────────────

export async function createDigest(digest: Digest): Promise<void> {
  const store = getStore();
  await store.set(digestKey(digest.teamId, digest.runDate), JSON.stringify(digest));
  await appendToIndex(store, digestsIndexKey(digest.teamId), digest.runDate);
}

export async function getDigest(teamId: string, date: string): Promise<Digest | null> {
  const store = getStore();
  return jsonParse<Digest>(await store.get(digestKey(teamId, date)));
}

export async function getRecentDigests(teamId: string, limit: number = 30): Promise<Digest[]> {
  const store = getStore();
  const raw = await store.get(digestsIndexKey(teamId));
  if (!raw) return [];
  const dates: string[] = JSON.parse(raw) as string[];
  // Most recent first
  const sorted = dates.sort().reverse().slice(0, limit);
  const digests: Digest[] = [];
  for (const d of sorted) {
    const digest = jsonParse<Digest>(await store.get(digestKey(teamId, d)));
    if (digest) digests.push(digest);
  }
  return digests;
}

export async function getRecentRuns(teamId: string, limit: number = 30): Promise<StandupRun[]> {
  const store = getStore();
  const raw = await store.get(runsIndexKey(teamId));
  if (!raw) return [];
  const dates: string[] = JSON.parse(raw) as string[];
  const sorted = dates.sort().reverse().slice(0, limit);
  const runs: StandupRun[] = [];
  for (const d of sorted) {
    const run = jsonParse<StandupRun>(await store.get(standupRunKey(teamId, d)));
    if (run) runs.push(run);
  }
  return runs;
}

// ── Invite code generation ──────────────────────────────────────────────────

/** Generate a short alphanumeric join code. */
export function generateInviteCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ── Digest compilation ──────────────────────────────────────────────────────

/**
 * Compile a digest from a standup run. Flag blockers (answers that match
 * blocker patterns: "blocked", "blocker", "stuck", "impediment"). Only flag
 * NON-EMPTY blocker answers.
 */
export function compileDigest(run: StandupRun, team: Team, members: Member[]): Digest {
  const clock = getClock();
  const memberMap = new Map(members.map((m) => [m.telegramId, m]));

  const responded = run.participants.filter((p) => p.status === "responded");
  const pending = run.participants.filter((p) => p.status === "pending");

  const blockers: string[] = [];
  const blockerPatterns = /\b(blocked|blocker|stuck|impediment|can['’]t proceed|waiting on)\b/i;

  for (const p of responded) {
    const displayName = memberMap.get(p.telegramId)?.displayName ?? `User ${p.telegramId}`;
    for (let i = 0; i < p.answers.length; i++) {
      const answer = p.answers[i]?.trim();
      if (!answer) continue; // skip empty answers
      if (blockerPatterns.test(answer)) {
        blockers.push(`⚠️ ${displayName}: ${answer}`);
      }
    }
  }

  const pendingUsers = pending.map((p) => p.telegramId);

  let summary = `📊 **Standup Digest — ${run.runDate}**\n\n`;
  summary += `Team: ${team.name}\n`;
  summary += `Responses: ${responded.length}/${run.participants.length}\n\n`;

  if (responded.length > 0) {
    summary += `**Responses:**\n`;
    for (const p of responded) {
      const name = memberMap.get(p.telegramId)?.displayName ?? `User ${p.telegramId}`;
      summary += `👤 ${name}:\n`;
      for (let i = 0; i < p.answers.length; i++) {
        const q = team.questions[i] ?? `Q${i + 1}`;
        const a = p.answers[i]?.trim() || "(no answer)";
        summary += `  _${q}_ ${a}\n`;
      }
    }
    summary += `\n`;
  }

  if (blockers.length > 0) {
    summary += `🚨 **Blockers:**\n`;
    for (const b of blockers) {
      summary += `${b}\n`;
    }
    summary += `\n`;
  }

  if (pendingUsers.length > 0) {
    summary += `⏳ **Still pending:**\n`;
    for (const id of pendingUsers) {
      const name = memberMap.get(id)?.displayName ?? `User ${id}`;
      summary += `  ${name}\n`;
    }
    summary += `\n`;
  }

  summary += `_Digest cutoff: ${run.cutoffAt}_`;

  return {
    runDate: run.runDate,
    teamId: run.teamId,
    postedAt: clock.nowISO(),
    responseCount: responded.length,
    totalMembers: run.participants.length,
    blockers,
    pendingUsers,
    summary,
  };
}
