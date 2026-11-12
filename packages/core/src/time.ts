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
