import { SquareClient, SquareEnvironment, SquareError, SquareTimeoutError, type Square } from 'square';
import { CancelledError, isRfc3339Instant, mapSquareError, noShowFeeFrom, type MatchPayment, type SquareBusinessProfileSnapshot, type SquareErrorEntry, type SquareErrorKind, type SquareServiceSnapshot } from '@studio/core';

/**
 * The narrow view of Square this module uses (design §7.2), so handlers never touch the SDK directly and tests can
 * point the real SDK at a local fake server. Every call carries the run's AbortSignal, a 20 s time limit and no SDK
 * retries (pg-boss owns retries). The three booking writes (WP6b) are called only by `square/change.ts`, the
 * booking-change routine; everything else only reads.
 */
export interface SquareApi {
  retrieveTokenStatus(): Promise<{ scopes: string[]; expiresAt: string | null; merchantId: string | null }>;
  getMerchantName(merchantId: string): Promise<string>;
  listLocations(): Promise<Array<{ id: string; name: string; timezone: string | null; status: string }>>;
  getBusinessProfile(): Promise<SquareBusinessProfileSnapshot | null>;
  listLocationProfiles(): Promise<Array<{ locationId: string; bookingSiteUrl: string | null }>>;
  listTeamMemberProfiles(locationId: string | null): Promise<Array<{ id: string; displayName: string; isBookable: boolean }>>;
  listServices(): Promise<SquareServiceSnapshot[]>;
  /**
   * Bookings in the range, plus the ids of bookings Square returned that could not be read (a malformed start time):
   * Square still has those, so a sync must never treat them as gone.
   */
  listBookings(input: { locationId: string | null; startAtMin: string; startAtMax: string }): Promise<{ bookings: SquareBookingData[]; skippedIds: string[] }>;
  /**
   * Null only when Square answers NOT_FOUND. A booking Square returned but that could not be read (a malformed start
   * time) is a {@link MalformedSquareBooking}: Square still has it, so it is never marked missing.
   */
  getBooking(bookingId: string): Promise<SquareBookingData | MalformedSquareBooking | null>;
  searchAvailability(filter: { startAt: string; endAt: string; locationId: string; serviceVariationId: string; teamMemberId: string | null }): Promise<SquareSlotData[]>;
  listCustomers(): Promise<SquareCustomerData[]>;
  searchCustomersUpdatedSince(sinceIso: string): Promise<SquareCustomerData[]>;
  /** Null when Square answers NOT_FOUND (the customer was deleted). */
  getCustomer(customerId: string): Promise<SquareCustomerData | null>;
  bulkRetrieveCustomers(customerIds: string[]): Promise<SquareCustomerData[]>;
  listPayments(input: { locationId: string; beginTime: string; endTime: string }): Promise<MatchPayment[]>;
  getPayment(paymentId: string): Promise<MatchPayment | null>;
  /** Order id → catalogue object ids of its line items. */
  batchGetOrderLines(locationId: string, orderIds: string[]): Promise<Record<string, string[]>>;
  /** One service variation read fresh from the catalogue just before a change (null when Square no longer has it). */
  getServiceVariation(variationId: string): Promise<SquareFreshServiceData | null>;
  /** Free times to move an existing booking to (SearchAvailability with the `booking_id` filter). */
  searchAvailabilityForBooking(filter: { startAt: string; endAt: string; bookingId: string }): Promise<SquareSlotData[]>;
  /** CreateBooking (seller level). Only the booking-change routine calls it. */
  createBooking(input: { idempotencyKey: string; locationId: string; startAt: string; customerId: string; sellerNote: string | null; segment: SquareWriteSegment }): Promise<SquareBookingData>;
  /** UpdateBooking: moves a booking to a new start (and segment). Only the booking-change routine calls it. */
  updateBooking(input: { bookingId: string; idempotencyKey: string; version: number; startAt: string; segment: SquareWriteSegment }): Promise<SquareBookingData>;
  /** CancelBooking (seller level). Only the booking-change routine calls it. */
  cancelBooking(input: { bookingId: string; idempotencyKey: string; version: number }): Promise<SquareBookingData>;
}

/** The one appointment segment a booking change sends (copied from the slot Square returned). */
export interface SquareWriteSegment {
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: string | null;
  durationMinutes: number;
}

