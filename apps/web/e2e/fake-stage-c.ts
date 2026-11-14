/**
 * Runs the local fakes of Square and Postmark as one process for the Stage C bookings browser test
 * (apps/web/e2e/run-stage-c-bookings.sh). Both are the worker's own test fakes, so there is one model of each provider:
 *
 *   - Square (`apps/worker/test/fakes/square-server.ts`): OAuth authorise page, code exchange, token status, revoke,
 *     merchant, locations, booking profiles, catalogue, bookings, customers, payments and orders; every write is refused
 *     and recorded. The web app and worker reach it through SQUARE_API_BASE_URL.
 *   - Postmark (`apps/worker/test/fakes/postmark-server.ts`): server, streams, webhooks, `POST /email`, the outbound
 *     search and suppressions. The worker reaches it through POSTMARK_API_BASE_URL.
 *
 * Both base URLs are honoured only when NODE_ENV=test. A third port is the test's control channel:
 *
 *   GET  /state                    calls per Square endpoint, the authorise requests, Postmark's counts, sends and held sends
 *   POST /square/scenario          replaces parts of the Square scenario: { merchantId, accessToken, refreshToken,
 *                                  oauthCode, locations, customers: [fakeCustomer input], bookings: [fakeBooking input] }
 *   POST /square/bookings/:id      changes one booking like Square would: { status } (version + 1, updated_at now)
 *   POST /postmark/hold            { hold: boolean } — while on, each send waits for /postmark/release
 *   POST /postmark/release         lets every waiting send through
 *
 *   FAKE_SQUARE_PORT=… FAKE_POSTMARK_PORT=… FAKE_CONTROL_PORT=… FAKE_POSTMARK_WEBHOOK_URL=… tsx apps/web/e2e/fake-stage-c.ts
 *
 * Prints one JSON line `{"msg":"fakes listening",…}` once all three accept connections. Stops on SIGTERM or SIGINT.
 * Nothing here talks to Square or Postmark.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fakeBooking, fakeCustomer, startFakeSquareServer } from '../../worker/test/fakes/square-server.js';
import { startFakePostmarkServer } from '../../worker/test/fakes/postmark-server.js';

function port(name: string): number {
  const p = Number(process.env[name] ?? '0');
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    console.error(`${name} must be a port number.`);
    process.exit(2);
  }
  return p;
}

const square = await startFakeSquareServer({ locations: [] }, { port: port('FAKE_SQUARE_PORT') });
const postmark = await startFakePostmarkServer(
  { serverToken: process.env['FAKE_POSTMARK_TOKEN'] ?? 'fake-postmark-token', webhookUrl: process.env['FAKE_POSTMARK_WEBHOOK_URL'] ?? null },
  { port: port('FAKE_POSTMARK_PORT') },
);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function state() {
  const squareCounts: Record<string, number> = {};
  for (const c of square.calls) squareCounts[c.endpoint] = (squareCounts[c.endpoint] ?? 0) + 1;
  return {
    square: {
      merchantId: square.scenario.merchantId,
      counts: squareCounts,
      writes: square.calls.filter((c) => c.endpoint === 'write').map((c) => ({ method: c.method, path: c.path })),
      authorize: square.calls.filter((c) => c.endpoint === 'authorize').map((c) => ({ scope: c.query['scope'] ?? '', redirectUri: c.query['redirect_uri'] ?? '', session: c.query['session'] ?? '' })),
      bookingReads: square.calls.filter((c) => c.endpoint === 'booking_get').map((c) => c.path),
    },
    postmark: { counts: postmark.counts, sends: postmark.sends, held: postmark.held() },
  };
}

const control = createServer((req, res) => {
  void (async () => {
    const u = new URL(req.url ?? '/', 'http://control');
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' && u.pathname === '/state') return reply(res, 200, state());
    if (method === 'POST' && u.pathname === '/square/scenario') {
      const b = await readJson(req);
      const s = square.scenario;
      for (const k of ['merchantId', 'accessToken', 'refreshToken', 'oauthCode', 'businessName'] as const) if (typeof b[k] === 'string') s[k] = b[k] as string;
      if (Array.isArray(b['locations'])) s.locations = b['locations'] as Array<Record<string, unknown>>;
      if (Array.isArray(b['customers'])) s.customers = (b['customers'] as Array<Parameters<typeof fakeCustomer>[0]>).map(fakeCustomer);
      if (Array.isArray(b['bookings'])) s.bookings = (b['bookings'] as Array<Parameters<typeof fakeBooking>[0]>).map(fakeBooking);
      if (typeof b['merchantId'] === 'string') s.businessProfile = { ...s.businessProfile, seller_id: b['merchantId'] };
      return reply(res, 200, { ok: true });
    }
    const m = /^\/square\/bookings\/([^/]+)$/.exec(u.pathname);
    if (method === 'POST' && m) {
      const b = await readJson(req);
      const booking = square.scenario.bookings.find((x) => x['id'] === decodeURIComponent(m[1] ?? ''));
      if (!booking) return reply(res, 404, { error: 'no such booking' });
      if (typeof b['status'] === 'string') booking['status'] = b['status'];
      booking['version'] = Number(booking['version'] ?? 0) + 1;
      booking['updated_at'] = new Date().toISOString();
      return reply(res, 200, { booking });
    }
    if (method === 'POST' && u.pathname === '/postmark/hold') {
      const b = await readJson(req);
      postmark.hold(b['hold'] === true);
      return reply(res, 200, { ok: true });
    }
    if (method === 'POST' && u.pathname === '/postmark/release') {
      postmark.release();
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: 'not found' });
  })().catch((err: unknown) => reply(res, 500, { error: String(err) }));
});
await new Promise<void>((resolve) => control.listen(port('FAKE_CONTROL_PORT'), '127.0.0.1', resolve));
const controlPort = (control.address() as { port: number }).port;
console.log(JSON.stringify({ msg: 'fakes listening', square: square.url, postmark: postmark.url, control: `http://127.0.0.1:${controlPort}` }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void Promise.all([square.close(), postmark.close(), new Promise<void>((r) => control.close(() => r()))]).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
