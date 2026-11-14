import { z } from 'zod';
import type { IntegrationState } from './integrations.js';
import { addDaysToDate, isMelbourneDate, melbourneDayRange, type MelbourneDate } from './time.js';

/**
 * Square Appointments (Stage C, design `docs/design/square-appointments.md`). Square stays the source of truth: this
 * module mirrors bookings, customers and services, keeps a labelled attendance estimate and the owner's own marks,
 * and never sends a message. Everything here is pure (no database, no network) so it is unit tested and shared by the
 * web app and the worker.
 */

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/** Square environments. `sandbox` is Square's test environment (test bookings and test clients only). */
export const SQUARE_ENVIRONMENTS = ['sandbox', 'production'] as const;
export const SquareEnvironmentSchema = z.enum(SQUARE_ENVIRONMENTS);
export type SquareEnvironmentName = z.infer<typeof SquareEnvironmentSchema>;

/**
 * Booking changes from Studio Assistant (Tier 1) stay switched off in code until the sandbox smoke test (design
 * §11.3) has recorded Square's real answers for fee-protected services and the error mapping is updated. Reads,
 * webhooks and the attendance estimate (Tier 0) do not depend on it.
 */
export const SQUARE_TIER1_AVAILABLE = false as boolean;

/**
 * Square Appointments plans as far as the research could confirm them (memo §6). Prices stay null until verified on
 * the owner's own account, so no price is ever shown as fact.
 */
export const SQUARE_PLAN_FACTS = {
  free: { label: 'Free', audPerLocationMonthly: null, writesViaApi: false },
  plus: { label: 'Plus', audPerLocationMonthly: null, writesViaApi: true },
  premium: { label: 'Premium', audPerLocationMonthly: null, writesViaApi: true },
  verifiedAt: null,
  source: 'memo §6, search summary',
} as const;

/** Read permissions requested when the owner connects (memo §6). */
export const SQUARE_READ_SCOPES = [
  'APPOINTMENTS_READ',
  'APPOINTMENTS_ALL_READ',
  'APPOINTMENTS_BUSINESS_SETTINGS_READ',
  'CUSTOMERS_READ',
  'ITEMS_READ',
  'MERCHANT_PROFILE_READ',
  'PAYMENTS_READ',
  'ORDERS_READ',
] as const;
/** Extra permissions needed only for booking changes (Tier 1). */
export const SQUARE_WRITE_SCOPES = ['APPOINTMENTS_WRITE', 'APPOINTMENTS_ALL_WRITE'] as const;

/** The permissions to ask Square for: read access, or read plus booking changes. */
export function squareScopes(access: 'read' | 'write'): string[] {
  return access === 'write' ? [...SQUARE_READ_SCOPES, ...SQUARE_WRITE_SCOPES] : [...SQUARE_READ_SCOPES];
}

/** True when every read permission is granted. */
export function hasSquareReadScopes(scopes: readonly string[]): boolean {
  return SQUARE_READ_SCOPES.every((s) => scopes.includes(s));
}

/** True when both booking-change permissions are granted. */
export function hasSquareWriteScopes(scopes: readonly string[]): boolean {
  return SQUARE_WRITE_SCOPES.every((s) => scopes.includes(s));
}

/** Square's OAuth and API hosts per environment (Square OAuth spec; `connect.squareup.com` serves both). */
export const SQUARE_HOSTS: Record<SquareEnvironmentName, string> = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

/** Square bookings are listed in windows of at most 31 days (ListBookings `start_at_max` limit). */
export const SQUARE_BOOKING_WINDOW_DAYS = 31;
/** A connected account whose last successful sync is older than this is shown as "may be out of date". */
export const SQUARE_STALE_AFTER_MS = 30 * 60_000;
/** No webhook for this long while webhooks are set up: "check the subscription". */
export const SQUARE_WEBHOOK_QUIET_AFTER_MS = 3 * 24 * 3600_000;
/** An ACCEPTED booking that ended longer ago than this without a payment match is "No payment found". */
export const SQUARE_PAYMENT_GIVE_UP_MS = 7 * 24 * 3600_000;
/** Payment matching window around a booking (decisions-summary Square Tier 0). */
export const SQUARE_MATCH_BEFORE_START_MS = 30 * 60_000;
export const SQUARE_MATCH_AFTER_END_MS = 3 * 3600_000;
/** Longest availability search the finder offers (Square allows up to 32 days per search). */
export const SQUARE_AVAILABILITY_MAX_DAYS = 14;

/**
 * Where the owner does what the API cannot (no-show marking, deposits, accepting requests, fee-bearing services).
 * Square does not document Dashboard deep-link paths (⚠), so these are the documented Dashboard home and a one-line
 * instruction; they are confirmed with the owner during set-up.
 */
