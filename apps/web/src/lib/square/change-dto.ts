import 'server-only';
import { BUSINESS_LOCALE, BUSINESS_TIMEZONE, addDaysToDate, bookingChangeStatusWords, formatDateTime, melbourneDateOf, melbourneZoneLabel } from '@studio/core';
import type { schema } from '@studio/db';
import type { AvailabilitySlotDto, BookingChangeDto } from '../shared/square-dto.js';

/** A `square_booking_changes` row. */
export type BookingChangeRow = typeof schema.squareBookingChanges.$inferSelect;

const time = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const day = new Intl.DateTimeFormat(BUSINESS_LOCALE, { timeZone: BUSINESS_TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' });

/** "10:30 am" in Melbourne time. */
export function clockLabel(at: Date): string {
  return time.format(at).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

/** "Sat 21 Nov" in Melbourne time (with "Today · " / "Tomorrow · " when it applies). */
export function shortDayLabel(at: Date, now: Date = new Date()): string {
  const base = day.format(at).replace(',', '');
  const d = melbourneDateOf(at);
  const today = melbourneDateOf(now);
  if (d === today) return `Today · ${base}`;
  if (d === addDaysToDate(today, 1)) return `Tomorrow · ${base}`;
  return base;
}

/**
 * The label a dialog that changes a booking shows: day, time range and the zone in force on that day
 * ("Sat 21 Nov, 10:30–11:15 am AEDT"), so a daylight-saving change is never a surprise.
 */
export function changeTimeLabel(startAt: Date, durationMinutes: number | null | undefined, now: Date = new Date()): string {
  const start = clockLabel(startAt);
  const zone = melbourneZoneLabel(startAt);
  if (!durationMinutes) return `${shortDayLabel(startAt, now)}, ${start} ${zone}`;
  const end = clockLabel(new Date(startAt.getTime() + durationMinutes * 60_000));
  const sameHalf = start.slice(-2) === end.slice(-2);
  return `${shortDayLabel(startAt, now)}, ${sameHalf ? start.slice(0, -3) : start}–${end} ${zone}`;
}

/** A slot with Melbourne labels. */
export function slotDto(s: { startAt: string; teamMemberId: string; durationMinutes: number }, teamNames: ReadonlyMap<string, string>, now: Date = new Date()): AvailabilitySlotDto {
  const start = new Date(s.startAt);
  const end = new Date(start.getTime() + s.durationMinutes * 60_000);
  return { startAt: s.startAt, dayKey: melbourneDateOf(start), dayLabel: shortDayLabel(start, now), startLabel: clockLabel(start), endLabel: clockLabel(end), teamMemberId: s.teamMemberId, teamMemberName: teamNames.get(s.teamMemberId) ?? 'A team member', durationMinutes: s.durationMinutes };
}

/** Square's first `detail` in a stored error body (shown verbatim, as text). */
function squareDetail(body: Record<string, unknown> | null): string | null {
  const errors = body?.['errors'];
  if (!Array.isArray(errors)) return null;
  const first = errors[0] as { detail?: unknown } | undefined;
  return typeof first?.detail === 'string' ? first.detail.slice(0, 1000) : null;
}

/** One change as the browser sees it (never the idempotency key, tokens or the client's details). */
export function toChangeDto(row: BookingChangeRow, teamNames: ReadonlyMap<string, string>, now: Date = new Date()): BookingChangeDto {
  const words = bookingChangeStatusWords(row.status);
  const startAt = row.request.startAt ? new Date(row.request.startAt) : null;
  const refused = row.status === 'rejected' || row.status === 'not_allowed' || row.status === 'changed_in_square';
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    statusLabel: words.label,
    pill: words.pill,
    done: words.done,
    statusMessage: row.statusMessage,
    squareDetail: refused ? squareDetail(row.squareResponse ?? null) : null,
    freshSlots: row.status === 'slot_unavailable' && row.freshSlots ? row.freshSlots.map((s) => slotDto(s, teamNames, now)) : null,
    bookingId: row.bookingId,
    startLabel: startAt ? changeTimeLabel(startAt, row.request.durationMinutes, now) : null,
    createdAt: row.createdAt.toISOString(),
    createdLabel: formatDateTime(row.createdAt),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    selfTest: row.selfTestId !== null,
    canWithdraw: row.status === 'queued',
  };
}
