/** The business operates in Melbourne; all user-facing times use this zone (DST handled by Intl). */
export const BUSINESS_TIMEZONE = 'Australia/Melbourne';
export const BUSINESS_LOCALE = 'en-AU';
export const BUSINESS_CURRENCY = 'AUD';

export function formatDateTime(date: Date | string, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(BUSINESS_LOCALE, {
    timeZone: BUSINESS_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...opts,
  }).format(d);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, dateStyle: 'medium' }).format(d);
}

export function formatCurrencyAud(amountCents: number): string {
  return new Intl.NumberFormat(BUSINESS_LOCALE, { style: 'currency', currency: BUSINESS_CURRENCY }).format(amountCents / 100);
}

/** Seconds → "m:ss" for timelines. */
export function formatSeconds(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------------------------------------
// Melbourne wall-clock helpers (Stage B/C). Built only on Intl, so they run the same in the browser, the web
// server and the worker. Daylight saving in Victoria starts on the first Sunday of October (02:00 AEST jumps to
// 03:00 AEDT) and ends on the first Sunday of April (03:00 AEDT falls back to 02:00 AEST).
// ---------------------------------------------------------------------------------------------------------

/** A calendar date in Melbourne, `YYYY-MM-DD`. */
export type MelbourneDate = string;
/** A wall-clock time in Melbourne, `HH:mm` (24-hour). */
export type MelbourneTime = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Melbourne is UTC+10 (AEST) or UTC+11 (AEDT); these are the only offsets a local time can have. */
const MELBOURNE_OFFSETS_HOURS = [11, 10] as const;

const wallClockFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const zoneNameFormat = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, timeZoneName: 'short' });

/** Melbourne wall-clock parts of an instant. */
function wallClock(instant: Date): { date: MelbourneDate; time: MelbourneTime } {
  const parts: Record<string, string> = {};
  for (const p of wallClockFormat.formatToParts(instant)) parts[p.type] = p.value;
  return { date: `${parts['year']}-${parts['month']}-${parts['day']}`, time: `${parts['hour']}:${parts['minute']}` };
}

/** True when `date` is a real calendar date written as `YYYY-MM-DD`. */
export function isMelbourneDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** Result of turning a Melbourne date and time into one UTC instant. */
export type MelbourneLocalResult = { ok: true; instant: Date; ambiguous: boolean } | { ok: false; reason: 'nonexistent' | 'invalid' };

/**
 * Converts a Melbourne wall-clock date and time to a UTC instant.
 *
 * Tries both possible offsets (+11 h, +10 h) and keeps each candidate whose Melbourne time formats back to the
 * same date and time. No candidate means the time does not exist (the 02:00–02:59 gap when clocks go forward in
 * October). Two candidates mean the hour happens twice (02:00–02:59 when clocks go back in April): the earlier
 * instant (AEDT) is chosen and `ambiguous` is true, so the UI can say "the first 2:30 am".
 */
export function melbourneLocalToUtc(date: MelbourneDate, time: MelbourneTime): MelbourneLocalResult {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm || !isMelbourneDate(date)) return { ok: false, reason: 'invalid' };
  const asUtc = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  const candidates = MELBOURNE_OFFSETS_HOURS.map((h) => new Date(asUtc - h * 3600_000)).filter((c) => {
    const back = wallClock(c);
    return back.date === date && back.time === time;
  });
  const earliest = candidates.reduce<Date | null>((a, b) => (a && a.getTime() <= b.getTime() ? a : b), null);
  if (!earliest) return { ok: false, reason: 'nonexistent' };
  return { ok: true, instant: earliest, ambiguous: candidates.length > 1 };
}

/** The Melbourne calendar date (`YYYY-MM-DD`) an instant falls on. */
export function melbourneDateOf(instant: Date): MelbourneDate {
  return wallClock(instant).date;
}

/** The Melbourne wall-clock time (`HH:mm`) of an instant. */
export function melbourneTimeOf(instant: Date): MelbourneTime {
  return wallClock(instant).time;
}

/** Adds whole days to a `YYYY-MM-DD` date (calendar arithmetic; no time zone involved). */
export function addDaysToDate(date: MelbourneDate, days: number): MelbourneDate {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/**
 * Zone abbreviation in force in Melbourne: "AEDT" during daylight saving, otherwise "AEST". Accepts an instant or
 * a `YYYY-MM-DD` date (judged at midday, which never falls in a changeover hour).
 */
export function melbourneZoneLabel(at: Date | MelbourneDate): string {
  let instant: Date;
  if (typeof at === 'string') {
    const noon = melbourneLocalToUtc(at, '12:00');
    if (!noon.ok) throw new Error(`Not a YYYY-MM-DD date: ${at}`);
    instant = noon.instant;
  } else {
    instant = at;
  }
  return zoneNameFormat.formatToParts(instant).find((p) => p.type === 'timeZoneName')?.value ?? 'AEST';
}

/**
 * The UTC range `[start, end)` covering one Melbourne calendar day. Midnight always exists in Melbourne (the
 * changes happen at 2–3 am), so a day is 23, 24 or 25 hours long.
 */
export function melbourneDayRange(date: MelbourneDate): { start: Date; end: Date } {
  const start = melbourneLocalToUtc(date, '00:00');
  const end = isMelbourneDate(date) ? melbourneLocalToUtc(addDaysToDate(date, 1), '00:00') : start;
  if (!start.ok || !end.ok) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return { start: start.instant, end: end.instant };
}

/** A daily sending window in Melbourne time; `end` is exclusive. */
export interface SendWindow {
  start: MelbourneTime;
  end: MelbourneTime;
}

/** Default window for client emails: 9 am to 7 pm Melbourne time. */
export const DEFAULT_SEND_WINDOW: SendWindow = { start: '09:00', end: '19:00' };

/**
 * The first instant at or after `earliest` inside the Melbourne daily window: `earliest` itself when it is inside,
 * that day's opening time when it is earlier, or the next day's opening time when it is at or after closing.
 * Window times must exist every day (anything outside 02:00–02:59 does).
 */
export function nextSendSlot(earliest: Date, window: SendWindow = DEFAULT_SEND_WINDOW): Date {
  if (!TIME_RE.test(window.start) || !TIME_RE.test(window.end) || window.start >= window.end) {
    throw new Error('The sending window must be two HH:mm times with the start before the end');
  }
  const local = wallClock(earliest);
  if (local.time >= window.start && local.time < window.end) return earliest;
  const day = local.time < window.start ? local.date : addDaysToDate(local.date, 1);
  const opening = melbourneLocalToUtc(day, window.start);
  if (!opening.ok) throw new Error(`The window start ${window.start} does not exist on ${day}`);
  return opening.instant;
}