export const SQUARE_DASHBOARD_URL: Record<SquareEnvironmentName, string | null> = {
  production: 'https://app.squareup.com/dashboard/',
  // The sandbox dashboard opens only from the Developer Console's "Sandbox test accounts" page.
  sandbox: null,
};

/** One-line instructions shown next to "Open in Square". */
export const SQUARE_IN_SQUARE_INSTRUCTIONS = {
  booking: 'In Square: Appointments → Calendar → open the booking.',
  noShow: 'In Square: Appointments → Calendar → open the booking → Mark as no-show.',
  accept: 'In Square: Appointments → Calendar → open the request → Accept or Decline.',
  sandbox: 'Open your sandbox test account’s dashboard from the Square Developer Console.',
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Stored JSON contracts (integration_connections.config / capabilities for provider `square`)
// ---------------------------------------------------------------------------------------------------------------

const MoneySchema = z.object({ amount: z.string(), currency: z.string() });
export type SquareMoney = z.infer<typeof MoneySchema>;

export const SquareLocationSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string().nullable(),
  status: z.string(),
  bookingSiteUrl: z.string().nullable(),
});
export type SquareLocationSnapshot = z.infer<typeof SquareLocationSnapshotSchema>;

export const SquareBusinessProfileSnapshotSchema = z.object({
  bookingEnabled: z.boolean().nullable(),
  bookingPolicy: z.string().nullable(),
  allowUserCancel: z.boolean().nullable(),
  supportSellerLevelWrites: z.boolean(),
  cancellationWindowSeconds: z.number().nullable(),
  cancellationFee: MoneySchema.nullable(),
  cancellationPolicy: z.string().nullable(),
  minLeadSeconds: z.number().nullable(),
  maxLeadSeconds: z.number().nullable(),
});
export type SquareBusinessProfileSnapshot = z.infer<typeof SquareBusinessProfileSnapshotSchema>;

export const SquareServiceSnapshotSchema = z.object({
  itemId: z.string(),
  itemName: z.string(),
  variationId: z.string(),
  variationName: z.string(),
  /** Square's int64 version as a string. */
  version: z.string(),
  durationMinutes: z.number().nullable(),
  price: MoneySchema.nullable(),
  availableForBooking: z.boolean(),
  teamMemberIds: z.array(z.string()),
  archived: z.boolean(),
  /** A `no_show_fee` Square sent on the variation (not in Square's documented schema, so usually null). */
  noShowFeeSeen: MoneySchema.nullable(),
});
export type SquareServiceSnapshot = z.infer<typeof SquareServiceSnapshotSchema>;

export const SquareTeamMemberSnapshotSchema = z.object({ id: z.string(), displayName: z.string(), isBookable: z.boolean() });
export type SquareTeamMemberSnapshot = z.infer<typeof SquareTeamMemberSnapshotSchema>;

export const SquareSnapshotSchema = z.object({
  fetchedAt: z.string(),
  merchantName: z.string(),
  locations: z.array(SquareLocationSnapshotSchema),
  businessProfile: SquareBusinessProfileSnapshotSchema.nullable(),
  teamMembers: z.array(SquareTeamMemberSnapshotSchema),
  services: z.array(SquareServiceSnapshotSchema),
});
export type SquareSnapshot = z.infer<typeof SquareSnapshotSchema>;

export const SquareServiceConfirmationSchema = z.object({ version: z.string(), confirmedBy: z.string(), confirmedAt: z.string() });
export const SquareServiceRejectionSchema = z.object({ changeId: z.string(), code: z.string(), at: z.string() });

/** `integration_connections.config` for provider `square`. */
export const SquareConnectionConfigSchema = z.object({
  environment: SquareEnvironmentSchema.default('sandbox'),
  locationId: z.string().nullable().default(null),
  snapshot: SquareSnapshotSchema.nullable().default(null),
  serviceConfirmations: z.record(z.string(), SquareServiceConfirmationSchema).default({}),
  serviceWriteRejections: z.record(z.string(), SquareServiceRejectionSchema).default({}),
  lastWebhookAt: z.string().nullable().default(null),
  /** Incremental customer sync watermark. */
  customersSyncedAt: z.string().nullable().default(null),
});
export type SquareConnectionConfig = z.infer<typeof SquareConnectionConfigSchema>;

/** Reads a stored config defensively: anything unreadable becomes the empty default (nothing is invented). */
export function parseSquareConfig(raw: unknown): SquareConnectionConfig {
  const parsed = SquareConnectionConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const env = SquareEnvironmentSchema.safeParse((raw as { environment?: unknown } | null)?.environment);
  return SquareConnectionConfigSchema.parse({ environment: env.success ? env.data : 'sandbox' });
}

/** Why booking changes were paused by the worker (empty when not paused). */
export const SQUARE_SUSPENSION_REASONS = ['', 'plan', 'scopes', 'forbidden', 'env_changed'] as const;
export type SquareSuspensionReason = (typeof SQUARE_SUSPENSION_REASONS)[number];

