import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local fake of Square's API host (connect.squareup[sandbox].com), for tests only. It answers the read endpoints
 * the Square module uses (design §7.2) and the OAuth token, token-status and revoke endpoints with Square's own JSON
 * shapes (snake_case), so the real `square@46.0.0` SDK runs against it through `SQUARE_API_BASE_URL` (honoured only
 * when NODE_ENV=test). It enforces the documented limits the module must respect (ListBookings ≤ 31 days,
 * SearchAvailability 24 hours to 32 days) and records every call, including any write, so tests can prove that
 * nothing is ever written to Square. Booking writes (WP6b) are refused with 403 unless a test sets `acceptWrites`;
 * then CreateBooking, UpdateBooking and CancelBooking change the scenario like Square would, honour the idempotency
 * key (the same key returns the first answer and changes nothing), check the booking version, and can drop the
 * response after applying a write (`dropWriteResponses`), which is what a time-out after Square made the change looks
 * like. No real Square endpoint is ever contacted.
 */

/** Square's error body entry. */
export interface FakeSquareError {
  status: number;
  code: string;
  category?: string;
  detail?: string;
}

/** Endpoint names used for error injection and call counting. */
export type SquareEndpoint =
  | 'authorize'
  | 'token'
  | 'token_status'
  | 'revoke'
  | 'merchant'
  | 'locations'
  | 'business_profile'
  | 'location_profiles'
  | 'team_profiles'
  | 'catalog_search'
  | 'catalog_object'
  | 'bookings_list'
  | 'booking_get'
  | 'availability'
  | 'customers_list'
  | 'customers_search'
  | 'customer_get'
  | 'customers_bulk'
  | 'payments_list'
  | 'payment_get'
  | 'orders_batch'
  | 'write';

/** What the fake knows; tests change it between steps. Objects are Square JSON (snake_case). */
export interface SquareScenario {
  merchantId: string;
  businessName: string;
  accessToken: string;
  refreshToken: string;
  /** The authorisation code `/oauth2/token` accepts. */
  oauthCode: string;
  /** Access token expiry the token endpoints report. */
  expiresAt: string;
  scopes: string[];
  /** When true, refresh and token status answer 401 ACCESS_TOKEN_REVOKED. */
  revoked: boolean;
  locations: Array<Record<string, unknown>>;
  businessProfile: Record<string, unknown>;
  locationProfiles: Array<Record<string, unknown>>;
  teamProfiles: Array<Record<string, unknown>>;
  catalogItems: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  availabilities: Array<Record<string, unknown>>;
  /** Errors returned once per endpoint (consumed when used). */
  failOnce: Partial<Record<SquareEndpoint, FakeSquareError>>;
  /** Booking writes are applied only when true (otherwise every write gets 403 FORBIDDEN, as for Tier 0). */
  acceptWrites: boolean;
  /** This many write responses are dropped (the connection is cut) after the write was applied. */
  dropWriteResponses: number;
  /** Which writes `dropWriteResponses` applies to (all when empty). */
  dropWriteKinds: Array<'create' | 'update' | 'cancel'>;
  /** Refuses the next write of this kind with this error, without applying it (consumed when used). */
  failNextWrite: { kind: 'create' | 'update' | 'cancel'; error: FakeSquareError } | null;
  /** Idempotency key → the JSON body of Square's first answer. */
  idempotency: Record<string, unknown>;
}

/** One recorded request. */
export interface SquareCall {
  endpoint: SquareEndpoint | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
}

export interface FakeSquareServer {
  url: string;
  scenario: SquareScenario;
  calls: SquareCall[];
  /** Calls to one endpoint. */
  callsTo(endpoint: SquareEndpoint): SquareCall[];
  close(): Promise<void>;
}

