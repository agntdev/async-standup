/**
 * Injectable clock seam. Route every schedule, cutoff, "today", expiry, and
 * late/on-time decision through `now()` instead of inline `new Date()` /
 * `Date.now()`. Override in tests to drive time-based behavior deterministically.
 */

let override: (() => Date) | null = null;

/** Current time as a Date. Override with `setClock` for testing. */
export function now(): Date {
  if (override) return override();
  return new Date();
}

/** Override the clock. Call with `null` to restore real time. Test-only. */
export function setClock(fn: (() => Date) | null): void {
  override = fn;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
export function formatDate(date: Date, tz: string): string {
  try {
    return date.toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    return date.toLocaleDateString("en-CA", { timeZone: "UTC" });
  }
}

/** Parse HH:MM in a given timezone to today's Date at that time. */
export function timeToday(time: string, tz: string): Date {
  const [h, m] = time.split(":").map(Number);
  const d = now();
  // Get today's date in the target timezone, then set hours/minutes
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [year, month, day] = fmt.format(d).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, h!, m!));
}

/** Convert a Date to HH:MM string in a timezone. */
export function formatTime(date: Date, tz: string): string {
  try {
    return date.toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toLocaleTimeString("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}