/** `integration_connections.capabilities` for provider `square` (only the keys this module reads). */
export interface SquareCapabilities {
  readScopesOk: boolean | null;
  writeScopesOk: boolean | null;
  /** `BusinessBookingProfile.support_seller_level_writes` from the last snapshot (null = not read yet). */
  sellerLevelWrites: boolean | null;
  /** The owner's switch for booking changes (Tier 1). */
  writesEnabled: boolean;
  writesSuspendedReason: SquareSuspensionReason;
  selfTestStatus: 'none' | 'running' | 'passed' | 'failed';
  /** The latest self-test (WP6b) and when it finished. */
  selfTestId: string | null;
  selfTestAt: string | null;
  selfTestEnvironment: string | null;
  selfTestMerchantId: string | null;
  /** Plain reason the latest self-test failed (empty when it did not). */
  selfTestFailure: string | null;
  squareNotifiesApiBookings: 'yes' | 'no' | 'unknown';
  /** The location's Square time zone when it is not Australia/Melbourne. */
  locationTimezone: string | null;
}

/** Reads stored capabilities with safe defaults. */
export function parseSquareCapabilities(raw: Record<string, unknown> | null | undefined): SquareCapabilities {
  const c = raw ?? {};
  const bool = (k: string): boolean | null => (typeof c[k] === 'boolean' ? (c[k] as boolean) : null);
  const str = (k: string): string | null => (typeof c[k] === 'string' && c[k] !== '' ? (c[k] as string) : null);
  const reason = str('writesSuspendedReason');
  const selfTest = str('selfTestStatus');
  const notifies = str('squareNotifiesApiBookings');
  return {
    readScopesOk: bool('readScopesOk'),
    writeScopesOk: bool('writeScopesOk'),
    sellerLevelWrites: bool('sellerLevelWrites'),
    writesEnabled: c['writesEnabled'] === true,
    writesSuspendedReason: (SQUARE_SUSPENSION_REASONS as readonly string[]).includes(reason ?? '') ? ((reason ?? '') as SquareSuspensionReason) : '',
    selfTestStatus: selfTest === 'running' || selfTest === 'passed' || selfTest === 'failed' ? selfTest : 'none',
    selfTestId: str('selfTestId'),
    selfTestAt: str('selfTestAt'),
    selfTestEnvironment: str('selfTestEnvironment'),
    selfTestMerchantId: str('selfTestMerchantId'),
    selfTestFailure: str('selfTestFailure'),
    squareNotifiesApiBookings: notifies === 'yes' || notifies === 'no' ? notifies : 'unknown',
    locationTimezone: str('locationTimezone'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Services and the per-service label (design §4.3)
// ---------------------------------------------------------------------------------------------------------------

export const SERVICE_LABELS = ['bookable', 'needs_confirmation', 'book_in_square', 'unverified', 'not_bookable'] as const;
export type SquareServiceLabel = (typeof SERVICE_LABELS)[number];

/** A non-zero amount of money (Square int64 amounts are stored as strings). */
function nonZero(m: SquareMoney | null | undefined): boolean {
  if (!m) return false;
  try {
    return BigInt(m.amount) !== 0n;
  } catch {
    return true;
  }
}

/**
 * The per-service label: whether Studio Assistant could book this service (Tier 1) or it must be booked in Square.
 * Absence of a `no_show_fee` proves nothing (Square's schema cannot show per-service fees), so a service is only
 * `bookable` once the owner has confirmed it at the current Square version.
 */
export function classifyVariation(
  service: SquareServiceSnapshot,
  businessProfile: SquareBusinessProfileSnapshot | null,
  confirmations: SquareConnectionConfig['serviceConfirmations'],
  rejections: SquareConnectionConfig['serviceWriteRejections'],
): { label: SquareServiceLabel; reason: string } {
  if (nonZero(service.noShowFeeSeen)) {
    return { label: 'book_in_square', reason: 'Book in Square — this service has a no-show fee, which Square doesn’t allow apps to book.' };
  }
  const rejected = rejections[service.variationId];
  if (rejected) {
    // Square refused a change for it without saying why: the cause is not known, so no fee is claimed.
    return { label: 'book_in_square', reason: `Book in Square — Square refused a change for this service (code ${rejected.code.slice(0, 60)}). Check it in Square, then confirm it again.` };
  }
  if (nonZero(businessProfile?.cancellationFee)) {
    return { label: 'unverified', reason: 'Not available from here — your Square no-show fee applies to every appointment. Book in Square.' };
  }
  if (!service.availableForBooking || service.archived || service.teamMemberIds.length === 0) {
    return { label: 'not_bookable', reason: 'Not open for booking in Square.' };
  }
  const confirmed = confirmations[service.variationId];
  if (!confirmed || confirmed.version !== service.version) {
    return { label: 'needs_confirmation', reason: 'Confirm in Square that this service has no no-show fee.' };
  }
  return { label: 'bookable', reason: 'Bookable from Studio Assistant.' };
}

/** Reads a `no_show_fee` Square may send as an undocumented passthrough field, in either casing. */
export function noShowFeeFrom(variation: Record<string, unknown> | null | undefined): SquareMoney | null {
  const v = variation ?? {};
  const fee = (v['noShowFee'] ?? v['no_show_fee']) as { amount?: unknown; currency?: unknown } | undefined;
  if (!fee || typeof fee !== 'object') return null;
  const amount = typeof fee.amount === 'bigint' || typeof fee.amount === 'number' || typeof fee.amount === 'string' ? String(fee.amount) : null;
  if (amount === null) return null;
  return { amount, currency: typeof fee.currency === 'string' ? fee.currency : 'AUD' };
}

// ---------------------------------------------------------------------------------------------------------------
// Booking changes checklist (Tier 1; the changes themselves are in square-changes.ts)
// ---------------------------------------------------------------------------------------------------------------

export type ChecklistMark = 'ok' | 'missing' | 'unknown';

/** Whether booking changes from Studio Assistant are possible, and why not. */
export interface SquareTier1Status {
  /** Booking changes are built and switched on in this version of Studio Assistant. */
  available: boolean;
  ready: boolean;
  checklist: { plan: ChecklistMark; scopes: ChecklistMark; bookableService: ChecklistMark; selfTest: ChecklistMark; switch: ChecklistMark };
  suspendedReason: SquareSuspensionReason;
}

/**
 * The Tier 1 checklist (design §4.5) from stored facts. Never ready while {@link SQUARE_TIER1_AVAILABLE} is false;
 * `available` exists only so tests can exercise the switched-on path (production code never passes it).
 */
export function tier1Status(input: {
  capabilities: SquareCapabilities;
  config: SquareConnectionConfig;
  scopes: readonly string[];
  environment: SquareEnvironmentName;
  merchantId: string | null;
  available?: boolean | undefined;
}): SquareTier1Status {
  const available = input.available ?? SQUARE_TIER1_AVAILABLE;
  const { capabilities: c, config } = input;
  const plan: ChecklistMark = c.sellerLevelWrites === null ? 'unknown' : c.sellerLevelWrites ? 'ok' : 'missing';
  const scopes: ChecklistMark = hasSquareWriteScopes(input.scopes) ? 'ok' : 'missing';
  const services = config.snapshot?.services ?? [];
  const bookableService: ChecklistMark = !config.snapshot
    ? 'unknown'
    : services.some((s) => classifyVariation(s, config.snapshot?.businessProfile ?? null, config.serviceConfirmations, config.serviceWriteRejections).label === 'bookable')
      ? 'ok'
      : 'missing';
  const selfTest: ChecklistMark =
    c.selfTestStatus === 'passed' && c.selfTestEnvironment === input.environment && c.selfTestMerchantId === input.merchantId ? 'ok' : c.selfTestStatus === 'none' ? 'unknown' : 'missing';
  const sw: ChecklistMark = c.writesEnabled ? 'ok' : 'missing';
  const ready = available && plan === 'ok' && scopes === 'ok' && bookableService === 'ok' && selfTest === 'ok' && sw === 'ok' && c.writesSuspendedReason === '';
  return { available, ready, checklist: { plan, scopes, bookableService, selfTest, switch: sw }, suspendedReason: c.writesSuspendedReason };
}

// ---------------------------------------------------------------------------------------------------------------
// Integration state (design §4.1)
// ---------------------------------------------------------------------------------------------------------------

/** What the Square card and the Appointments page need about the stored connection (never a credential). */
export interface SquareConnectionFacts {
  status: string;
  externalAccountId: string | null;
  scopes: readonly string[];
  config: unknown;
  capabilities: Record<string, unknown> | null | undefined;
  lastSyncAt: Date | string | null;
  lastError: string | null;
}

/** Why the card asks the owner to reconnect. */
export type SquareReauthReason = 'env_changed' | 'scopes' | 'token' | null;

export interface SquareIntegrationStateResult {
  state: Extract<IntegrationState, 'not_configured' | 'not_connected' | 'connected' | 'needs_reauth' | 'error'>;
  liveMode: 'sandbox' | 'live' | null;
  environment: SquareEnvironmentName;
  reauthReason: SquareReauthReason;
  needsLocation: boolean;
  /** Connected but the last successful sync is older than 30 minutes (or there has been none yet). */
  stale: boolean;
  /** off = no signature key on the server; ok = a webhook arrived in the last 3 days; quiet = set up but silent; waiting = set up, none yet. */
  webhooks: 'off' | 'ok' | 'quiet' | 'waiting';
  tier1: SquareTier1Status;
}

/**
 * The Square card's state from server settings and the stored connection. The environment switch rule: a connection
 * made in the other environment needs reconnecting (its data is purged when the owner reconnects).
 */
export function squareIntegrationState(input: {
  envPresent: boolean;
  webhookKeyPresent: boolean;
  environment: SquareEnvironmentName;
  connection: SquareConnectionFacts | null;
  now: Date;
  /** Tests only: overrides {@link SQUARE_TIER1_AVAILABLE}. */
  tier1Available?: boolean | undefined;
}): SquareIntegrationStateResult {
  const conn = input.connection;
  const config = parseSquareConfig(conn?.config);
  const capabilities = parseSquareCapabilities(conn?.capabilities ?? null);
  const tier1 = tier1Status({ capabilities, config, scopes: conn?.scopes ?? [], environment: input.environment, merchantId: conn?.externalAccountId ?? null, available: input.tier1Available });
  const liveMode = input.envPresent ? (input.environment === 'production' ? 'live' : 'sandbox') : null;
  const base = { liveMode, environment: input.environment, tier1 } as const;
  const lastSync = conn?.lastSyncAt ? new Date(conn.lastSyncAt) : null;
  const lastWebhook = config.lastWebhookAt ? new Date(config.lastWebhookAt) : null;
  const webhooks: SquareIntegrationStateResult['webhooks'] = !input.webhookKeyPresent
    ? 'off'
    : !lastWebhook
      ? 'waiting'
      : input.now.getTime() - lastWebhook.getTime() > SQUARE_WEBHOOK_QUIET_AFTER_MS
        ? 'quiet'
        : 'ok';
  const quiet = { reauthReason: null, needsLocation: false, stale: false, webhooks };
  if (!input.envPresent) return { ...base, ...quiet, state: 'not_configured' };
  if (!conn || conn.status === 'disconnected' || conn.status === 'not_configured') return { ...base, ...quiet, state: 'not_connected' };
  const stale = !lastSync || input.now.getTime() - lastSync.getTime() > SQUARE_STALE_AFTER_MS;
  if (config.environment !== input.environment) return { ...base, ...quiet, stale, state: 'needs_reauth', reauthReason: 'env_changed' };
  if (conn.status === 'needs_reauth') return { ...base, ...quiet, stale, state: 'needs_reauth', reauthReason: capabilities.readScopesOk === false ? 'scopes' : 'token' };
  if (conn.status === 'error') return { ...base, ...quiet, stale, state: 'error' };
  const active = (config.snapshot?.locations ?? []).filter((l) => l.status === 'ACTIVE');
  const needsLocation = !config.locationId && active.length > 1;
  return { ...base, reauthReason: null, needsLocation, stale, webhooks, state: 'connected' };
}

/** The location the module works with: the owner's choice, else the only active location. */
export function effectiveLocationId(config: SquareConnectionConfig): string | null {
  if (config.locationId) return config.locationId;
  const active = (config.snapshot?.locations ?? []).filter((l) => l.status === 'ACTIVE');
  return active.length === 1 ? (active[0]?.id ?? null) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Booking statuses, attendance and genuine completion (design §4.7)
// ---------------------------------------------------------------------------------------------------------------

/** Square's six booking statuses, mirrored verbatim. Square has no "completed" status. */
export const SQUARE_BOOKING_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'NO_SHOW'] as const;
export type SquareBookingStatus = (typeof SQUARE_BOOKING_STATUSES)[number];

/** Plain label for Square's status (always presented as Square's own fact). Unknown values pass through. */
export function mapBookingStatus(status: string): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; explanation: string | null } {
  switch (status) {
    case 'PENDING':
      return { label: 'Waiting for acceptance', tone: 'warning', explanation: 'Waiting for you to accept — do this in Square.' };
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'success', explanation: null };
    case 'DECLINED':
      return { label: 'Declined', tone: 'warning', explanation: 'You declined this request in Square.' };
    case 'CANCELLED_BY_CUSTOMER':
      return { label: 'Cancelled by client', tone: 'warning', explanation: 'The client cancelled in Square.' };
    case 'CANCELLED_BY_SELLER':
      return { label: 'Cancelled by studio', tone: 'warning', explanation: 'Cancelled by the studio in Square.' };
    case 'NO_SHOW':
      return { label: 'No-show (from Square)', tone: 'danger', explanation: 'Marked as a no-show in Square.' };
    default:
      return { label: `Square status: ${status}`, tone: 'neutral', explanation: null };
  }
}

/** Studio Assistant's view of whether a booking happened (`bookings.attendance`). */
export const ATTENDANCE_VALUES = [
  'upcoming',
  'pending',
  'cancelled',
  'declined',
  'no_show',
  'awaiting_payment',
  'payment_matched',
  'possible_match',
  'no_payment_matched',
  'owner_attended',
  'owner_not_attended',
  /** A Square status this version does not know; shown as Square's own word. */
  'other',
] as const;
export type Attendance = (typeof ATTENDANCE_VALUES)[number];

/** The owner's (or a barber's) own mark. */
export const OwnerAttendanceSchema = z.enum(['attended', 'not_attended']);
export type OwnerAttendance = z.infer<typeof OwnerAttendanceSchema>;

/** The strongest payment evidence found for one booking. */
export interface PaymentMatch {
  kind: 'strong' | 'weak';
  paymentId: string;
  score: number;
  signals: string[];
  confidence: 'high' | 'medium' | 'low';
}

/** What attendance and completion are derived from. */
export interface AttendanceInput {
  status: string;
  endAt: Date;
  ownerAttendance: OwnerAttendance | null;
  missingFromSquareAt: Date | null;
  match: PaymentMatch | null;
}

/**
 * Attendance from Square's status, the payment evidence and the owner's mark. Square's cancellations and no-shows
 * always win; the owner's mark wins over the estimate; time passing alone never means "attended".
 */
export function deriveAttendance(b: AttendanceInput, now: Date): Attendance {
  switch (b.status) {
    case 'PENDING':
      return 'pending';
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_SELLER':
      return 'cancelled';
    case 'DECLINED':
      return 'declined';
    case 'NO_SHOW':
      return 'no_show';
    case 'ACCEPTED':
      break;
    default:
      return 'other';
  }
  if (b.ownerAttendance === 'attended') return 'owner_attended';
  if (b.ownerAttendance === 'not_attended') return 'owner_not_attended';
  if (b.endAt.getTime() > now.getTime()) return 'upcoming';
  if (b.match?.kind === 'strong') return 'payment_matched';
  if (b.match?.kind === 'weak') return 'possible_match';
  return now.getTime() - b.endAt.getTime() < SQUARE_PAYMENT_GIVE_UP_MS ? 'awaiting_payment' : 'no_payment_matched';
}

/** The stored completion columns for a booking. */
export interface CompletionResult {
  completed: boolean;
  source: 'none' | 'payment' | 'owner_marked';
  completedAt: Date | null;
}

/**
 * Decides genuine completion (what `bookings.completed_at` / `completion_source` store): Square still shows the
 * booking as ACCEPTED, it has ended, it still exists in Square, and either the owner marked it attended or a strong
 * payment match exists. Becoming false resets the source to `none`. Consumers check the stored values with
 * `isGenuinelyCompleted` (completion.ts). Sandbox bookings are test data and never complete (attendance is still
 * labelled, so the owner can try the screens), so test data can never start a real email.
 */
export function deriveCompletion(
  b: { status: string; endAt: Date; missingFromSquareAt: Date | null; ownerAttendance: OwnerAttendance | null; attendance: Attendance; completedAt?: Date | null; environment: string },
  now: Date,
): CompletionResult {
  const completed =
    b.environment === 'production' &&
    b.status === 'ACCEPTED' &&
    b.endAt.getTime() <= now.getTime() &&
    b.missingFromSquareAt === null &&
    b.ownerAttendance !== 'not_attended' &&
    (b.ownerAttendance === 'attended' || b.attendance === 'payment_matched');
  if (!completed) return { completed: false, source: 'none', completedAt: null };
  return { completed: true, source: b.ownerAttendance === 'attended' ? 'owner_marked' : 'payment', completedAt: b.completedAt ?? now };
}

/** Plain label for an attendance value. Derived values say "estimate"; owner marks say who and when. */
export function attendanceLabel(a: Attendance, opts: { status?: string; markedBy?: string | null; markedAt?: string | null; confidence?: string | null } = {}): string {
  switch (a) {
    case 'upcoming':
      return 'Upcoming';
    case 'pending':
      return 'Waiting for acceptance in Square';
    case 'cancelled':
      return opts.status === 'CANCELLED_BY_SELLER' ? 'Cancelled by studio' : 'Cancelled by client';
    case 'declined':
      return 'Declined';
    case 'no_show':
      return 'No-show (from Square)';
    case 'awaiting_payment':
      return 'Finished? Waiting for a Square payment';
    case 'payment_matched':
      return `Paid — matched to a Square payment (estimate${opts.confidence ? `, ${opts.confidence} confidence` : ''})`;
    case 'possible_match':
      return 'Possible payment found — please confirm';
    case 'no_payment_matched':
      return 'No payment found — did they attend?';
    case 'owner_attended':
      return `Attended — marked${opts.markedBy ? ` by ${opts.markedBy}` : ''}${opts.markedAt ? `, ${opts.markedAt}` : ''}`;
    case 'owner_not_attended':
      return `Didn’t attend — marked${opts.markedBy ? ` by ${opts.markedBy}` : ''}${opts.markedAt ? `, ${opts.markedAt}` : ''}`;
    default:
      return mapBookingStatus(opts.status ?? '').label;
  }
}

/** Attendance values still waiting for the owner's word ("To confirm" tab). */
export const ATTENDANCE_TO_CONFIRM: readonly Attendance[] = ['awaiting_payment', 'possible_match', 'no_payment_matched'];

// ---------------------------------------------------------------------------------------------------------------
// Payment matching (heuristic, labelled as an estimate)
// ---------------------------------------------------------------------------------------------------------------

/** A mirrored booking as the matcher sees it. */
export interface MatchBooking {
  id: string;
  locationId: string;
  squareCustomerId: string | null;
  teamMemberId: string | null;
  serviceVariationId: string | null;
  startAt: Date;
  endAt: Date;
}

/** A Square payment as the matcher sees it (amounts in the smallest unit, as strings). */
export interface MatchPayment {
  id: string;
  status: string;
  locationId: string | null;
  customerId: string | null;
  teamMemberId: string | null;
  orderId: string | null;
  createdAt: Date;
  squareProduct: string | null;
  totalAmount: string | null;
  refundedAmount: string | null;
}

function amountOf(v: string | null): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Matches Square payments to bookings (the decisions-summary heuristic, an estimate). A candidate payment is
 * COMPLETED, at the same location, created within [start − 30 min, end + 3 h] and not fully refunded. The same
 * customer is required for a strong match (confidence high with a second signal, else medium); without it, a team
 * member or service match is only weak ("possible payment"). Each payment counts for one booking at most: the
 * highest score wins, the earliest start breaks ties, and the bookings that lose a strong payment become possible
 * matches. `orderLines` maps an order id to its line items' catalogue object ids.
 */
export function matchPayments(bookings: readonly MatchBooking[], payments: readonly MatchPayment[], orderLines: Readonly<Record<string, readonly string[]>> = {}): Map<string, PaymentMatch> {
  const out = new Map<string, PaymentMatch>();
  const offer = (bookingId: string, m: PaymentMatch) => {
    const prev = out.get(bookingId);
    const rank = (x: PaymentMatch) => (x.kind === 'strong' ? 1000 : 0) + x.score;
    if (!prev || rank(m) > rank(prev)) out.set(bookingId, m);
  };
  for (const p of payments) {
    if (p.status !== 'COMPLETED') continue;
    const total = amountOf(p.totalAmount);
    if (amountOf(p.refundedAmount) >= total && total > 0n) continue;
    const at = p.createdAt.getTime();
    const candidates: Array<{ b: MatchBooking; strong: boolean; score: number; signals: string[] }> = [];
    for (const b of bookings) {
      if (!p.locationId || b.locationId !== p.locationId) continue;
      if (at < b.startAt.getTime() - SQUARE_MATCH_BEFORE_START_MS || at > b.endAt.getTime() + SQUARE_MATCH_AFTER_END_MS) continue;
      const signals: string[] = [];
      const strong = Boolean(p.customerId && b.squareCustomerId && p.customerId === b.squareCustomerId);
      if (strong) signals.push('customer');
      if (p.squareProduct === 'APPOINTMENTS') signals.push('appointments_payment');
      if (p.teamMemberId && b.teamMemberId && p.teamMemberId === b.teamMemberId) signals.push('team_member');
      if (p.orderId && b.serviceVariationId && (orderLines[p.orderId] ?? []).includes(b.serviceVariationId)) signals.push('service');
      const extra = signals.filter((s) => s !== 'customer').length;
      if (!strong && !signals.includes('team_member') && !signals.includes('service')) continue;
      candidates.push({ b, strong, score: (strong ? 10 : 0) + extra, signals });
    }
    if (!candidates.length) continue;
    const strongOnes = candidates.filter((c) => c.strong).sort((a, b) => b.score - a.score || a.b.startAt.getTime() - b.b.startAt.getTime());
    const winner = strongOnes[0];
    if (winner) {
      const extra = winner.signals.length - 1;
      offer(winner.b.id, { kind: 'strong', paymentId: p.id, score: winner.score, signals: winner.signals, confidence: extra >= 1 ? 'high' : 'medium' });
    }
    for (const c of candidates) {
      if (winner && c.b.id === winner.b.id) continue;
      offer(c.b.id, { kind: 'weak', paymentId: p.id, score: c.score, signals: c.signals, confidence: 'low' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Time ranges (Melbourne, DST-safe)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The SearchAvailability range for `days` Melbourne days from `fromDate`. Square needs at least 24 hours, so a single
 * 23-hour day (clocks go forward) is extended to 24 hours; `filterStart`/`filterEnd` keep the requested Melbourne
 * days so slots outside them are dropped after the call. At most 14 days.
 */
export function availabilityRange(fromDate: MelbourneDate, days: number): { start: Date; end: Date; filterStart: Date; filterEnd: Date } {
  if (!isMelbourneDate(fromDate)) throw new Error(`Not a YYYY-MM-DD date: ${fromDate}`);
  const n = Math.max(1, Math.min(SQUARE_AVAILABILITY_MAX_DAYS, Math.floor(days)));
  const start = melbourneDayRange(fromDate).start;
  const filterEnd = melbourneDayRange(addDaysToDate(fromDate, n - 1)).end;
  const end = filterEnd.getTime() - start.getTime() < 24 * 3600_000 ? new Date(start.getTime() + 24 * 3600_000) : filterEnd;
  return { start, end, filterStart: start, filterEnd };
}

/** Splits [start, end) into consecutive windows of at most 31 days (ListBookings limit). */
export function bookingWindows(start: Date, end: Date): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const max = SQUARE_BOOKING_WINDOW_DAYS * 24 * 3600_000;
  for (let s = start.getTime(); s < end.getTime(); s += max) out.push({ start: new Date(s), end: new Date(Math.min(s + max, end.getTime())) });
  return out;
}

/** The booking range a sync reads: a short one every 10 minutes, a wide one on connect and the nightly reconcile. */
export function syncRange(reason: 'connect' | 'schedule' | 'manual' | 'reconcile', now: Date): { start: Date; end: Date } {
  const day = 24 * 3600_000;
  if (reason === 'connect' || reason === 'reconcile') return { start: new Date(now.getTime() - 31 * day), end: new Date(now.getTime() + 62 * day) };
  // The last two hours and the following 31 days, as one ListBookings window (Square's limit is 31 days per call).
  const start = now.getTime() - 2 * 3600_000;
  return { start: new Date(start), end: new Date(start + SQUARE_BOOKING_WINDOW_DAYS * day) };
}

/** A booking's end: start plus every segment's duration (and intermission). */
export function bookingEndAt(startAt: Date, segments: ReadonlyArray<{ durationMinutes?: number | null; intermissionMinutes?: number | null }>): Date {
  const minutes = segments.reduce((sum, s) => sum + (s.durationMinutes ?? 0) + (s.intermissionMinutes ?? 0), 0);
  return new Date(startAt.getTime() + minutes * 60_000);
}

/** True for an RFC 3339 instant with an explicit offset (Square never sends local times). */
export function isRfc3339Instant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------------------------------------------
// Error mapping (design §7.5)
// ---------------------------------------------------------------------------------------------------------------

export type SquareErrorKind = 'reauth' | 'not_allowed' | 'conflict' | 'invalid' | 'rate_limited' | 'transient' | 'not_found';

/** A Square error body entry (`errors[]`). */
export interface SquareErrorEntry {
  category?: string;
  code?: string;
  detail?: string;
}

const REAUTH_CODES = new Set(['UNAUTHORIZED', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_REVOKED', 'CLIENT_DISABLED', 'APPLICATION_DISABLED']);
const PLAN_CODES = new Set(['FORBIDDEN', 'MERCHANT_SUBSCRIPTION_NOT_FOUND']);
const TRANSIENT_CODES = new Set(['INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'GATEWAY_TIMEOUT']);

/**
 * Maps a Square failure to what the module does about it. `op` matters only for missing permissions: a read without
 * them needs reconnecting, a write is "not allowed". A missing status (network failure, time-out) is transient.
 */
export function mapSquareError(input: { statusCode?: number | null; errors?: readonly SquareErrorEntry[] | null }, op: 'read' | 'write' = 'read'): { kind: SquareErrorKind; code: string; message: string } {
  const first = input.errors?.[0];
  const code = first?.code ?? (input.statusCode ? `HTTP_${input.statusCode}` : 'NETWORK');
  const status = input.statusCode ?? 0;
  if (REAUTH_CODES.has(code) || status === 401) return { kind: 'reauth', code, message: 'Square needs you to reconnect.' };
  if (code === 'INSUFFICIENT_SCOPES') {
    return op === 'write'
      ? { kind: 'not_allowed', code, message: 'Studio Assistant doesn’t have permission for this. Reconnect and approve the permissions.' }
      : { kind: 'reauth', code, message: 'Studio Assistant doesn’t have permission for this. Reconnect and approve the permissions.' };
  }
  if (PLAN_CODES.has(code) || first?.category === 'MERCHANT_SUBSCRIPTION_ERROR' || status === 403) {
    return { kind: 'not_allowed', code, message: 'Square refused because of your Appointments plan.' };
  }
  if (code === 'NOT_FOUND' || status === 404) return { kind: 'not_found', code, message: 'Square no longer has this.' };
  if (code === 'CONFLICT' || status === 409) return { kind: 'conflict', code, message: 'This changed in Square.' };
  if (code === 'RATE_LIMITED' || status === 429) return { kind: 'rate_limited', code, message: 'Square asked us to slow down. Trying again shortly.' };
  if (TRANSIENT_CODES.has(code) || status >= 500 || status === 0) return { kind: 'transient', code, message: 'Square didn’t answer. Trying again shortly.' };
  return { kind: 'invalid', code, message: first?.detail ? `Square said: ${first.detail}` : `Square refused the request (${code}).` };
}
