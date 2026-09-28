// Human-like pacing rules. All time-of-day logic is evaluated in EMAIL_TIMEZONE
// (default US Eastern) since our recipients are US GitHub users with no known
// per-person timezone. Three concerns live here:
//   1. Send window   — only send on weekdays within business hours (EST).
//   2. Warm-up ramp   — a per-account daily cap that grows with account age.
//   3. Jittered gaps  — randomized spacing between an account's sends.

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const TIMEZONE = process.env.EMAIL_TIMEZONE?.trim() || 'America/New_York';

/** Business-hours window (inclusive start, exclusive end) in TIMEZONE. */
export const SEND_START_HOUR = num(process.env.EMAIL_SEND_START_HOUR, 9);
export const SEND_END_HOUR = num(process.env.EMAIL_SEND_END_HOUR, 18);
/** Weekdays only by default: 1=Mon … 5=Fri (0=Sun, 6=Sat). */
export const SEND_DAYS = new Set(
  (process.env.EMAIL_SEND_DAYS?.trim() || '1,2,3,4,5')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n))
);

/** Steady-state daily cap per account, reached after the warm-up ramp. */
export const DAILY_TARGET = num(process.env.EMAIL_DAILY_CAP, 20);

/** Random gap between one account's consecutive sends (minutes → ms). */
export const MIN_GAP_MIN = num(process.env.EMAIL_MIN_GAP_MIN, 15);
export const MAX_GAP_MIN = num(process.env.EMAIL_MAX_GAP_MIN, 30);
/** Small chance of a longer "coffee break" pause, to look less metronomic. */
const BREAK_CHANCE = 0.1;
const BREAK_MULTIPLIER = 3;

/** Weekday (0–6) and hour (0–23) of `date` as observed in TIMEZONE. */
function zonedParts(date: Date): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: days[wd] ?? 0, hour: hourRaw % 24 }; // '24' → 0 at midnight
}

/** True when `date` falls on a sending day and inside business hours (TIMEZONE). */
export function inSendWindow(date: Date = new Date()): boolean {
  const { weekday, hour } = zonedParts(date);
  return SEND_DAYS.has(weekday) && hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

/** Calendar date (YYYY-MM-DD) in TIMEZONE — the key we count a day's sends by. */
export function zonedDateString(date: Date = new Date()): string {
  // en-CA renders as ISO-style yyyy-mm-dd.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Warm-up ramp: the base daily cap for an account of the given age. New accounts
 * start low and grow over ~4 weeks to DAILY_TARGET. Never exceeds the target.
 */
export function dailyCapForAge(ageDays: number): number {
  const ramp = ageDays < 7 ? 5 : ageDays < 14 ? 10 : ageDays < 21 ? 15 : DAILY_TARGET;
  return Math.min(ramp, DAILY_TARGET);
}

/** Deterministic 0..(n-1) from a string, so a day's cap jitter is stable per account/day. */
export function stableJitter(seed: string, n: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return n <= 0 ? 0 : h % n;
}

/** Today's effective cap for an account: warm-up ramp minus a small stable daily jitter. */
export function effectiveDailyCap(ageDays: number, label: string, day: string): number {
  return Math.max(1, dailyCapForAge(ageDays) - stableJitter(`${label}:${day}`, 3));
}

/** Milliseconds to wait before an account's next send (jittered, occasional break). */
export function nextGapMs(): number {
  const lo = Math.min(MIN_GAP_MIN, MAX_GAP_MIN);
  const hi = Math.max(MIN_GAP_MIN, MAX_GAP_MIN);
  let minutes = lo + Math.random() * (hi - lo);
  if (Math.random() < BREAK_CHANCE) minutes *= BREAK_MULTIPLIER;
  return Math.round(minutes * 60_000);
}