/** A service variation as Square answers it now (the catalogue re-check of a booking change). */
export interface SquareFreshServiceData {
  variationId: string;
  version: string;
  availableForBooking: boolean;
  teamMemberIds: string[];
  /** The variation or its item is archived or deleted (when Square sent the item). */
  archived: boolean;
  durationMinutes: number | null;
  noShowFeeSeen: { amount: string; currency: string } | null;
}

/** One appointment segment of a booking. */
export interface SquareSegmentData {
  teamMemberId: string;
  serviceVariationId: string | null;
  serviceVariationVersion: string | null;
  durationMinutes: number;
  intermissionMinutes: number;
}

/** A Square booking, normalised (Square's int64 values become strings; `raw` is JSON-safe). */
export interface SquareBookingData {
  id: string;
  version: number;
  status: string;
  startAt: string;
  locationId: string;
  customerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  segments: SquareSegmentData[];
  raw: Record<string, unknown>;
}

/** A booking Square still has but sent in a shape we can't read (for example a local start time): left as stored. */
export interface MalformedSquareBooking {
  malformed: true;
  id: string;
  reason: string;
}

/** Whether `getBooking` returned a booking Square has but we couldn't read. */
export function isMalformedBooking(b: SquareBookingData | MalformedSquareBooking | null): b is MalformedSquareBooking {
  return b !== null && 'malformed' in b && b.malformed === true;
}

/** A Square customer, normalised. */
export interface SquareCustomerData {
  id: string;
  version: number | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  emailUnsubscribed: boolean | null;
  updatedAt: string | null;
}

/** One free slot from SearchAvailability. */
export interface SquareSlotData {
  startAt: string;
  locationId: string;
  segments: SquareSegmentData[];
}

/** A Square failure mapped to what the module does about it (design §7.5). */
export class SquareApiError extends Error {
  constructor(
    readonly kind: SquareErrorKind,
    readonly code: string,
    message: string,
    readonly statusCode: number | null,
    readonly errors: SquareErrorEntry[],
    /** Square's response body as it arrived (JSON-safe), kept verbatim for a refused booking change. */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'SquareApiError';
  }
}

/** Converts Square's SDK values (bigint, nested objects) to plain JSON. */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = toJsonSafe(v, depth + 1);
    return out;
  }
  return value;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bigStr = (v: unknown): string | null => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null);
const money = (m: Square.Money | undefined | null): { amount: string; currency: string } | null =>
  m && m.amount !== undefined && m.amount !== null ? { amount: String(m.amount), currency: String(m.currency ?? 'AUD') } : null;

function segmentsOf(list: Square.AppointmentSegment[] | null | undefined): SquareSegmentData[] {
  return (list ?? []).map((s) => ({
    teamMemberId: s.teamMemberId,
    serviceVariationId: str(s.serviceVariationId),
    serviceVariationVersion: bigStr(s.serviceVariationVersion),
    durationMinutes: typeof s.durationMinutes === 'number' ? s.durationMinutes : 0,
    intermissionMinutes: typeof s.intermissionMinutes === 'number' ? s.intermissionMinutes : 0,
  }));
}

/**
 * Normalises an SDK booking; null when Square left out the fields every booking has, or when its start time is not
 * an RFC 3339 instant (design §4.8: check the format before parsing; never parse a local time). `onSkip` hears the
 * booking id of a skipped booking so the caller can log it.
 */
export function bookingFromSdk(b: Square.Booking, onSkip?: (bookingId: string, reason: string) => void): SquareBookingData | null {
  if (!b.id || !b.startAt || !b.status) {
    if (b.id) onSkip?.(b.id, MISSING_FIELDS);
    return null;
  }
  if (!isRfc3339Instant(b.startAt)) {
    onSkip?.(b.id, NOT_AN_INSTANT);
    return null;
  }
  return {
    id: b.id,
    version: typeof b.version === 'number' ? b.version : 0,
    status: String(b.status),
    startAt: b.startAt,
    locationId: b.locationId ?? '',
    customerId: str(b.customerId),
    createdAt: str(b.createdAt),
    updatedAt: str(b.updatedAt),
    segments: segmentsOf(b.appointmentSegments),
    raw: toJsonSafe(b) as Record<string, unknown>,
  };
}

