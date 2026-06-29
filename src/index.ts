import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { getClock } from "./clock.js";
import { sendStandupPrompts, sendNudges, compileAndPostDigest } from "./standup-runner.js";
import type { Api } from "grammy";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);
  bot.start();

  // ── Standup scheduler heartbeat ──────────────────────────────────────
  // Every 60 seconds, check if any team is due for its standup run.
  // This is a simple polling approach — in production, replace with a
  // proper cron or external scheduler triggering the bot via HTTP.
  const CHECK_INTERVAL_MS = 60_000;

  setInterval(async () => {
    try {
      await runSchedulerTick(bot.api);
    } catch (err) {
      console.error("[scheduler] tick error:", (err as Error).message);
    }
  }, CHECK_INTERVAL_MS);

  console.log("[standup-bot] started — scheduler running every 60s");
}

// ── Scheduler tick ────────────────────────────────────────────────────────

async function runSchedulerTick(api: import("grammy").Api): Promise<void> {
  const clock = getClock();
  const now = clock.now();
  const currentHour = now.getUTCHours();
  const today = clock.todayISO();

  // Enumerate teams via a well-known index key — the store maintains this index
  // for the scheduler to discover active teams without scanning keyspace.
  const { getStore } = await import("./store.js");
  const store = getStore();

  // Read team IDs from a dedicated index
  const raw = await store.get("idx:teams");
  if (!raw) return;
  const teamIds: string[] = JSON.parse(raw);

  for (const teamId of teamIds) {
    const { getTeam, getStandupRun, getMembersByIds } = await import("./domain.js");
    const team = await getTeam(teamId);
    if (!team) continue;

    const run = await getStandupRun(teamId, today);

    // ── PROMPT TIME: start standup if not yet started ──
    // Per-member timezone: calculate the effective prompt hour for each member
    // by mapping their local time to UTC. For team-wide policy, use the global hour.
    if (!run) {
      if (team.timezonePolicy === "member") {
        // Per-member: send prompts when it's the member's local prompt hour
        // We calculate which members are due right now based on their timezone offset
        const members = await getMembersByIds(team.memberIds);
        const dueMemberIds: number[] = [];

        for (const m of members) {
          // Member's local time = UTC + offset; if local hour matches prompt hour,
          // they are due.
          const offset = m.timezoneOffsetHours ?? 0;
          const memberLocalHour = (currentHour + offset + 24) % 24;
          if (memberLocalHour === team.schedule.promptHourUTC) {
            dueMemberIds.push(m.telegramId);
          }
        }

        if (dueMemberIds.length > 0) {
          console.log(`[scheduler] sending prompts for ${dueMemberIds.length} members in team ${team.name} (per-member tz)`);
          await sendStandupPrompts(api, teamId, dueMemberIds);
        }
      } else {
        // Team-wide: all members at the same UTC hour
        if (currentHour === team.schedule.promptHourUTC) {
          console.log(`[scheduler] sending prompts for team ${team.name}`);
          await sendStandupPrompts(api, teamId);
        }
      }
    }

    // ── NUDGE TIME: 2 hours after each member's local prompt ──
    if (run && run.status === "open") {
      if (team.timezonePolicy === "member") {
        // Per-member: nudge 2 hours after each member's LOCAL prompt hour
        const members = await getMembersByIds(team.memberIds);
        let shouldNudge = false;
        for (const m of members) {
          const offset = m.timezoneOffsetHours ?? 0;
          const memberLocalHour = (currentHour + offset + 24) % 24;
          const nudgeLocalHour = (team.schedule.promptHourUTC + 2) % 24;
          if (memberLocalHour === nudgeLocalHour) {
            shouldNudge = true;
            break;
          }
        }
        if (shouldNudge) {
          console.log(`[scheduler] sending nudges for team ${team.name} (per-member tz)`);
          await sendNudges(api, teamId);
        }
      } else {
        // Team-wide: nudge 2 hours after the global prompt hour
        const nudgeHour = (team.schedule.promptHourUTC + 2) % 24;
        if (currentHour === nudgeHour) {
          console.log(`[scheduler] sending nudges for team ${team.name}`);
          await sendNudges(api, teamId);
        }
      }
    }

    // ── CUTOFF TIME: compile and post digest ──
    // The cutoff is always relative to prompt: it fires promptHour + (cutoffOffset) hours,
    // where cutoffOffset is the hours between prompt and cutoff, wrapping midnight if needed.
    // e.g. prompt=9, cutoff=17 → offset=8 → fires at 17 UTC
    // e.g. prompt=20, cutoff=8 (next day) → offset=12 → fires at 8 UTC the next day
    if (
      run &&
      run.status === "open"
    ) {
      // Calculate the effective cutoff hour considering crossing-midnight schedules.
      // cutoffHourUTC is always the absolute hour of day. If cutoff <= prompt, the cutoff
      // is the NEXT day (e.g. prompt at 20:00, cutoff at 08:00 the next morning — a 12-hour window).
      const promptHour = team.schedule.promptHourUTC;
      const cutoffHour = team.schedule.cutoffHourUTC;
      let firesToday: boolean;
      if (cutoffHour > promptHour) {
        firesToday = currentHour === cutoffHour;
      } else {
        // cutoff <= prompt means next-day cutoff — fires at cutoffHour
        firesToday = currentHour === cutoffHour;
      }
      if (firesToday) {
        console.log(`[scheduler] compiling digest for team ${team.name}`);
        await compileAndPostDigest(api, teamId);
      }
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});