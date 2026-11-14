import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local fake of Postmark's API host (api.postmarkapp.com), for tests only. It answers the calls the worker's
 * `PostmarkProvider` makes (`apps/worker/src/lib/email/postmark.ts`, email design §8.1) with Postmark's documented JSON
 * shapes (PascalCase): the read-only check (`GET /server`, `GET /message-streams`, `GET /webhooks`), `POST /email`,
 * the outbound message search used after an unknown outcome, and adding a suppression. The worker reaches it through
 * `POSTMARK_API_BASE_URL`, which is honoured only when NODE_ENV=test. Nothing is ever delivered to anyone: every
 * accepted email is only recorded in {@link FakePostmarkServer.sends}.
 *
 * `hold(true)` makes every `POST /email` wait (recorded in {@link FakePostmarkServer.held}) until `release()`, so a
 * test can act while a send is in flight (pause a campaign, deliver a webhook) without depending on timing.
 */

/** What the fake answers. */
export interface PostmarkScenario {
  /** The server token it accepts (`X-Postmark-Server-Token`). */
  serverToken: string;
  serverName: string;
  /** `Live` or `Sandbox` (a Sandbox server never delivers). */
  deliveryType: 'Live' | 'Sandbox';
  transactionalStream: string;
  broadcastStream: string;
  /** The webhook address registered on both streams with Bounce, SpamComplaint and SubscriptionChange on; null = none. */
  webhookUrl: string | null;
}

/** One accepted `POST /email`. */
export interface FakePostmarkSend {
  messageId: string;
  submittedAt: string;
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  stream: string;
  tag: string | null;
  metadata: Record<string, string>;
}

/** Endpoint names for call counting. */
export type PostmarkEndpoint = 'server' | 'message_streams' | 'webhooks' | 'email' | 'messages_outbound' | 'suppressions' | 'unknown';

export interface FakePostmarkServer {
  url: string;
  scenario: PostmarkScenario;
  /** Every accepted send, in order. */
  sends: FakePostmarkSend[];
  /** Calls per endpoint (including refused ones). */
  counts: Record<PostmarkEndpoint, number>;
  /** Sends currently waiting for {@link release} (recipient addresses). */
  held: () => string[];
  /** While on, each `POST /email` waits until released. */
  hold(on: boolean): void;
  /** Lets every waiting send through (each is then accepted). */
  release(): void;
  close(): Promise<void>;
}

/** Where the fake listens (default 127.0.0.1 on a random port). */
export interface FakePostmarkListenOptions {
  port?: number;
  host?: string;
}