/** A scenario with one Melbourne location, two barbers and two services, and no bookings. */
export function defaultSquareScenario(): SquareScenario {
  return {
    merchantId: 'MERCHANT_FAKE_1',
    businessName: 'Ivanhoe Test Barbers',
    accessToken: 'fake-square-access-1',
    refreshToken: 'fake-square-refresh-1',
    oauthCode: 'fake-square-code',
    expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    scopes: [
      'APPOINTMENTS_READ',
      'APPOINTMENTS_ALL_READ',
      'APPOINTMENTS_BUSINESS_SETTINGS_READ',
      'CUSTOMERS_READ',
      'ITEMS_READ',
      'MERCHANT_PROFILE_READ',
      'PAYMENTS_READ',
      'ORDERS_READ',
    ],
    revoked: false,
    locations: [{ id: 'LOC_1', name: 'Ivanhoe', timezone: 'Australia/Melbourne', status: 'ACTIVE', country: 'AU', currency: 'AUD' }],
    businessProfile: {
      seller_id: 'MERCHANT_FAKE_1',
      booking_enabled: true,
      booking_policy: 'ACCEPT_ALL',
      allow_user_cancel: true,
      support_seller_level_writes: false,
      business_appointment_settings: { cancellation_window_seconds: 86400, cancellation_policy: 'CANCELLATION_TREATED_AS_NO_SHOW', min_booking_lead_time_seconds: 3600 },
    },
    locationProfiles: [{ location_id: 'LOC_1', booking_site_url: 'https://book.example.test/ivanhoe', online_booking_enabled: true }],
    teamProfiles: [
      { team_member_id: 'TM_SAM', display_name: 'Sam', is_bookable: true },
      { team_member_id: 'TM_ALEX', display_name: 'Alex', is_bookable: true },
    ],
    catalogItems: [
      {
        type: 'ITEM',
        id: 'ITEM_FADE',
        version: 5,
        item_data: {
          name: 'Skin fade',
          product_type: 'APPOINTMENTS_SERVICE',
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: 'VAR_FADE',
              version: 1700000000001,
              item_variation_data: { item_id: 'ITEM_FADE', name: 'Regular', price_money: { amount: 5500, currency: 'AUD' }, service_duration: 2_700_000, available_for_booking: true, team_member_ids: ['TM_SAM', 'TM_ALEX'] },
            },
          ],
        },
      },
      {
        type: 'ITEM',
        id: 'ITEM_BEARD',
        version: 3,
        item_data: {
          name: 'Beard trim',
          product_type: 'APPOINTMENTS_SERVICE',
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: 'VAR_BEARD',
              version: 1700000000002,
              item_variation_data: {
                item_id: 'ITEM_BEARD',
                name: 'Regular',
                price_money: { amount: 2500, currency: 'AUD' },
                service_duration: 1_800_000,
                available_for_booking: true,
                team_member_ids: ['TM_SAM'],
                no_show_fee: { amount: 1000, currency: 'AUD' },
              },
            },
          ],
        },
      },
    ],
    bookings: [],
    customers: [],
    payments: [],
    orders: [],
    availabilities: [],
    failOnce: {},
    acceptWrites: false,
    dropWriteResponses: 0,
    dropWriteKinds: [],
    failNextWrite: null,
    idempotency: {},
  };
}

/** A free time in SearchAvailability's JSON shape. */
export function fakeSlot(input: { startAt: string; teamMemberId?: string; serviceVariationId?: string; durationMinutes?: number; version?: number }): Record<string, unknown> {
  return {
    start_at: input.startAt,
    location_id: 'LOC_1',
    appointment_segments: [{ duration_minutes: input.durationMinutes ?? 45, team_member_id: input.teamMemberId ?? 'TM_SAM', service_variation_id: input.serviceVariationId ?? 'VAR_FADE', service_variation_version: input.version ?? 1700000000001 }],
  };
}

/** A Square booking in Square's JSON shape. */
export function fakeBooking(input: { id: string; startAt: string; status?: string; version?: number; customerId?: string | null; teamMemberId?: string; serviceVariationId?: string; durationMinutes?: number; locationId?: string; updatedAt?: string }): Record<string, unknown> {
  return {
    id: input.id,
    version: input.version ?? 0,
    status: input.status ?? 'ACCEPTED',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: input.updatedAt ?? '2026-11-01T00:00:00Z',
    start_at: input.startAt,
    location_id: input.locationId ?? 'LOC_1',
    customer_id: input.customerId ?? null,
    appointment_segments: [{ duration_minutes: input.durationMinutes ?? 45, service_variation_id: input.serviceVariationId ?? 'VAR_FADE', team_member_id: input.teamMemberId ?? 'TM_SAM', service_variation_version: 1700000000001 }],
    source: 'FIRST_PARTY_MERCHANT',
  };
}

