/**
 * Injectable clock seam — every schedule, cutoff, "today", and expiry routes
 * through this module so time-based behavior is testable.
 */
export interface Clock {
  now(): Date;
  nowISO(): string;
  todayISO(): string;
  timestamp(): number;
}

function realNow(): Date {
  return new Date();
}

const real: Clock = {
  now: realNow,
  nowISO: () => realNow().toISOString(),
  todayISO: () => realNow().toISOString().split("T")[0],
  timestamp: () => Date.now(),
};

let current: Clock = real;

/** Get the active clock. Call this throughout the bot instead of `new Date()`. */
export function getClock(): Clock {
  return current;
}

/** Override the clock (test-only). Call before building the bot. */
export function setClock(c: Clock): void {
  current = c;
}

/** Restore the real clock (test teardown). */
export function resetClock(): void {
  current = real;
}