const MISSING_FIELDS = 'missing id, start_at or status';
const NOT_AN_INSTANT = 'start_at is not an RFC 3339 instant';

/** Why an SDK booking can't be read, or null when it can (the same tests as {@link bookingFromSdk}). */
function bookingProblem(b: Square.Booking): string | null {
  if (!b.id || !b.startAt || !b.status) return MISSING_FIELDS;
  if (!isRfc3339Instant(b.startAt)) return NOT_AN_INSTANT;
  return null;
}

/** Normalises an SDK customer. */
export function customerFromSdk(c: Square.Customer): SquareCustomerData | null {
  if (!c.id) return null;
  const version = typeof c.version === 'bigint' || typeof c.version === 'number' ? Number(c.version) : null;
  return {
    id: c.id,
    version: version !== null && Number.isSafeInteger(version) && version <= 2_147_483_647 ? version : null,
    givenName: c.givenName ?? '',
    familyName: c.familyName ?? '',
    email: str(c.emailAddress),
    phone: str(c.phoneNumber),
    emailUnsubscribed: typeof c.preferences?.emailUnsubscribed === 'boolean' ? c.preferences.emailUnsubscribed : null,
    updatedAt: str(c.updatedAt),
  };
}

/** Normalises an SDK payment for the matcher. */
export function paymentFromSdk(p: Square.Payment): MatchPayment | null {
  if (!p.id || !p.createdAt) return null;
  return {
    id: p.id,
    status: p.status ?? '',
    locationId: str(p.locationId),
    customerId: str(p.customerId),
    teamMemberId: str(p.teamMemberId),
    orderId: str(p.orderId),
    createdAt: new Date(p.createdAt),
    squareProduct: str(p.applicationDetails?.squareProduct),
    totalAmount: money(p.totalMoney)?.amount ?? null,
    refundedAmount: money(p.refundedMoney)?.amount ?? null,
  };
}

/** Flattens APPOINTMENTS_SERVICE items into one entry per variation. */
export function servicesFromSdk(items: Square.CatalogObject[]): SquareServiceSnapshot[] {
  const out: SquareServiceSnapshot[] = [];
  for (const item of items) {
    if (item.type !== 'ITEM' || !item.id) continue;
    const data = item.itemData;
    for (const v of data?.variations ?? []) {
      if (v.type !== 'ITEM_VARIATION' || !v.id) continue;
      const vd = v.itemVariationData;
      const durationMs = vd?.serviceDuration !== undefined && vd?.serviceDuration !== null ? Number(vd.serviceDuration) : null;
      out.push({
        itemId: item.id,
        itemName: data?.name ?? '',
        variationId: v.id,
        variationName: vd?.name ?? '',
        version: bigStr(v.version) ?? '0',
        durationMinutes: durationMs !== null && Number.isFinite(durationMs) ? Math.round(durationMs / 60_000) : null,
        price: money(vd?.priceMoney),
        availableForBooking: vd?.availableForBooking === true,
        teamMemberIds: vd?.teamMemberIds ?? [],
        archived: data?.isArchived === true || v.isDeleted === true || item.isDeleted === true,
        noShowFeeSeen: noShowFeeFrom(vd as Record<string, unknown> | undefined),
      });
    }
  }
  return out;
}

function profileFromSdk(p: Square.BusinessBookingProfile | undefined): SquareBusinessProfileSnapshot | null {
  if (!p) return null;
  const s = p.businessAppointmentSettings;
  return {
    bookingEnabled: p.bookingEnabled ?? null,
    bookingPolicy: p.bookingPolicy ? String(p.bookingPolicy) : null,
    allowUserCancel: p.allowUserCancel ?? null,
    supportSellerLevelWrites: p.supportSellerLevelWrites === true,
    cancellationWindowSeconds: s?.cancellationWindowSeconds ?? null,
    cancellationFee: money(s?.cancellationFeeMoney),
    cancellationPolicy: s?.cancellationPolicy ? String(s.cancellationPolicy) : null,
    minLeadSeconds: s?.minBookingLeadTimeSeconds ?? null,
    maxLeadSeconds: s?.maxBookingLeadTimeSeconds ?? null,
  };
}

