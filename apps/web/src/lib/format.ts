import { formatDistanceToNowStrict } from 'date-fns';
import { formatBytes, formatDate, formatDateTime, formatSeconds } from '@studio/core';

export { formatBytes, formatDate, formatDateTime, formatSeconds };

/** "3 minutes ago" style relative time (time zone independent). */
export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

/** Melbourne date and time, or a dash when missing. */
export function formatMaybeDateTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return formatDateTime(date);
}

/** Percentage text for a 0–1 progress value. */
export function formatProgress(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}
