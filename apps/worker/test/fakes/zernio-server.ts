import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ZernioCreatePostBodySchema } from '@studio/core';

/**
 * A local fake of the Zernio API (docs/research/zernio-api.md) and of its presigned upload storage, for tests only.
 * It serves every path the adapter calls, records every request (headers included) and checks the create body
 * against the strict Zod contract, so tests can assert that nothing unknown is sent and nothing is posted twice.
 * No real Zernio endpoint is ever contacted.
 */

/** One recorded request. */
export interface ZernioCall {
  endpoint: ZernioEndpoint | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  bytes: number;
}

export type ZernioEndpoint = 'verify' | 'accounts' | 'health' | 'creator_info' | 'presign' | 'upload' | 'create' | 'get_post' | 'list_posts' | 'retry';

/** A scripted error answer. */
export interface FakeZernioError {
  status: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** What the fake does; tests change it between steps. */
export interface ZernioScenario {
  key: string;
  accounts: Array<Record<string, unknown>>;
  /** Health per account id (missing = healthy Business lane). */
  health: Record<string, Record<string, unknown>>;
  creatorInfo: Record<string, unknown>;
  /** Errors returned once per endpoint (consumed when used). */
  failOnce: Partial<Record<ZernioEndpoint, FakeZernioError>>;
  /** Status the upload storage answers (200 = accepted). */
  uploadStatus: number;
  /** HTTP status of a new create (201, or 207 with `createPostStatus`). */
  createStatus: number;
  /** `post.status` and TikTok entry of a new post. */
  createPostStatus: string;
  createEntry: Record<string, unknown>;
  /** Create the post, then drop the connection without answering (a crash or time-out after the call). */
  dropAfterCreate: boolean;
  /** Answer of `/retry` (status and the post's new state). */
  retryStatus: number;
  retryPostStatus: string;
  retryEntry: Record<string, unknown>;
}

export interface FakeZernioServer {
  url: string;
  /** The API base URL to put in ZERNIO_API_BASE_URL. */
  apiBase: string;
  scenario: ZernioScenario;
  calls: ZernioCall[];
  posts: Map<string, Record<string, unknown>>;
  /** Create bodies that failed the strict contract (should stay empty). */
  invalidBodies: Array<{ body: unknown; issues: string }>;
  count: (endpoint: ZernioEndpoint) => number;
  /** Replaces the TikTok entry (and optionally the status) of a stored post. */
  setPost: (id: string, change: { status?: string; entry?: Record<string, unknown>; metadata?: Record<string, unknown> }) => void;
  /** Adds a post the adapter did not create (for duplicate and lookup cases). */
  addPost: (post: Record<string, unknown>) => string;
  reset: () => void;
  close: () => Promise<void>;
}

export const FAKE_ZERNIO_KEY = 'sk_fake_0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
export const FAKE_TIKTOK_ACCOUNT_ID = '66b2e19d8c3f5a7e9d0b1c2d';

function defaultScenario(): ZernioScenario {
  return {
    key: FAKE_ZERNIO_KEY,
    accounts: [{ _id: FAKE_TIKTOK_ACCOUNT_ID, platform: 'tiktok', profileId: 'p1', isActive: true, username: 'ivanhoe_studio_test', displayName: 'Ivanhoe Studio (test)', needsReconnection: false, rateLimitedUntil: null, tiktokAccountType: 'business' }],
    health: {},
    creatorInfo: {
      creator: { nickname: 'Ivanhoe Studio (test)', canPostMore: true },
      privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' }, { value: 'SELF_ONLY', label: 'Only me' }],
      postingLimits: {
        maxVideoDurationSec: 600,
        interactionSettings: {
          allow_comment: { enabled: true, required: true, default: true, label: 'Comments' },
          allow_duet: { enabled: true, required: true, default: false, label: 'Duet' },
          allow_stitch: { enabled: false, required: true, default: false, label: 'Stitch' },
        },
      },
    },
    failOnce: {},
    uploadStatus: 200,
    createStatus: 201,
    createPostStatus: 'publishing',
    createEntry: { status: 'processing' },
    dropAfterCreate: false,
    retryStatus: 200,
    retryPostStatus: 'publishing',
    retryEntry: { status: 'processing', errorMessage: null },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the fake on a free port of 127.0.0.1. */
export async function startFakeZernioServer(): Promise<FakeZernioServer> {
  let scenario = defaultScenario();
  const calls: ZernioCall[] = [];
  const posts = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, string>();
  const invalidBodies: FakeZernioServer['invalidBodies'] = [];
  const uploads = new Map<string, number>();
  let seq = 0;
  let base = '';

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const newPostId = () => `65f1c0a9e2b5af00${String(++seq).padStart(8, '0')}`;
  const tiktokEntryOf = (post: Record<string, unknown>) => ((post['platforms'] as Array<Record<string, unknown>>) ?? []).find((p) => p['platform'] === 'tiktok');

  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://fake');
      const raw = await readBody(req);
      let body: unknown = null;
      if (raw.length && String(req.headers['content-type'] ?? '').includes('json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = null;
        }
      }
      const path = u.pathname;
      let endpoint: ZernioEndpoint | 'unknown' = 'unknown';
      let m: RegExpExecArray | null;
      if (req.method === 'PUT' && path.startsWith('/upload/')) endpoint = 'upload';
      else if (path === '/api/v1/auth/verify') endpoint = 'verify';
      else if (path === '/api/v1/accounts') endpoint = 'accounts';
      else if (/^\/api\/v1\/accounts\/[^/]+\/health$/.test(path)) endpoint = 'health';
      else if (/^\/api\/v1\/accounts\/[^/]+\/tiktok\/creator-info$/.test(path)) endpoint = 'creator_info';
      else if (path === '/api/v1/media/presign') endpoint = 'presign';
      else if (path === '/api/v1/posts' && req.method === 'POST') endpoint = 'create';
      else if (path === '/api/v1/posts' && req.method === 'GET') endpoint = 'list_posts';
      else if (/^\/api\/v1\/posts\/[^/]+\/retry$/.test(path)) endpoint = 'retry';
      else if (/^\/api\/v1\/posts\/[^/]+$/.test(path)) endpoint = 'get_post';
      calls.push({ endpoint, method: req.method ?? 'GET', path, query: Object.fromEntries(u.searchParams), headers: req.headers, body, bytes: raw.length });

      if (endpoint !== 'upload' && endpoint !== 'unknown' && req.headers.authorization !== `Bearer ${scenario.key}`) {
        return send(res, 401, { error: 'Invalid API key', type: 'authentication_error', code: 'invalid_credentials' });
      }
      const fail = endpoint !== 'unknown' ? scenario.failOnce[endpoint] : undefined;
      if (fail && endpoint !== 'unknown') {
        delete scenario.failOnce[endpoint];
        return send(res, fail.status, fail.body ?? { error: `Fake ${endpoint} failure` }, fail.headers);
      }
      switch (endpoint) {
        case 'verify':
          return send(res, 200, { valid: true });
        case 'accounts':
          return send(res, 200, { accounts: scenario.accounts.filter((a) => !u.searchParams.get('platform') || a['platform'] === u.searchParams.get('platform')), hasAnalyticsAccess: false });
        case 'health': {
          const id = decodeURIComponent(path.split('/')[4] ?? '');
          if (scenario.health[id]) return send(res, 200, scenario.health[id]);
          if (!scenario.accounts.some((a) => a['_id'] === id)) return send(res, 404, { error: 'Account not found', type: 'invalid_request_error', code: 'not_found' });
          return send(res, 200, { platform: 'tiktok', status: 'healthy', integrationLane: 'business', tokenStatus: { valid: true }, permissions: { canPost: true, missingRequired: [] } });
        }
        case 'creator_info':
          return send(res, 200, scenario.creatorInfo);
        case 'presign': {
          const key = `uploads/${++seq}-${String((body as Record<string, unknown>)?.['filename'] ?? 'file')}`;
          return send(res, 200, { uploadUrl: `${base}/upload/${encodeURIComponent(key)}?X-Amz-Signature=fake`, publicUrl: `https://media.zernio.example/${key}`, key, expiresIn: 3600 });
        }
        case 'upload':
          uploads.set(path, raw.length);
          res.writeHead(scenario.uploadStatus, scenario.uploadStatus === 200 ? { etag: '"fake-etag"' } : {});
          return res.end();
        case 'create': {
          const parsed = ZernioCreatePostBodySchema.safeParse(body);
          if (!parsed.success) invalidBodies.push({ body, issues: parsed.error.message });
          const ikey = String(req.headers['idempotency-key'] ?? '');
          const prior = ikey ? idempotency.get(ikey) : undefined;
          if (prior && posts.has(prior)) return send(res, 200, { message: 'Post already exists (idempotent retry)', post: posts.get(prior) });
          const b = (body ?? {}) as Record<string, unknown>;
          const id = newPostId();
          const accountId = String(((b['platforms'] as Array<Record<string, unknown>>) ?? [])[0]?.['accountId'] ?? '');
          const post: Record<string, unknown> = {
            _id: id,
            status: scenario.createPostStatus,
            content: b['content'],
            metadata: b['metadata'] ?? {},
            platforms: [{ platform: 'tiktok', accountId, status: 'pending', platformPostUrl: null, platformSpecificData: { ...((b['tiktokSettings'] as Record<string, unknown>) ?? {}) }, ...scenario.createEntry }],
            updatedAt: new Date().toISOString(),
          };
          posts.set(id, post);
          if (ikey) idempotency.set(ikey, id);
          if (scenario.dropAfterCreate) {
            scenario.dropAfterCreate = false;
            req.socket.destroy();
            return;
          }
          return send(res, scenario.createStatus, { message: 'Post created', post, warnings: [] });
        }
        case 'get_post': {
          const id = decodeURIComponent(path.split('/')[4] ?? '');
          const post = posts.get(id);
          return post ? send(res, 200, { post }) : send(res, 404, { error: 'Post not found', type: 'invalid_request_error', code: 'not_found' });
        }
        case 'list_posts': {
          const allowed = new Set(['updatedSince', 'accountId', 'fields']);
          const bad = [...u.searchParams.keys()].find((k) => !allowed.has(k));
          if (bad) return send(res, 400, { error: `Unknown query parameter ${bad}`, type: 'invalid_request_error', code: 'invalid_parameter' });
          const accountId = u.searchParams.get('accountId');
          const list = [...posts.values()].filter((p) => !accountId || tiktokEntryOf(p)?.['accountId'] === accountId);
          return send(res, 200, { posts: list });
        }
        case 'retry': {
          const id = decodeURIComponent(path.split('/')[4] ?? '');
          const post = posts.get(id);
          if (!post) return send(res, 404, { error: 'Post not found' });
          if (scenario.retryStatus >= 400) return send(res, scenario.retryStatus, { error: 'Retry refused' });
          post['status'] = scenario.retryPostStatus;
          const entry = tiktokEntryOf(post);
          if (entry) Object.assign(entry, scenario.retryEntry);
          return send(res, scenario.retryStatus, { post });
        }
        default:
          return send(res, 404, { error: 'Unknown path in the fake' });
      }
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    apiBase: `${base}/api`,
    get scenario() {
      return scenario;
    },
    set scenario(s: ZernioScenario) {
      scenario = s;
    },
    calls,
    posts,
    invalidBodies,
    count: (endpoint) => calls.filter((c) => c.endpoint === endpoint).length,
    setPost: (id, change) => {
      const post = posts.get(id);
      if (!post) throw new Error(`no fake post ${id}`);
      if (change.status) post['status'] = change.status;
      if (change.metadata) post['metadata'] = change.metadata;
      const entry = tiktokEntryOf(post);
      if (entry && change.entry) Object.assign(entry, change.entry);
      post['updatedAt'] = new Date().toISOString();
    },
    addPost: (post) => {
      const id = String(post['_id'] ?? newPostId());
      posts.set(id, { ...post, _id: id });
      return id;
    },
    reset: () => {
      scenario = defaultScenario();
      calls.length = 0;
      invalidBodies.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  } as FakeZernioServer;
}