export function defaultPostmarkScenario(): PostmarkScenario {
  return { serverToken: 'fake-postmark-token', serverName: 'Fake Postmark server', deliveryType: 'Live', transactionalStream: 'outbound', broadcastStream: 'broadcast', webhookUrl: null };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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

function endpointFor(method: string, path: string): PostmarkEndpoint {
  if (method === 'GET' && path === '/server') return 'server';
  if (method === 'GET' && path === '/message-streams') return 'message_streams';
  if (method === 'GET' && path === '/webhooks') return 'webhooks';
  if (method === 'POST' && path === '/email') return 'email';
  if (method === 'GET' && path === '/messages/outbound') return 'messages_outbound';
  if (method === 'POST' && /^\/message-streams\/[^/]+\/suppressions$/.test(path)) return 'suppressions';
  return 'unknown';
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Starts the fake. */
export async function startFakePostmarkServer(initial: Partial<PostmarkScenario> = {}, listen: FakePostmarkListenOptions = {}): Promise<FakePostmarkServer> {
  const scenario: PostmarkScenario = { ...defaultPostmarkScenario(), ...initial };
  const sends: FakePostmarkSend[] = [];
  const counts: Record<PostmarkEndpoint, number> = { server: 0, message_streams: 0, webhooks: 0, email: 0, messages_outbound: 0, suppressions: 0, unknown: 0 };
  let holding = false;
  const waiting: Array<{ to: string; go: () => void }> = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://fake');
      const method = (req.method ?? 'GET').toUpperCase();
      const endpoint = endpointFor(method, u.pathname);
      counts[endpoint]++;
      const body = method === 'GET' ? null : await readBody(req);
      if (endpoint === 'unknown') return send(res, 404, { ErrorCode: 404, Message: 'Not found' });
      if (req.headers['x-postmark-server-token'] !== scenario.serverToken) return send(res, 401, { ErrorCode: 10, Message: 'Request does not contain a valid Server token.' });
      switch (endpoint) {
        case 'server':
          return send(res, 200, { ID: 1, Name: scenario.serverName, DeliveryType: scenario.deliveryType, Color: 'blue', SmtpApiActivated: false });
        case 'message_streams':
          return send(res, 200, {
            MessageStreams: [
              { ID: scenario.transactionalStream, ServerID: 1, Name: 'Transactional', MessageStreamType: 'Transactional', ArchivedAt: null },
              { ID: scenario.broadcastStream, ServerID: 1, Name: 'Broadcasts', MessageStreamType: 'Broadcasts', ArchivedAt: null },
            ],
            TotalCount: 2,
          });
        case 'webhooks': {
          const stream = u.searchParams.get('MessageStream') ?? scenario.transactionalStream;
          const on = { Enabled: true };
          const hooks = scenario.webhookUrl
            ? [{ ID: stream === scenario.broadcastStream ? 2 : 1, Url: scenario.webhookUrl, MessageStream: stream, HttpAuth: { Username: '…' }, Triggers: { Delivery: on, Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: on, Open: { Enabled: false }, Click: { Enabled: false } } }]
            : [];
          return send(res, 200, { Webhooks: hooks });
        }
        case 'email': {
          const to = str(body?.['To']) ?? '';
          if (!to || !str(body?.['From'])) return send(res, 422, { ErrorCode: 300, Message: 'Invalid email request' });
          if (holding) await new Promise<void>((go) => waiting.push({ to, go }));
          const record: FakePostmarkSend = {
            messageId: randomUUID(),
            submittedAt: new Date().toISOString(),
            to,
            from: str(body?.['From']) ?? '',
            replyTo: str(body?.['ReplyTo']),
            subject: str(body?.['Subject']) ?? '',
            html: str(body?.['HtmlBody']) ?? '',
            text: str(body?.['TextBody']) ?? '',
            stream: str(body?.['MessageStream']) ?? scenario.transactionalStream,
            tag: str(body?.['Tag']),
            metadata: (body?.['Metadata'] && typeof body['Metadata'] === 'object' ? body['Metadata'] : {}) as Record<string, string>,
          };
          sends.push(record);
          return send(res, 200, { To: to, SubmittedAt: record.submittedAt, MessageID: record.messageId, ErrorCode: 0, Message: 'OK' });
        }
        case 'messages_outbound': {
          const recipient = (u.searchParams.get('recipient') ?? '').toLowerCase();
          const id = u.searchParams.get('metadata_emailMessageId');
          const found = sends.filter((s) => s.to.toLowerCase() === recipient && (!id || s.metadata['emailMessageId'] === id));
          return send(res, 200, { TotalCount: found.length, Messages: found.map((s) => ({ MessageID: s.messageId, To: [{ Email: s.to }], Subject: s.subject, Metadata: s.metadata, ReceivedAt: s.submittedAt, Status: 'Sent' })) });
        }
        case 'suppressions': {
          const list = Array.isArray(body?.['Suppressions']) ? (body?.['Suppressions'] as Array<Record<string, unknown>>) : [];
          return send(res, 200, { Suppressions: list.map((x) => ({ EmailAddress: str(x['EmailAddress']), Status: 'Suppressed', Message: null })) });
        }
        default:
          return send(res, 404, { ErrorCode: 404, Message: 'Not found' });
      }
    })().catch((err: unknown) => send(res, 500, { ErrorCode: 500, Message: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, listen.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const release = () => {
    for (const w of waiting.splice(0)) w.go();
  };
  return {
    url: `http://127.0.0.1:${port}`,
    scenario,
    sends,
    counts,
    held: () => waiting.map((w) => w.to),
    hold(on) {
      holding = on;
    },
    release,
    close: () =>
      new Promise<void>((resolve) => {
        release();
        server.close(() => resolve());
      }),
  };
}
