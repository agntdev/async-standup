/**
 * Domain entities for the Async Standup Bot.
 * Pure data shapes + repository functions (no bot wiring).
 */

import { getStore, type KvStore } from "./store.js";
import { getClock } from "./clock.js";
import crypto from "node:crypto";

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
  /** Invite code created-at timestamp (ms since epoch) for expiration tracking. */
  inviteCreatedAt?: number;
  /** Previous invite codes that are still valid (for multi-invite support). */
  previousInviteCodes?: string[];
}

export interface Member {
  telegramId: number;
  displayName: string;
  timezone: string; // IANA tz e.g. "America/New_York"
  /** UTC offset hours for fast scheduling math without tz db lookups. */
  timezoneOffsetHours?: number;
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
  skippedUsers: number[];
  summary: string; // markdown-formatted digest text
  /** Per-user response details for history search */
  responses: { displayName: string; answers: string[]; status: "responded" | "skipped" }[];
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

/** Index: per-user pointer to team memberships (userId -> [teamId]). */
function userTeamsIndexKey(telegramId: number): string {
  return `idx:userteams:${telegramId}`;
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

/**
 * Regenerate a team's invite code, properly re-keying the team record.
 * The old invite code may optionally continue to work (stored in previousInviteCodes).
 */
export async function regenerateInviteCode(
  teamId: string,
  newCode: string,
  keepOldValid = true,
): Promise<Team | null> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) return null;

  const clock = getClock();
  const oldCode = team.inviteCode;

  // Build the updated team under the NEW key
  const updated: Team = {
    ...team,
    id: newCode,
    inviteCode: newCode,
    inviteCreatedAt: clock.timestamp(),
  };

  if (keepOldValid) {
    updated.previousInviteCodes = [...(team.previousInviteCodes ?? []), oldCode];
  }

  // Write the updated team at the new key
  await store.set(teamKey(newCode), JSON.stringify(updated));

  // Delete the old team key (but previousInviteCodes keep the old codes working via lookup)
  await store.del(teamKey(teamId));

  // Update the teams index
  const raw = await store.get(teamsIndexKey());
  if (raw) {
    const ids: string[] = JSON.parse(raw);
    const idx = ids.indexOf(teamId);
    if (idx >= 0) {
      ids[idx] = newCode;
      await store.set(teamsIndexKey(), JSON.stringify(ids));
    }
  }

  // Update all members' teamId references
  for (const memberId of team.memberIds) {
    const m = await getMember(memberId);
    if (m && m.teamId === teamId) {
      await createMember({ ...m, teamId: newCode });
    }
  }

  return getTeam(newCode);
}

export async function addMemberToTeam(teamId: string, telegramId: number): Promise<void> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);
  if (!team.memberIds.includes(telegramId)) {
    team.memberIds.push(telegramId);
    await store.set(teamKey(teamId), JSON.stringify(team));
  }
  // Maintain per-user index
  const raw = await store.get(userTeamsIndexKey(telegramId));
  const userTeams: string[] = raw ? JSON.parse(raw) : [];
  if (!userTeams.includes(teamId)) {
    userTeams.push(teamId);
    await store.set(userTeamsIndexKey(telegramId), JSON.stringify(userTeams));
  }
}

