/**
 * Runs WP10's local fake of Zernio (apps/worker/test/fakes/zernio-server.ts) as its own process for the Stage C TikTok
 * browser test (apps/web/e2e/run-stage-c-tiktok.sh). One model of the provider: the API paths the adapter calls
 * (auth/verify, accounts, health, creator info, presign, posts, retry) and the presigned upload storage, on one port.
 * The web app and the worker reach it through ZERNIO_API_BASE_URL (`<fake>/api`), which the worker accepts as an
 * upload origin over plain http only when NODE_ENV=test. A second port is the test's control channel:
 *
 *   GET  /state            calls per endpoint, every upload PUT (headers it carried), every create (body, headers),
 *                          retries, the stored posts and any create body that failed the strict contract
 *   POST /scenario         replaces parts of the scenario: { createStatus, createPostStatus, createEntry, retryStatus,
 *                          retryPostStatus, retryEntry, uploadStatus, failOnce, accounts, creatorInfo, health }
 *   POST /posts/:id        changes one stored post like Zernio would: { status, entry, metadata }
 *   POST /calls/reset      forgets the recorded calls (posts and scenario stay)
 *
 *   FAKE_ZERNIO_PORT=… FAKE_CONTROL_PORT=… tsx apps/web/e2e/fake-zernio.ts
 *
 * Prints one JSON line `{"msg":"fake zernio listening",…}` once both ports accept connections. Stops on SIGTERM or
 * SIGINT. Nothing here talks to Zernio.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FAKE_TIKTOK_ACCOUNT_ID, FAKE_ZERNIO_KEY, startFakeZernioServer, type ZernioCall, type ZernioScenario } from '../../worker/test/fakes/zernio-server.js';

function port(name: string): number {
  const p = Number(process.env[name] ?? '0');
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    console.error(`${name} must be a port number.`);
    process.exit(2);
  }
  return p;
}

const fake = await startFakeZernioServer({ port: port('FAKE_ZERNIO_PORT') });

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

const header = (c: ZernioCall, name: string): string | null => {
  const v = c.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : null;
};

function state() {
  const counts: Record<string, number> = {};
  for (const c of fake.calls) counts[c.endpoint] = (counts[c.endpoint] ?? 0) + 1;
  return {
    total: fake.calls.length,
    counts,
    // Whether any request other than the upload carried something other than the expected key.
    badAuth: fake.calls.filter((c) => c.endpoint !== 'upload' && header(c, 'authorization') !== `Bearer ${FAKE_ZERNIO_KEY}`).map((c) => `${c.method} ${c.path}`),
    uploads: fake.calls
      .filter((c) => c.endpoint === 'upload')
      .map((c) => ({
        path: c.path,
        query: c.query,
        authorization: header(c, 'authorization'),
        contentType: header(c, 'content-type'),
        contentLength: header(c, 'content-length'),
        transferEncoding: header(c, 'transfer-encoding'),
        host: header(c, 'host'),
        bytes: c.bytes,
        keyAnywhere: JSON.stringify({ path: c.path, query: c.query, headers: c.headers }).includes(FAKE_ZERNIO_KEY),
      })),
    creates: fake.calls.filter((c) => c.endpoint === 'create').map((c) => ({ body: c.body, idempotencyKey: header(c, 'idempotency-key'), contentType: header(c, 'content-type') })),
    presigns: fake.calls.filter((c) => c.endpoint === 'presign').map((c) => c.body),
    retries: fake.calls.filter((c) => c.endpoint === 'retry').map((c) => ({ path: c.path, body: c.body, bytes: c.bytes })),
    reads: fake.calls.filter((c) => c.endpoint === 'get_post').map((c) => c.path),
    unknown: fake.calls.filter((c) => c.endpoint === 'unknown').map((c) => `${c.method} ${c.path}`),
    invalidBodies: fake.invalidBodies,
    posts: [...fake.posts.values()],
  };
}

const SCENARIO_KEYS = ['createStatus', 'createPostStatus', 'createEntry', 'retryStatus', 'retryPostStatus', 'retryEntry', 'uploadStatus', 'failOnce', 'accounts', 'creatorInfo', 'health'] as const;

const control = createServer((req, res) => {
  void (async () => {
    const u = new URL(req.url ?? '/', 'http://control');
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' && u.pathname === '/state') return reply(res, 200, state());
    if (method === 'POST' && u.pathname === '/scenario') {
      const b = await readJson(req);
      const s = fake.scenario as unknown as Record<string, unknown>;
      for (const k of SCENARIO_KEYS) if (k in b) s[k] = b[k];
      return reply(res, 200, { scenario: fake.scenario as ZernioScenario });
    }
    if (method === 'POST' && u.pathname === '/calls/reset') {
      fake.calls.length = 0;
      return reply(res, 200, { ok: true });
    }
    const m = /^\/posts\/([^/]+)$/.exec(u.pathname);
    if (method === 'POST' && m) {
      const b = await readJson(req);
      const id = decodeURIComponent(m[1] ?? '');
      if (!fake.posts.has(id)) return reply(res, 404, { error: 'no such post' });
      fake.setPost(id, {
        ...(typeof b['status'] === 'string' ? { status: b['status'] } : {}),
        ...(b['entry'] && typeof b['entry'] === 'object' ? { entry: b['entry'] as Record<string, unknown> } : {}),
        ...(b['metadata'] && typeof b['metadata'] === 'object' ? { metadata: b['metadata'] as Record<string, unknown> } : {}),
      });
      return reply(res, 200, { post: fake.posts.get(id) });
    }
    return reply(res, 404, { error: 'not found' });
  })().catch((err: unknown) => reply(res, 500, { error: String(err) }));
});
await new Promise<void>((resolve) => control.listen(port('FAKE_CONTROL_PORT'), '127.0.0.1', resolve));
const controlPort = (control.address() as { port: number }).port;
console.log(JSON.stringify({ msg: 'fake zernio listening', url: fake.url, apiBase: fake.apiBase, control: `http://127.0.0.1:${controlPort}`, accountId: FAKE_TIKTOK_ACCOUNT_ID }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void Promise.all([fake.close(), new Promise<void>((r) => control.close(() => r()))]).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
