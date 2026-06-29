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
    const { getTeam, getStandupRun } = await import("./domain.js");
    const team = await getTeam(teamId);
    if (!team) continue;

    const run = await getStandupRun(teamId, today);

    // ── PROMPT TIME: start standup if not yet started ──
    if (currentHour === team.schedule.promptHourUTC && !run) {
      console.log(`[scheduler] sending prompts for team ${team.name}`);
      await sendStandupPrompts(api, teamId);
    }

    // ── NUDGE TIME: 2 hours after prompt ──
    if (run && run.status === "open" && currentHour === team.schedule.promptHourUTC + 2) {
      console.log(`[scheduler] sending nudges for team ${team.name}`);
      await sendNudges(api, teamId);
    }

    // ── CUTOFF TIME: compile and post digest ──
    if (run && run.status === "open" && currentHour === team.schedule.cutoffHourUTC) {
      console.log(`[scheduler] compiling digest for team ${team.name}`);
      await compileAndPostDigest(api, teamId);
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