export async function removeMemberFromTeam(teamId: string, telegramId: number): Promise<void> {
  const store = getStore();
  const team = await getTeam(teamId);
  if (!team) return;
  team.memberIds = team.memberIds.filter((id) => id !== telegramId);
  await store.set(teamKey(teamId), JSON.stringify(team));
  // Update per-user index
  const raw = await store.get(userTeamsIndexKey(telegramId));
  if (raw) {
    const userTeams: string[] = JSON.parse(raw);
    const filtered = userTeams.filter((t) => t !== teamId);
    if (filtered.length > 0) {
      await store.set(userTeamsIndexKey(telegramId), JSON.stringify(filtered));
    } else {
      await store.del(userTeamsIndexKey(telegramId));
    }
  }
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

export async function setMemberTimezone(telegramId: number, tz: string, offsetHours?: number): Promise<void> {
  const store = getStore();
  const member = await getMember(telegramId);
  if (!member) return;
  member.timezone = tz;
  if (offsetHours !== undefined) {
    member.timezoneOffsetHours = offsetHours;
  }
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

/**
 * Set a participant's response with full answers. Marks status as "responded".
 */
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

/**
 * Mark a participant as having skipped today's standup.
 * This is DISTINCT from "responded" — skipped users do NOT count as responded
 * in digest compilation.
 */
export async function setParticipantSkipped(
  teamId: string,
  date: string,
  telegramId: number,
): Promise<StandupRun | null> {
  const run = await getStandupRun(teamId, date);
  if (!run) return null;
  const clock = getClock();
  const idx = run.participants.findIndex((p) => p.telegramId === telegramId);
  if (idx >= 0) {
    run.participants[idx].status = "skipped";
    run.participants[idx].answers = [];
    run.participants[idx].respondedAt = clock.nowISO();
  }
  return updateStandupRun(teamId, date, run);
}

/**
 * Add a late-joining member to the current day's standup run if one exists.
 */
export async function addLateJoinerToRun(
  teamId: string,
  date: string,
  telegramId: number,
): Promise<void> {
  const run = await getStandupRun(teamId, date);
  if (!run) return;
  if (run.participants.some((p) => p.telegramId === telegramId)) return;
  const team = await getTeam(teamId);
  const questions = team?.questions ?? [];
  run.participants.push({
    telegramId,
    status: "pending",
    answers: questions.map(() => ""),
  });
  await updateStandupRun(teamId, date, run);
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

/** Generate an 8-character alphanumeric invite code using cryptographically secure randomness. */
export function generateInviteCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/** Default invite code expiration: 7 days in milliseconds. */
export const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Check if an invite code has expired. Codes that never had a creation
 * timestamp are treated as non-expiring (legacy support).
 */
export function isInviteExpired(team: Team, nowMs: number): boolean {
  if (!team.inviteCreatedAt) return false;
  return nowMs - team.inviteCreatedAt > INVITE_EXPIRY_MS;
}

/**
 * Look up a team by invite code, checking the primary code, previous codes,
 * and expiration. Returns null if the code doesn't match or is expired.
 */
export async function getTeamByInviteCode(code: string): Promise<Team | null> {
  const team = await getTeam(code);
  if (team) {
    const clock = getClock();
    if (isInviteExpired(team, clock.timestamp())) return null;
    return team;
  }
  // Check all teams for a match in previousInviteCodes
  // We use the teams index rather than key scanning
  const store = getStore();
  const raw = await store.get(teamsIndexKey());
  if (!raw) return null;
  const teamIds: string[] = JSON.parse(raw);
  for (const id of teamIds) {
    const t = await getTeam(id);
    if (t?.previousInviteCodes?.includes(code)) {
      const clock = getClock();
      // For old codes, expiry is checked against the original creation
      if (!isInviteExpired(t, clock.timestamp())) return t;
    }
  }
  return null;
}

// ── Digest compilation ──────────────────────────────────────────────────────

/**
 * Compile a digest from a standup run. Flag blockers (answers that match
 * blocker patterns: "blocked", "blocker", "stuck", "impediment"). Only flag
 * NON-EMPTY blocker answers. Counts responded and skipped separately.
 */
export function compileDigest(run: StandupRun, team: Team, members: Member[]): Digest {
  const clock = getClock();
  const memberMap = new Map(members.map((m) => [m.telegramId, m]));

  const responded = run.participants.filter((p) => p.status === "responded");
  const skipped = run.participants.filter((p) => p.status === "skipped");
  const pending = run.participants.filter((p) => p.status === "pending");

  const blockers: string[] = [];
  const blockerPatterns = /\b(blocked|blocker|stuck|impediment|can['']t proceed|waiting on)\b/i;

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
  const skippedUsers = skipped.map((p) => p.telegramId);

  let summary = `📊 **Standup Digest — ${run.runDate}**\n\n`;
  summary += `Team: ${team.name}\n`;
  summary += `Responses: ${responded.length}/${run.participants.length}`;
  if (skipped.length > 0) {
    summary += ` (${skipped.length} skipped)`;
  }
  summary += `\n\n`;

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

  if (skipped.length > 0) {
    summary += `⏭️ **Skipped:**\n`;
    for (const s of skipped) {
      const name = memberMap.get(s.telegramId)?.displayName ?? `User ${s.telegramId}`;
      summary += `  ${name}\n`;
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

  // Build per-user response details for history search
  const responses: Digest["responses"] = [];
  for (const p of run.participants) {
    if (p.status === "responded" || p.status === "skipped") {
      const displayName = memberMap.get(p.telegramId)?.displayName ?? `User ${p.telegramId}`;
      responses.push({
        displayName,
        answers: p.answers,
        status: p.status,
      });
    }
  }

  return {
    runDate: run.runDate,
    teamId: run.teamId,
    postedAt: clock.nowISO(),
    responseCount: responded.length,
    totalMembers: run.participants.length,
    blockers,
    pendingUsers,
    skippedUsers,
    summary,
    responses,
  };
}