/** A Square customer in Square's JSON shape. */
export function fakeCustomer(input: { id: string; given: string; family: string; email?: string | null; phone?: string | null; version?: number; unsubscribed?: boolean; updatedAt?: string }): Record<string, unknown> {
  return {
    id: input.id,
    given_name: input.given,
    family_name: input.family,
    email_address: input.email ?? null,
    phone_number: input.phone ?? null,
    version: input.version ?? 1,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: input.updatedAt ?? '2026-11-01T00:00:00Z',
    preferences: { email_unsubscribed: input.unsubscribed ?? false },
  };
}

/** A Square payment in Square's JSON shape (amounts in cents). */
export function fakePayment(input: { id: string; createdAt: string; customerId?: string | null; status?: string; amount?: number; refunded?: number; teamMemberId?: string | null; orderId?: string | null; product?: string | null; locationId?: string }): Record<string, unknown> {
  return {
    id: input.id,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    status: input.status ?? 'COMPLETED',
    location_id: input.locationId ?? 'LOC_1',
    customer_id: input.customerId ?? undefined,
    team_member_id: input.teamMemberId ?? undefined,
    order_id: input.orderId ?? undefined,
    total_money: { amount: input.amount ?? 5500, currency: 'AUD' },
    amount_money: { amount: input.amount ?? 5500, currency: 'AUD' },
    ...(input.refunded ? { refunded_money: { amount: input.refunded, currency: 'AUD' } } : {}),
    ...(input.product ? { application_details: { square_product: input.product } } : {}),
    source_type: 'CARD',
  };
}

/**
 * Applies one booking write to the scenario (CreateBooking, UpdateBooking, CancelBooking at seller level). A key
 * already used returns Square's first answer without changing anything; a stale `version` answers 409 CONFLICT.
 */
