import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local fake of the two Meta hosts the worker calls (graph.facebook.com and rupload.facebook.com), for tests only.
 * It plays the documented Instagram Reels flow (memo §4) with a scripted scenario and records every call, so tests
 * can assert that nothing is published twice. No real Meta endpoint is ever contacted.
 */

/** A Graph error the fake answers with. */
export interface FakeGraphError {
  status?: number;
  code: number;
  subcode?: number;
  message?: string;
}

/** What the fake does; tests change it between steps. */
export interface GraphScenario {
  version: string;
  token: string;
  igUserId: string;
  username: string;
  tokenType: string;
  tokenValid: boolean;
  scopes: string[];
  expiresAt: number;
  assignedAccounts: Array<{ id: string; username: string }>;
  granularTargets: string[];
  quotaUsage: number;
  quotaTotal: number;
  /** Status codes returned by successive container reads after the upload (the last one repeats). */
  statusSequence: string[];
  /** Status text returned with ERROR. */
  errorStatus: string;
  copyright: { status: string; matches_found: boolean } | null;
  /** Errors to return once per endpoint name (consumed when used). */
  failOnce: Partial<Record<Endpoint, FakeGraphError>>;
  /** Publish, then drop the connection without answering (a crash or time-out after the call). */
  dropAfterPublish: boolean;
  /** Accept the upload body but never answer (to interrupt a run mid-upload). */
  hangUpload: boolean;
}

export type Endpoint = 'debug_token' | 'assigned' | 'ig_user' | 'limit' | 'create' | 'upload' | 'status' | 'copyright' | 'publish' | 'permalink' | 'media_list';

/** One recorded request. */
export interface GraphCall {
  endpoint: Endpoint | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
}

interface Container {
  id: string;
  caption: string;
  thumbOffset: string | null;
  uploadedBytes: number;
  reads: number;
  publishedMediaId: string | null;
  forcedStatus: string | null;
}

export interface FakeGraphServer {
  url: string;
  scenario: GraphScenario;
  calls: GraphCall[];
  containers: Map<string, Container>;
  published: Array<{ mediaId: string; containerId: string; caption: string; at: string }>;
  count(endpoint: Endpoint): number;
  /** Forces a container's status (e.g. EXPIRED). */
  setContainerStatus(id: string, status: string): void;
  reset(partial?: Partial<GraphScenario>): void;
  close(): Promise<void>;
}

