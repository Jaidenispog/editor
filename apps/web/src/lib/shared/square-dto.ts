import type { Attendance, ChecklistMark, SquareServiceLabel } from '@studio/core';

/**
 * Square appointments data as the browser sees it (design §8). Square stays the source of truth: every status is
 * Square's own word, derived attendance says "estimate" or who marked it, and no token, secret or Square note
 * reaches staff. Dates are ISO UTC with a Melbourne `…Label` beside them.
 */

/** One line of the booking-changes checklist (Tier 1). */
export interface Tier1LineDto {
  key: 'plan' | 'scopes' | 'bookableService' | 'selfTest' | 'switch';
  label: string;
  mark: ChecklistMark;
  explanation: string;
}

/** A Square service variation with its "can be booked from here" label. */
export interface SquareServiceDto {
  variationId: string;
  name: string;
  durationMinutes: number | null;
  /** AUD, from Square's catalogue (the studio's own price, not a Square plan price). */
  priceLabel: string | null;
  label: SquareServiceLabel;
  labelReason: string;
  teamMemberIds: string[];
  teamMemberNames: string[];
  /** The owner confirmed "no no-show fee" at the current Square version. */
  confirmed: boolean;
}

/** A barber Square lists for booking. */
export interface SquareTeamMemberDto {
  id: string;
  displayName: string;
  isBookable: boolean;
}

/** The Square card and the Appointments page header. */
export interface SquareStatusDto {
  state: 'not_configured' | 'not_connected' | 'connected' | 'needs_reauth' | 'error';
  liveMode: 'sandbox' | 'live' | null;
  environment: 'sandbox' | 'production';
  /** Data shown is from this environment (the connection's), which can differ from the server's after a switch. */
  dataEnvironment: 'sandbox' | 'production' | null;
  /** Names of missing server settings (never values). */
  missingEnv: string[];
  /** Plain reason when the owner must reconnect, or an error to show. */
  message: string | null;
  merchantName: string | null;
  needsLocation: boolean;
  locations: Array<{ id: string; name: string; timezone: string | null }>;
  locationId: string | null;
  /** Shown when Square's location time zone is not Melbourne. */
  timezoneWarning: string | null;
  lastSyncAt: string | null;
  lastSyncLabel: string | null;
  stale: boolean;
  webhooks: 'off' | 'ok' | 'quiet' | 'waiting';
  lastWebhookLabel: string | null;
  bookingSiteUrl: string | null;
  dashboardUrl: string | null;
  tier1: { available: boolean; ready: boolean; summary: string; lines: Tier1LineDto[] };
  services: SquareServiceDto[];
  teamMembers: SquareTeamMemberDto[];
  /** The latest sync job, for progress while the first sync runs. */
  sync: { jobId: string; status: string; progress: number; message: string } | null;
  /** The viewer may change the connection (the owner). */
  canManage: boolean;
  /** Owner-only technical details (Settings disclosure). Never tokens. */
  details: { merchantId: string | null; scopes: string[]; tokenExpiresLabel: string | null } | null;
  /** After a disconnect: whether Square confirmed that the app's access was revoked (design §6), or null. */
  revoke: SquareRevokeDto | null;
}

/** The outcome of the `square.revoke` job after the latest disconnect. */
export interface SquareRevokeDto {
  state: 'pending' | 'revoked' | 'failed';
  message: string;
}

/** One booking in a list. */
export interface BookingDto {
  id: string;
  startAt: string;
  endAt: string;
  /** Melbourne day `YYYY-MM-DD` (for grouping). */
  dayKey: string;
  dayLabel: string;
  timeRangeLabel: string;
  clientName: string;
  customerId: string | null;
  serviceName: string;
  teamMemberName: string;
  /** Square's status, verbatim. */
  status: string;
  statusLabel: string;
  statusExplanation: string | null;
  attendance: Attendance;
  attendanceLabel: string;
  /** True when the attendance is Studio Assistant's estimate (not Square's status or a person's mark). */
  attendanceIsEstimate: boolean;
  missingFromSquare: boolean;
  /** Attended / Didn't attend may be pressed (with the reason when not). */
  attendanceMark: { allowed: boolean; reason: string | null; current: 'attended' | 'not_attended' | null };
  /** Past bookings: the latest review request for this booking (design §9.1 badge, links to Reviews), or null. */
  reviewRequest: { status: string; label: string } | null;
}

/** A booking with everything the detail dialog shows. */
export interface BookingDetailDto extends BookingDto {
  /** Owner only. */
  customerNote: string | null;
  /** Owner only. */
  sellerNote: string | null;
  createdIn: string;
  evidence: { paymentId: string; confidence: string; signals: string[] } | null;
  deepLink: { url: string | null; instruction: string };
  clientEmail: string | null;
  clientPhone: string | null;
}

/** One client copied from Square. Email and phone are for the owner only. */
export interface ClientDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** A client with their bookings. */
export interface ClientDetailDto extends ClientDto {
  bookings: BookingDto[];
}

/** One free time from an availability search. */
export interface AvailabilitySlotDto {
  startAt: string;
  dayKey: string;
  dayLabel: string;
  startLabel: string;
  endLabel: string;
  teamMemberId: string;
  teamMemberName: string;
  durationMinutes: number;
}

/** An availability search and its results. */
export interface AvailabilitySearchDto {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  slots: AvailabilitySlotDto[];
  fetchedAt: string | null;
  fetchedLabel: string | null;
  /** Results older than 5 minutes are shown greyed with "Check again". */
  stale: boolean;
  error: string | null;
}

/** Square statuses after which nobody may mark attendance (Square's own word wins). */
const FINAL_SQUARE_STATUSES: Record<string, string> = {
  NO_SHOW: 'Square says this was a no-show. Change it in Square first.',
  CANCELLED_BY_CUSTOMER: 'Square says the client cancelled. Change it in Square first.',
  CANCELLED_BY_SELLER: 'Square says the studio cancelled. Change it in Square first.',
  DECLINED: 'Square says this request was declined. Change it in Square first.',
};

/**
 * Whether Attended / Didn't attend may be set: only for ACCEPTED bookings that have started (design §4.7). Used by
 * the attendance route (409 otherwise) and to disable the buttons with the same reason.
 */
export function attendanceMarkAllowed(status: string, startAt: Date | string, now: Date = new Date()): { allowed: boolean; reason: string | null } {
  const final = FINAL_SQUARE_STATUSES[status];
  if (final) return { allowed: false, reason: final };
  if (status !== 'ACCEPTED') return { allowed: false, reason: 'Accept or decline this request in Square first.' };
  if (new Date(startAt).getTime() > now.getTime()) return { allowed: false, reason: 'This appointment hasn’t started yet.' };
  return { allowed: true, reason: null };
}