function applyWrite(scenario: SquareScenario, method: string, path: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
  const key = typeof body?.['idempotency_key'] === 'string' ? body['idempotency_key'] : null;
  if (key && scenario.idempotency[key]) return { status: 200, body: scenario.idempotency[key] };
  const err = (status: number, code: string, detail: string) => ({ status, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code, detail }] } });
  const nowIso = new Date().toISOString();
  let booking: Record<string, unknown>;
  if (method === 'POST' && path === '/v2/bookings') {
    const b = (body?.['booking'] ?? {}) as Record<string, unknown>;
    booking = {
      id: `BK_NEW_${scenario.bookings.length + 1}_${Math.random().toString(36).slice(2, 7)}`,
      version: 0,
      status: 'ACCEPTED',
      created_at: nowIso,
      updated_at: nowIso,
      start_at: b['start_at'],
      location_id: b['location_id'],
      customer_id: b['customer_id'],
      ...(b['seller_note'] ? { seller_note: b['seller_note'] } : {}),
      appointment_segments: b['appointment_segments'],
      source: 'API',
    };
    scenario.bookings.push(booking);
  } else {
    const m = /^\/v2\/bookings\/([^/]+)(\/cancel)?$/.exec(path);
    const existing = m ? scenario.bookings.find((x) => x['id'] === decodeURIComponent(m[1] ?? '')) : undefined;
    if (!m || !existing) return err(404, 'NOT_FOUND', 'Booking not found');
    const cancel = Boolean(m[2]);
    const version = cancel ? body?.['booking_version'] : ((body?.['booking'] ?? {}) as Record<string, unknown>)['version'];
    if (version !== undefined && version !== null && version !== existing['version']) return err(409, 'CONFLICT', 'The booking version does not match');
    if (cancel) {
      existing['status'] = 'CANCELLED_BY_SELLER';
    } else {
      const b = (body?.['booking'] ?? {}) as Record<string, unknown>;
      if (b['start_at']) existing['start_at'] = b['start_at'];
      if (b['appointment_segments']) existing['appointment_segments'] = b['appointment_segments'];
    }
    existing['version'] = Number(existing['version'] ?? 0) + 1;
    existing['updated_at'] = nowIso;
    booking = existing;
  }
  const answer = { booking: JSON.parse(JSON.stringify(booking)) as Record<string, unknown> };
  if (key) scenario.idempotency[key] = answer;
  return { status: 200, body: answer };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function squareError(res: ServerResponse, e: FakeSquareError): void {
  send(res, e.status, { errors: [{ category: e.category ?? (e.status === 401 ? 'AUTHENTICATION_ERROR' : e.status >= 500 ? 'API_ERROR' : 'INVALID_REQUEST_ERROR'), code: e.code, detail: e.detail ?? e.code }] });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function endpointFor(method: string, path: string): SquareEndpoint | 'unknown' {
  if (path === '/oauth2/authorize' && method === 'GET') return 'authorize';
  if (path === '/oauth2/token') return 'token';
  if (path === '/oauth2/token/status') return 'token_status';
  if (path === '/oauth2/revoke') return 'revoke';
  if (path.startsWith('/v2/merchants/')) return 'merchant';
  if (path === '/v2/locations') return 'locations';
  if (path === '/v2/bookings/business-booking-profile') return 'business_profile';
  if (path === '/v2/bookings/location-booking-profiles') return 'location_profiles';
  if (path === '/v2/bookings/team-member-booking-profiles') return 'team_profiles';
  if (path === '/v2/catalog/search-catalog-items') return 'catalog_search';
  if (path.startsWith('/v2/catalog/object/')) return 'catalog_object';
  if (path === '/v2/bookings/availability/search') return 'availability';
  if (path === '/v2/bookings' && method === 'GET') return 'bookings_list';
  if (path.startsWith('/v2/bookings/') && method === 'GET') return 'booking_get';
  if (path.startsWith('/v2/bookings')) return 'write';
  if (path === '/v2/customers/search') return 'customers_search';
  if (path === '/v2/customers/bulk-retrieve') return 'customers_bulk';
  if (path === '/v2/customers' && method === 'GET') return 'customers_list';
  if (path.startsWith('/v2/customers/') && method === 'GET') return 'customer_get';
  if (path === '/v2/payments' && method === 'GET') return 'payments_list';
  if (path.startsWith('/v2/payments/') && method === 'GET') return 'payment_get';
  if (path === '/v2/orders/batch-retrieve') return 'orders_batch';
  if (method !== 'GET') return 'write';
  return 'unknown';
}

const DAY = 24 * 3600_000;

/** Where the fake listens (default 127.0.0.1 on a random port). */
export interface FakeSquareListenOptions {
  port?: number;
  host?: string;
}

/**
 * Starts the fake on 127.0.0.1 with a random port (or `listen`). Besides the API it plays Square's authorise page for
 * a browser test: `GET /oauth2/authorize` "approves" at once and redirects to `redirect_uri` with the scenario's code
 * and the state it was given (the requested `scope` is recorded with the call).
 */
export async function startFakeSquareServer(initial: Partial<SquareScenario> = {}, listen: FakeSquareListenOptions = {}): Promise<FakeSquareServer> {
  const scenario: SquareScenario = { ...defaultSquareScenario(), ...initial };
  const calls: SquareCall[] = [];
  const notFound = (res: ServerResponse) => squareError(res, { status: 404, code: 'NOT_FOUND', detail: 'Not found' });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://fake');
      const method = (req.method ?? 'GET').toUpperCase();
      const body = method === 'GET' ? null : await readBody(req);
      const endpoint = endpointFor(method, u.pathname);
      const auth = req.headers['authorization'];
      calls.push({ endpoint, method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, authorization: typeof auth === 'string' ? auth : undefined });
      if (endpoint === 'unknown') return notFound(res);
      if (endpoint === 'authorize') {
        const redirect = u.searchParams.get('redirect_uri');
        const state = u.searchParams.get('state');
        if (!redirect || !state || !u.searchParams.get('client_id')) return squareError(res, { status: 400, code: 'BAD_REQUEST', detail: 'client_id, state and redirect_uri are required' });
        const back = new URL(redirect);
        back.searchParams.set('code', scenario.oauthCode);
        back.searchParams.set('state', state);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      const injected = scenario.failOnce[endpoint];
      if (injected) {
        delete scenario.failOnce[endpoint];
        return squareError(res, injected);
      }
      if (endpoint === 'write') {
        if (!scenario.acceptWrites) return squareError(res, { status: 403, code: 'FORBIDDEN', detail: 'The fake refuses every write' });
        if (auth !== `Bearer ${scenario.accessToken}` || scenario.revoked) return squareError(res, { status: 401, code: 'UNAUTHORIZED', detail: 'Bad token' });
        const kind = method === 'POST' && u.pathname === '/v2/bookings' ? 'create' : u.pathname.endsWith('/cancel') ? 'cancel' : 'update';
        if (scenario.failNextWrite?.kind === kind) {
          const e = scenario.failNextWrite.error;
          scenario.failNextWrite = null;
          return squareError(res, e);
        }
        const answer = applyWrite(scenario, method, u.pathname, body);
        if (scenario.dropWriteResponses > 0 && answer.status < 300 && (!scenario.dropWriteKinds.length || scenario.dropWriteKinds.includes(kind))) {
          scenario.dropWriteResponses--;
          req.socket.destroy();
          return;
        }
        return send(res, answer.status, answer.body);
      }
      const bearerOk = auth === `Bearer ${scenario.accessToken}` && !scenario.revoked;
      if (!['token', 'revoke'].includes(endpoint) && !bearerOk) {
        return squareError(res, { status: 401, code: scenario.revoked ? 'ACCESS_TOKEN_REVOKED' : 'UNAUTHORIZED', detail: 'Bad token' });
      }
      switch (endpoint) {
        case 'token': {
          if (body?.['grant_type'] === 'authorization_code') {
            if (body['code'] !== scenario.oauthCode) return squareError(res, { status: 401, code: 'UNAUTHORIZED', detail: 'Invalid authorization code' });
            return send(res, 200, { access_token: scenario.accessToken, token_type: 'bearer', expires_at: scenario.expiresAt, merchant_id: scenario.merchantId, refresh_token: scenario.refreshToken });
          }
          if (body?.['grant_type'] === 'refresh_token') {
            if (scenario.revoked || body['refresh_token'] !== scenario.refreshToken) return squareError(res, { status: 401, code: 'ACCESS_TOKEN_REVOKED', detail: 'Revoked' });
            scenario.accessToken = `${scenario.accessToken.replace(/-r\d+$/, '')}-r${calls.filter((c) => c.endpoint === 'token').length}`;
            scenario.expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
            return send(res, 200, { access_token: scenario.accessToken, token_type: 'bearer', expires_at: scenario.expiresAt, merchant_id: scenario.merchantId, refresh_token: scenario.refreshToken });
          }
          return squareError(res, { status: 400, code: 'BAD_REQUEST' });
        }
        case 'revoke':
          if (auth !== 'Client fake-square-secret') return squareError(res, { status: 401, code: 'UNAUTHORIZED' });
          scenario.revoked = true;
          return send(res, 200, { success: true });
        case 'token_status':
          return send(res, 200, { scopes: scenario.scopes, expires_at: scenario.expiresAt, client_id: 'fake-square-app', merchant_id: scenario.merchantId });
        case 'merchant':
          return send(res, 200, { merchant: { id: scenario.merchantId, business_name: scenario.businessName, country: 'AU', currency: 'AUD', status: 'ACTIVE' } });
        case 'locations':
          return send(res, 200, { locations: scenario.locations });
        case 'business_profile':
          return send(res, 200, { business_booking_profile: scenario.businessProfile });
        case 'location_profiles':
          return send(res, 200, { location_booking_profiles: scenario.locationProfiles });
        case 'team_profiles':
          return send(res, 200, { team_member_booking_profiles: scenario.teamProfiles });
        case 'catalog_search':
          return send(res, 200, { items: scenario.catalogItems });
        case 'catalog_object': {
          const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
          for (const item of scenario.catalogItems) {
            if (item['id'] === id) return send(res, 200, { object: item });
            const variations = ((item['item_data'] as Record<string, unknown>)['variations'] ?? []) as Array<Record<string, unknown>>;
            const v = variations.find((x) => x['id'] === id);
            if (v) return send(res, 200, { object: v, ...(u.searchParams.get('include_related_objects') === 'true' ? { related_objects: [item] } : {}) });
          }
          return notFound(res);
        }
        case 'bookings_list': {
          const min = Date.parse(u.searchParams.get('start_at_min') ?? '');
          const max = Date.parse(u.searchParams.get('start_at_max') ?? '') || min + 31 * DAY;
          if (Number.isNaN(min) || max - min > 31 * DAY) return squareError(res, { status: 400, code: 'INVALID_TIME_RANGE', detail: 'The range is longer than 31 days' });
          const loc = u.searchParams.get('location_id');
          const list = scenario.bookings.filter((b) => {
            const at = Date.parse(String(b['start_at']));
            return at >= min && at < max && (!loc || b['location_id'] === loc);
          });
          return send(res, 200, { bookings: list });
        }
        case 'booking_get': {
          const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
          const b = scenario.bookings.find((x) => x['id'] === id);
          return b ? send(res, 200, { booking: b }) : notFound(res);
        }
        case 'availability': {
          const range = ((body?.['query'] as Record<string, unknown> | undefined)?.['filter'] as Record<string, unknown> | undefined)?.['start_at_range'] as { start_at?: string; end_at?: string } | undefined;
          const start = Date.parse(range?.start_at ?? '');
          const end = Date.parse(range?.end_at ?? '');
          if (Number.isNaN(start) || Number.isNaN(end) || end - start < DAY || end - start > 32 * DAY) {
            return squareError(res, { status: 400, code: 'INVALID_TIME_RANGE', detail: 'start_at_range must be at least 24 hours and at most 32 days' });
          }
          return send(res, 200, { availabilities: scenario.availabilities.filter((a) => Date.parse(String(a['start_at'])) >= start && Date.parse(String(a['start_at'])) < end) });
        }
        case 'customers_list':
          return send(res, 200, { customers: scenario.customers });
        case 'customers_search': {
          const filter = ((body?.['query'] as Record<string, unknown> | undefined)?.['filter'] as Record<string, unknown> | undefined)?.['updated_at'] as { start_at?: string } | undefined;
          const since = Date.parse(filter?.start_at ?? '') || 0;
          return send(res, 200, { customers: scenario.customers.filter((c) => Date.parse(String(c['updated_at'])) >= since) });
        }
        case 'customer_get': {
          const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
          const c = scenario.customers.find((x) => x['id'] === id);
          return c ? send(res, 200, { customer: c }) : notFound(res);
        }
        case 'customers_bulk': {
          const ids = (body?.['customer_ids'] ?? []) as string[];
          const responses: Record<string, unknown> = {};
          for (const id of ids) {
            const c = scenario.customers.find((x) => x['id'] === id);
            responses[id] = c ? { customer: c } : { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND' }] };
          }
          return send(res, 200, { responses });
        }
        case 'payments_list': {
          const begin = Date.parse(u.searchParams.get('begin_time') ?? '') || 0;
          const end = Date.parse(u.searchParams.get('end_time') ?? '') || Date.now();
          const loc = u.searchParams.get('location_id');
          return send(res, 200, {
            payments: scenario.payments.filter((p) => {
              const at = Date.parse(String(p['created_at']));
              return at >= begin && at <= end && (!loc || p['location_id'] === loc);
            }),
          });
        }
        case 'payment_get': {
          const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
          const p = scenario.payments.find((x) => x['id'] === id);
          return p ? send(res, 200, { payment: p }) : notFound(res);
        }
        case 'orders_batch': {
          const ids = (body?.['order_ids'] ?? []) as string[];
          return send(res, 200, { orders: scenario.orders.filter((o) => ids.includes(String(o['id']))) });
        }
        default:
          return notFound(res);
      }
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR', detail: String(err) }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, listen.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    scenario,
    calls,
    callsTo: (endpoint) => calls.filter((c) => c.endpoint === endpoint),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