/** Maps anything a Square call threw to a {@link SquareApiError} (cancellation passes through unchanged). */
export function toSquareApiError(err: unknown, op: 'read' | 'write' = 'read'): Error {
  if (err instanceof SquareApiError || err instanceof CancelledError) return err;
  if (err instanceof SquareError) {
    const errors = (err.errors ?? []).map((e) => ({ category: String(e.category), code: String(e.code), ...(e.detail ? { detail: e.detail } : {}) }));
    const mapped = mapSquareError({ statusCode: err.statusCode ?? null, errors }, op);
    return new SquareApiError(mapped.kind, mapped.code, mapped.message, err.statusCode ?? null, errors, toJsonSafe(err.body ?? { errors }));
  }
  if (err instanceof SquareTimeoutError) return new SquareApiError('transient', 'TIMEOUT', 'Square didn’t answer in time. Trying again shortly.', null, []);
  const mapped = mapSquareError({ statusCode: null, errors: null }, op);
  return new SquareApiError(mapped.kind, mapped.code, mapped.message, null, []);
}

/** Options for {@link createSdkSquareApi}. */
export interface SdkSquareApiOptions {
  token: string;
  environment: 'sandbox' | 'production';
  /** Test-only base URL of a local fake (null in every real deployment). */
  baseUrl: string | null;
  signal: AbortSignal;
  fetch?: typeof fetch | undefined;
  /**
   * Hears each booking or availability slot skipped because Square sent a malformed time or left out its basic fields
   * (for the log; a booking id, or `slot:<location id>` for a slot, which has no id of its own).
   */
  onSkip?: ((objectId: string, reason: string) => void) | undefined;
}

