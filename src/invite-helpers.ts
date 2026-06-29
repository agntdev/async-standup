/**
 * Invite code helpers — shared between team.ts and join.ts to avoid circular imports.
 */
import { getKV } from "./store.js";
import type { TeamData } from "./handlers/team.js";
import { getTeam } from "./handlers/team.js";

/** Generate a short, human-friendly invite code (e.g., ABCD-EFGH). */
export function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/I/1 confusion
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code.slice(0, 4) + "-" + code.slice(4);
}

/** Resolve a team by its invite code. Returns the team or null. */
export async function resolveTeamByInvite(inviteCode: string): Promise<TeamData | null> {
  const kv = getKV();
  const teamId = await kv.get(`invite:${inviteCode}`);
  if (!teamId) return null;
  return getTeam(teamId);
}

/** Register an invite code → teamId mapping. */
export async function registerInviteCode(inviteCode: string, teamId: string): Promise<void> {
  const kv = getKV();
  await kv.set(`invite:${inviteCode}`, teamId);
}