export function defaultScenario(): GraphScenario {
  return {
    version: 'v26.0',
    token: 'fake-system-user-token',
    igUserId: '17841400000000001',
    username: 'ivanhoe_studio_test',
    tokenType: 'SYSTEM_USER',
    tokenValid: true,
    scopes: ['instagram_basic', 'instagram_content_publish'],
    expiresAt: 0,
    assignedAccounts: [{ id: '17841400000000001', username: 'ivanhoe_studio_test' }],
    granularTargets: [],
    quotaUsage: 0,
    quotaTotal: 50,
    statusSequence: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'],
    errorStatus: 'Error: unsupported media',
    copyright: { status: 'complete', matches_found: false },
    failOnce: {},
    dropAfterPublish: false,
    hangUpload: false,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function graphError(res: ServerResponse, e: FakeGraphError): void {
  send(res, e.status ?? 400, { error: { message: e.message ?? `Fake Graph error ${e.code}`, type: 'OAuthException', code: e.code, ...(e.subcode ? { error_subcode: e.subcode } : {}), fbtrace_id: 'fake' } });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the fake on 127.0.0.1 (random port). Use `url` for both META_GRAPH_BASE_URL and META_RUPLOAD_BASE_URL. */
export async function startFakeGraphServer(initial: Partial<GraphScenario> = {}): Promise<FakeGraphServer> {
  let scenario: GraphScenario = { ...defaultScenario(), ...initial };
  const calls: GraphCall[] = [];
  const containers = new Map<string, Container>();
  const published: FakeGraphServer['published'] = [];
  let seq = 1;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://fake');
      const query = Object.fromEntries(u.searchParams);
      const isUpload = u.pathname.startsWith('/ig-api-upload/');
      const raw = isUpload && scenario.hangUpload ? Buffer.alloc(0) : await readBody(req);
      const form = req.method === 'POST' && !isUpload ? Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) : {};
      const parts = u.pathname.split('/').filter(Boolean);
      const call: GraphCall = { endpoint: 'unknown', method: req.method ?? 'GET', path: u.pathname, query, form, headers: req.headers, bytes: raw.length };
      calls.push(call);
      const token = query['access_token'] ?? form['access_token'];
      const once = (e: Endpoint): boolean => {
        call.endpoint = e;
        const f = scenario.failOnce[e];
        if (!f) return false;
        delete scenario.failOnce[e];
        graphError(res, f);
        return true;
      };

      if (isUpload) {
        if (once('upload')) return;
        if (scenario.hangUpload) {
          // Swallow the stream and never answer: the test interrupts the run.
          req.on('data', (c: Buffer) => (call.bytes += c.length));
          return;
        }
        const containerId = parts[2] ?? '';
        const c = containers.get(containerId);
        if (req.headers['authorization'] !== `OAuth ${scenario.token}`) return graphError(res, { status: 401, code: 190, message: 'Invalid OAuth access token' });
        if (!c) return graphError(res, { code: 100, message: 'Unknown container' });
        if (req.headers['offset'] !== '0' || Number(req.headers['file_size']) !== raw.length) return graphError(res, { code: 100, message: 'offset/file_size mismatch' });
        c.uploadedBytes = raw.length;
        c.reads = 0;
        return send(res, 200, { success: true, message: 'Upload successful.' });
      }
      if (parts[0] !== scenario.version) return graphError(res, { code: 2500, message: `Unknown version ${parts[0] ?? ''}` });
      const path = parts.slice(1);

      if (path[0] === 'debug_token') {
        if (once('debug_token')) return;
        return send(res, 200, {
          data: {
            app_id: 'fake-app',
            type: scenario.tokenType,
            is_valid: scenario.tokenValid,
            expires_at: scenario.expiresAt,
            scopes: scenario.scopes,
            granular_scopes: scenario.granularTargets.length ? [{ scope: 'instagram_content_publish', target_ids: scenario.granularTargets }] : [],
          },
        });
      }
      if (token !== scenario.token) return graphError(res, { status: 400, code: 190, message: 'Error validating access token' });
      if (!query['appsecret_proof'] && !form['appsecret_proof']) return graphError(res, { code: 100, message: 'appsecret_proof missing' });

      if (path[0] === 'me' && path[1] === 'assigned_instagram_accounts') {
        if (once('assigned')) return;
        return send(res, 200, { data: scenario.assignedAccounts });
      }
      const id = path[0] ?? '';
      if (path[1] === 'content_publishing_limit') {
        if (once('limit')) return;
        return send(res, 200, { data: [{ quota_usage: scenario.quotaUsage, config: { quota_total: scenario.quotaTotal, quota_duration: 86400 } }] });
      }
      if (path[1] === 'media' && req.method === 'POST') {
        if (once('create')) return;
        if (form['media_type'] !== 'REELS' || form['upload_type'] !== 'resumable') return graphError(res, { code: 100, message: 'Expected REELS resumable' });
        const cid = `1790000000${String(seq++).padStart(5, '0')}`;
        containers.set(cid, { id: cid, caption: form['caption'] ?? '', thumbOffset: form['thumb_offset'] ?? null, uploadedBytes: 0, reads: 0, publishedMediaId: null, forcedStatus: null });
        return send(res, 200, { id: cid });
      }
      if (path[1] === 'media' && req.method === 'GET') {
        call.endpoint = 'media_list';
        const items = published.filter(() => id === scenario.igUserId).map((p) => ({ id: p.mediaId, permalink: `https://www.instagram.com/reel/R${p.mediaId}/`, timestamp: p.at, caption: p.caption }));
        return send(res, 200, { data: items.reverse().slice(0, Number(query['limit'] ?? 5)) });
      }
      if (path[1] === 'media_publish') {
        if (once('publish')) return;
        const c = containers.get(form['creation_id'] ?? '');
        if (!c) return graphError(res, { code: 100, message: 'Unknown container' });
        if (c.publishedMediaId) return graphError(res, { code: 100, subcode: 2207008, message: 'Container already published' });
        const mediaId = `1800000000${String(seq++).padStart(5, '0')}`;
        c.publishedMediaId = mediaId;
        published.push({ mediaId, containerId: c.id, caption: c.caption, at: new Date().toISOString() });
        if (scenario.dropAfterPublish) {
          scenario.dropAfterPublish = false;
          req.socket.destroy();
          return;
        }
        return send(res, 200, { id: mediaId });
      }
      const fields = query['fields'] ?? '';
      const c = containers.get(id);
      if (c && fields.includes('status_code')) {
        if (once('status')) return;
        if (c.publishedMediaId) return send(res, 200, { id, status_code: 'PUBLISHED', status: 'Published' });
        if (c.forcedStatus) return send(res, 200, { id, status_code: c.forcedStatus, status: c.forcedStatus === 'ERROR' ? scenario.errorStatus : '' });
        if (c.uploadedBytes === 0) return send(res, 200, { id, status_code: 'IN_PROGRESS', status: 'Waiting for upload' });
        const code = scenario.statusSequence[Math.min(c.reads, scenario.statusSequence.length - 1)] ?? 'FINISHED';
        c.reads++;
        // A container that reached ERROR or EXPIRED stays there (Meta never revives one).
        if (code === 'ERROR' || code === 'EXPIRED') c.forcedStatus = code;
        return send(res, 200, { id, status_code: code, status: code === 'ERROR' ? scenario.errorStatus : '' });
      }
      if (c && fields.includes('copyright_check_status')) {
        if (once('copyright')) return;
        return send(res, 200, { id, ...(scenario.copyright ? { copyright_check_status: scenario.copyright } : {}) });
      }
      if (fields.includes('permalink')) {
        if (once('permalink')) return;
        return send(res, 200, { id, permalink: `https://www.instagram.com/reel/R${id}/` });
      }
      if (fields.includes('username')) {
        if (once('ig_user')) return;
        if (!/^\d+$/.test(id)) return graphError(res, { code: 100, subcode: 33, message: 'Object does not exist or cannot be loaded due to missing permissions' });
        return send(res, 200, { id, username: id === scenario.igUserId ? scenario.username : `account_${id.slice(-4)}` });
      }
      graphError(res, { code: 100, message: `Fake has no answer for ${req.method} ${u.pathname}` });
    })().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: { message: String(err), code: 1 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get scenario() {
      return scenario;
    },
    calls,
    containers,
    published,
    count: (endpoint) => calls.filter((c) => c.endpoint === endpoint).length,
    setContainerStatus: (cid, status) => {
      const c = containers.get(cid);
      if (c) c.forcedStatus = status;
    },
    reset: (partial = {}) => {
      scenario = { ...defaultScenario(), ...partial };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