/** The {@link SquareApi} backed by the official `square@46.0.0` SDK. */
export function createSdkSquareApi(options: SdkSquareApiOptions): SquareApi {
  const client = new SquareClient({
    token: options.token,
    environment: options.environment === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeoutInSeconds: 20,
    // pg-boss owns retries (the SDK's default is 2).
    maxRetries: 0,
  });
  const ro = { abortSignal: options.signal, maxRetries: 0, timeoutInSeconds: 20 };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new CancelledError();
    try {
      return await fn();
    } catch (err) {
      if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new CancelledError();
      throw toSquareApiError(err);
    }
  };
  const write = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new CancelledError();
    try {
      return await fn();
    } catch (err) {
      if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new CancelledError();
      throw toSquareApiError(err, 'write');
    }
  };
  const written = (b: Square.Booking | undefined): SquareBookingData => {
    const out = b ? bookingFromSdk(b, options.onSkip) : null;
    if (!out) throw new SquareApiError('transient', 'EMPTY_BOOKING', 'Square answered without the booking. Checking again shortly.', null, []);
    return out;
  };
  const segmentFor = (seg: SquareWriteSegment): Square.AppointmentSegment => ({
    teamMemberId: seg.teamMemberId,
    serviceVariationId: seg.serviceVariationId,
    durationMinutes: seg.durationMinutes,
    ...(seg.serviceVariationVersion !== null && /^\d+$/.test(seg.serviceVariationVersion) ? { serviceVariationVersion: BigInt(seg.serviceVariationVersion) } : {}),
  });
  const orNull = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await call(fn);
    } catch (err) {
      if (err instanceof SquareApiError && err.kind === 'not_found') return null;
      throw err;
    }
  };
  const all = async <T>(page: Promise<AsyncIterable<T>>): Promise<T[]> => {
    const out: T[] = [];
    for await (const item of await page) out.push(item);
    return out;
  };

  return {
    retrieveTokenStatus: () =>
      call(async () => {
        const r = await client.oAuth.retrieveTokenStatus(ro);
        return { scopes: r.scopes ?? [], expiresAt: r.expiresAt ?? null, merchantId: r.merchantId ?? null };
      }),
    getMerchantName: (merchantId) => call(async () => (await client.merchants.get({ merchantId }, ro)).merchant?.businessName ?? ''),
    listLocations: () =>
      call(async () =>
        ((await client.locations.list(ro)).locations ?? [])
          .filter((l) => l.id)
          .map((l) => ({ id: l.id as string, name: l.name ?? '', timezone: l.timezone ?? null, status: String(l.status ?? 'ACTIVE') })),
      ),
    getBusinessProfile: () => call(async () => profileFromSdk((await client.bookings.getBusinessProfile(ro)).businessBookingProfile)),
    listLocationProfiles: () =>
      call(async () =>
        (await all(client.bookings.locationProfiles.list({}, ro))).filter((p) => p.locationId).map((p) => ({ locationId: p.locationId as string, bookingSiteUrl: p.bookingSiteUrl ?? null })),
      ),
    listTeamMemberProfiles: (locationId) =>
      call(async () =>
        (await all(client.bookings.teamMemberProfiles.list({ bookableOnly: false, ...(locationId ? { locationId } : {}) }, ro)))
          .filter((t) => t.teamMemberId)
          .map((t) => ({ id: t.teamMemberId as string, displayName: t.displayName ?? '', isBookable: t.isBookable === true })),
      ),
    listServices: () =>
      call(async () => {
        const items: Square.CatalogObject[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const r = await client.catalog.searchItems({ productTypes: ['APPOINTMENTS_SERVICE'], archivedState: 'ARCHIVED_STATE_NOT_ARCHIVED', ...(cursor ? { cursor } : {}) }, ro);
          items.push(...(r.items ?? []));
          cursor = r.cursor;
          if (!cursor) break;
        }
        return servicesFromSdk(items);
      }),
    listBookings: ({ locationId, startAtMin, startAtMax }) =>
      call(async () => {
        const bookings: SquareBookingData[] = [];
        const skippedIds: string[] = [];
        for (const raw of await all(client.bookings.list({ startAtMin, startAtMax, limit: 100, ...(locationId ? { locationId } : {}) }, ro))) {
          const b = bookingFromSdk(raw, options.onSkip);
          if (b) bookings.push(b);
          else if (raw.id) skippedIds.push(raw.id);
        }
        return { bookings, skippedIds };
      }),
    getBooking: (bookingId) =>
      orNull(async (): Promise<SquareBookingData | MalformedSquareBooking> => {
        const b = (await client.bookings.get({ bookingId }, ro)).booking;
        // Only NOT_FOUND (orNull) means Square no longer has it; an answer we can't read is never "gone".
        if (!b) return { malformed: true, id: bookingId, reason: 'Square answered without the booking' };
        return bookingFromSdk(b, options.onSkip) ?? { malformed: true, id: b.id ?? bookingId, reason: bookingProblem(b) ?? 'unreadable booking' };
      }),
    searchAvailability: (f) =>
      call(async () => {
        const r = await client.bookings.searchAvailability(
          {
            query: {
              filter: {
                startAtRange: { startAt: f.startAt, endAt: f.endAt },
                locationId: f.locationId,
                segmentFilters: [{ serviceVariationId: f.serviceVariationId, ...(f.teamMemberId ? { teamMemberIdFilter: { any: [f.teamMemberId] } } : {}) }],
              },
            },
          },
          ro,
        );
        const slots: SquareSlotData[] = [];
        for (const a of r.availabilities ?? []) {
          if (!isRfc3339Instant(a.startAt)) {
            options.onSkip?.(`slot:${a.locationId ?? f.locationId}`, 'start_at is not an RFC 3339 instant');
            continue;
          }
          slots.push({ startAt: a.startAt as string, locationId: a.locationId ?? f.locationId, segments: segmentsOf(a.appointmentSegments) });
        }
        return slots;
      }),
    listCustomers: () => call(async () => (await all(client.customers.list({ limit: 100 }, ro))).map(customerFromSdk).filter((c): c is SquareCustomerData => c !== null)),
    searchCustomersUpdatedSince: (sinceIso) =>
      call(async () => {
        const out: SquareCustomerData[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const r = await client.customers.search({ limit: 100n, query: { filter: { updatedAt: { startAt: sinceIso } } }, ...(cursor ? { cursor } : {}) }, ro);
          out.push(...(r.customers ?? []).map(customerFromSdk).filter((c): c is SquareCustomerData => c !== null));
          cursor = r.cursor;
          if (!cursor) break;
        }
        return out;
      }),
    getCustomer: (customerId) =>
      orNull(async () => {
        const c = (await client.customers.get({ customerId }, ro)).customer;
        return c ? customerFromSdk(c) : null;
      }),
    bulkRetrieveCustomers: (customerIds) =>
      call(async () => {
        const out: SquareCustomerData[] = [];
        for (let i = 0; i < customerIds.length; i += 100) {
          const r = await client.customers.bulkRetrieveCustomers({ customerIds: customerIds.slice(i, i + 100) }, ro);
          for (const res of Object.values(r.responses ?? {})) {
            const c = res.customer ? customerFromSdk(res.customer) : null;
            if (c) out.push(c);
          }
        }
        return out;
      }),
    listPayments: ({ locationId, beginTime, endTime }) =>
      call(async () => (await all(client.payments.list({ locationId, beginTime, endTime, sortOrder: 'ASC', limit: 100 }, ro))).map(paymentFromSdk).filter((p): p is MatchPayment => p !== null)),
    getPayment: (paymentId) =>
      orNull(async () => {
        const p = (await client.payments.get({ paymentId }, ro)).payment;
        return p ? paymentFromSdk(p) : null;
      }),
    getServiceVariation: (variationId) =>
      orNull(async () => {
        const r = await client.catalog.object.get({ objectId: variationId, includeRelatedObjects: true }, ro);
        const v = r.object;
        if (!v || v.type !== 'ITEM_VARIATION' || !v.id) return null;
        const vd = v.itemVariationData;
        const item = (r.relatedObjects ?? []).find((o) => o.type === 'ITEM' && o.id === vd?.itemId);
        const durationMs = vd?.serviceDuration !== undefined && vd?.serviceDuration !== null ? Number(vd.serviceDuration) : null;
        return {
          variationId: v.id,
          version: bigStr(v.version) ?? '0',
          availableForBooking: vd?.availableForBooking === true,
          teamMemberIds: vd?.teamMemberIds ?? [],
          archived: v.isDeleted === true || (item ? item.isDeleted === true || (item.type === 'ITEM' && item.itemData?.isArchived === true) : false),
          durationMinutes: durationMs !== null && Number.isFinite(durationMs) ? Math.round(durationMs / 60_000) : null,
          noShowFeeSeen: noShowFeeFrom(vd as Record<string, unknown> | undefined),
        };
      }),
    searchAvailabilityForBooking: (f) =>
      call(async () => {
        const r = await client.bookings.searchAvailability({ query: { filter: { startAtRange: { startAt: f.startAt, endAt: f.endAt }, bookingId: f.bookingId } } }, ro);
        return (r.availabilities ?? []).filter((a) => isRfc3339Instant(a.startAt)).map((a) => ({ startAt: a.startAt as string, locationId: a.locationId ?? '', segments: segmentsOf(a.appointmentSegments) }));
      }),
    createBooking: (input) =>
      write(async () =>
        written(
          (
            await client.bookings.create(
              {
                idempotencyKey: input.idempotencyKey,
                booking: { locationId: input.locationId, startAt: input.startAt, customerId: input.customerId, ...(input.sellerNote ? { sellerNote: input.sellerNote } : {}), appointmentSegments: [segmentFor(input.segment)] },
              },
              ro,
            )
          ).booking,
        ),
      ),
    updateBooking: (input) =>
      write(async () =>
        written((await client.bookings.update({ bookingId: input.bookingId, idempotencyKey: input.idempotencyKey, booking: { version: input.version, startAt: input.startAt, appointmentSegments: [segmentFor(input.segment)] } }, ro)).booking),
      ),
    cancelBooking: (input) => write(async () => written((await client.bookings.cancel({ bookingId: input.bookingId, idempotencyKey: input.idempotencyKey, bookingVersion: input.version }, ro)).booking)),
    batchGetOrderLines: (locationId, orderIds) =>
      call(async () => {
        const out: Record<string, string[]> = {};
        for (let i = 0; i < orderIds.length; i += 100) {
          const r = await client.orders.batchGet({ locationId, orderIds: orderIds.slice(i, i + 100) }, ro);
          for (const o of r.orders ?? []) if (o.id) out[o.id] = (o.lineItems ?? []).map((l) => l.catalogObjectId ?? '').filter(Boolean);
        }
        return out;
      }),
  };
}
