import { AppError, CancelledError } from '@studio/core';
import type { WorkerContext } from '../../context.js';
import { HttpTimeoutError, httpRequest, readJson } from '../http.js';
import type { EmailProvider, NormalisedEmailEvent, OutboundEmail, ProviderCheck, SendResult } from './provider.js';

/**
 * Postmark over plain `fetch` (no SDK), email design §8.1. Only the server token is used. Endpoint shapes come from
 * Postmark's public API reference (the memo could not read postmarkapp.com); the sandbox smoke test
 * (`scripts/email-smoke.ts`) checks each one before live use, and unknown error codes are stored verbatim.
 */

export const POSTMARK_API_BASE = 'https://api.postmarkapp.com';
/** The webhook path the owner adds in Postmark (checklist step 6). */
export const POSTMARK_WEBHOOK_PATH = '/api/webhooks/postmark';
const SEND_TIMEOUT_MS = 30_000;

interface PostmarkSettings {
  token: string;
  from: string;
  transactionalStream: string;
  broadcastStream: string;
  /** API host; {@link POSTMARK_API_BASE} unless a test points it at a local fake (only under NODE_ENV=test). */
  apiBase?: string;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Maps one `POST /email` response to a send result (design §8.1.1 table). Exported for unit tests.
 */
export function mapSendResponse(status: number, body: Json | null): SendResult {
  const code = num(body?.['ErrorCode']);
  const message = str(body?.['Message']) ?? `HTTP ${status}`;
  if (status === 200 && (code === 0 || code === null)) {
    const id = str(body?.['MessageID']);
    if (id) return { ok: true, providerMessageId: id, submittedAt: str(body?.['SubmittedAt']) ?? new Date().toISOString() };
    return { ok: false, kind: 'unknown_outcome', code: 'no_message_id', message: 'Postmark accepted the request but returned no message id.' };
  }
  const c = code === null ? `http_${status}` : String(code);
  if (status === 412) return { ok: false, kind: 'pending_approval', code: c, message };
  if (status === 401 || code === 10) return { ok: false, kind: 'auth', code: c, message };
  if (status === 429 || status >= 500) return { ok: false, kind: 'transient', code: c, message };
  if (code === 406) return { ok: false, kind: 'inactive_recipient', code: c, message };
  if (code === 300) return { ok: false, kind: 'invalid_recipient', code: c, message };
  if (code === 400 || code === 401) return { ok: false, kind: 'sender_not_verified', code: c, message };
  return { ok: false, kind: 'rejected', code: c, message };
}

function webhookTriggersOk(hook: Json): boolean {
  const triggers = (hook['Triggers'] ?? {}) as Record<string, { Enabled?: unknown } | undefined>;
  return ['Bounce', 'SpamComplaint', 'SubscriptionChange'].every((k) => triggers[k]?.Enabled === true);
}

function hookPathMatches(url: unknown): boolean {
  try {
    return new URL(String(url)).pathname.replace(/\/+$/, '') === POSTMARK_WEBHOOK_PATH;
  } catch {
    return false;
  }
}

/**
 * Normalises Postmark webhook records (design §8.1.5). Unknown record types (`Open`, `Click`, …) are `ignored`.
 * Exported for unit tests against the fixtures in `test/fixtures/postmark/`.
 */
export function parsePostmarkWebhook(body: unknown): NormalisedEmailEvent[] {
  const records = Array.isArray(body) ? body : [body];
  const out: NormalisedEmailEvent[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Json;
    const type = str(rec['RecordType']);
    const stream = str(rec['MessageStream']);
    const providerMessageId = str(rec['MessageID']);
    const base = { providerMessageId, stream, hard: false, suppressSending: null, suppressionReason: null } as const;
    switch (type) {
      case 'Delivery':
        out.push({ ...base, type: 'delivered', email: str(rec['Recipient']), occurredAt: str(rec['DeliveredAt']) ?? new Date().toISOString() });
        break;
      case 'Bounce': {
        const bounceType = str(rec['Type']) ?? 'Unknown';
        out.push({ ...base, type: 'bounced', email: str(rec['Email']), occurredAt: str(rec['BouncedAt']) ?? new Date().toISOString(), hard: bounceType === 'HardBounce' || rec['Inactive'] === true, suppressionReason: bounceType });
        break;
      }
      case 'SpamComplaint':
        out.push({ ...base, type: 'complained', email: str(rec['Email']), occurredAt: str(rec['BouncedAt']) ?? new Date().toISOString(), hard: true, suppressionReason: 'SpamComplaint' });
        break;
      case 'SubscriptionChange':
        out.push({
          ...base,
          type: 'subscription_change',
          email: str(rec['Recipient']),
          occurredAt: str(rec['ChangedAt']) ?? new Date().toISOString(),
          suppressSending: typeof rec['SuppressSending'] === 'boolean' ? rec['SuppressSending'] : null,
          suppressionReason: str(rec['SuppressionReason']),
        });
        break;
      default:
        out.push({ ...base, type: 'ignored', email: null, occurredAt: new Date().toISOString() });
    }
  }
  return out;
}

/** Postmark behind the {@link EmailProvider} interface. */
export class PostmarkProvider implements EmailProvider {
  readonly name = 'postmark' as const;

  constructor(
    private readonly ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
    private readonly settings: PostmarkSettings,
  ) {}

  private headers(json = false): Record<string, string> {
    return { Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), 'X-Postmark-Server-Token': this.settings.token };
  }

  private streamId(stream: 'transactional' | 'broadcast'): string {
    return stream === 'broadcast' ? this.settings.broadcastStream : this.settings.transactionalStream;
  }

  /** Postmark's API host, or the local fake a test configured (see `postmarkSettings`). */
  private get base(): string {
    return this.settings.apiBase ?? POSTMARK_API_BASE;
  }

  private async get(path: string, label: string, signal: AbortSignal): Promise<{ status: number; body: Json | null }> {
    const res = await httpRequest(this.ctx, `${this.base}${path}`, { method: 'GET', headers: this.headers() }, { label, signal });
    return { status: res.status, body: (await readJson(res)) as Json | null };
  }

  async check(signal: AbortSignal): Promise<ProviderCheck> {
    const server = await this.get('/server', 'postmark.server', signal);
    if (server.status === 401 || num(server.body?.['ErrorCode']) === 10) {
      return { state: 'needs_reauth', deliveryType: 'unknown', streams: { transactional: false, broadcast: false }, webhooks: { configured: null }, serverName: '', message: 'Postmark rejected the server token. Replace POSTMARK_SERVER_TOKEN on the server.' };
    }
    if (server.status !== 200 || !server.body) {
      return { state: 'error', deliveryType: 'unknown', streams: { transactional: false, broadcast: false }, webhooks: { configured: null }, serverName: '', message: `Postmark did not answer the check (HTTP ${server.status}).` };
    }
    const serverName = str(server.body['Name']) ?? '';
    const dt = str(server.body['DeliveryType']);
    const deliveryType = dt === 'Sandbox' ? 'sandbox' : dt === 'Live' ? 'live' : 'unknown';

    const streamsRes = await this.get('/message-streams', 'postmark.message_streams', signal);
    const list = Array.isArray(streamsRes.body?.['MessageStreams']) ? (streamsRes.body?.['MessageStreams'] as Json[]) : [];
    const found = (id: string, type: string) => list.some((s) => s['ID'] === id && s['MessageStreamType'] === type && !s['ArchivedAt']);
    const streams = { transactional: found(this.settings.transactionalStream, 'Transactional'), broadcast: found(this.settings.broadcastStream, 'Broadcasts') };

    let configured: boolean | null = true;
    for (const id of [this.settings.transactionalStream, this.settings.broadcastStream]) {
      const hooks = await this.get(`/webhooks?MessageStream=${encodeURIComponent(id)}`, 'postmark.webhooks', signal);
      if (hooks.status !== 200 || !Array.isArray(hooks.body?.['Webhooks'])) {
        configured = null;
        break;
      }
      const ok = (hooks.body?.['Webhooks'] as Json[]).some((h) => hookPathMatches(h['Url']) && webhookTriggersOk(h));
      if (!ok) configured = false;
    }

    const missingStreams = [!streams.transactional ? `the Transactional stream "${this.settings.transactionalStream}"` : null, !streams.broadcast ? `the Broadcast stream "${this.settings.broadcastStream}"` : null].filter(Boolean);
    if (missingStreams.length) {
      return { state: 'error', deliveryType, streams, webhooks: { configured }, serverName, message: `Postmark has no ${missingStreams.join(' or ')}. Check the stream IDs on the server.` };
    }
    if (configured === false) {
      return { state: 'needs_attention', deliveryType, streams, webhooks: { configured }, serverName, message: "Bounces and unsubscribes made through Postmark won't reach the app. Add the webhook (step 6 of the checklist)." };
    }
    return { state: 'connected', deliveryType, streams, webhooks: { configured }, serverName, message: '' };
  }

  async send(msg: OutboundEmail, signal: AbortSignal): Promise<SendResult> {
    const body = {
      From: msg.from,
      To: msg.to,
      ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
      Subject: msg.subject,
      HtmlBody: msg.html,
      TextBody: msg.text,
      MessageStream: this.streamId(msg.stream),
      Tag: msg.tag,
      Metadata: msg.metadata,
      TrackOpens: false,
      TrackLinks: 'None',
    };
    let res: Response;
    try {
      res = await httpRequest(this.ctx, `${this.base}/email`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) }, { label: 'postmark.send', signal, timeoutMs: SEND_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // The request may have reached Postmark: never assume it did not. The retry looks it up first.
      const message = err instanceof HttpTimeoutError ? 'Postmark did not answer in time.' : err instanceof AppError ? err.message : 'Postmark could not be reached.';
      return { ok: false, kind: 'unknown_outcome', code: 'network', message };
    }
    return mapSendResponse(res.status, (await readJson(res)) as Json | null);
  }

  async findSent(emailMessageId: string, to: string, signal: AbortSignal): Promise<string | null> {
    const q = new URLSearchParams({ count: '10', offset: '0', recipient: to, metadata_emailMessageId: emailMessageId });
    const res = await this.get(`/messages/outbound?${q.toString()}`, 'postmark.find_sent', signal);
    if (res.status !== 200 || !res.body) throw new AppError('PROCESSING_FAILED', `Postmark's message search did not answer (HTTP ${res.status}).`);
    const total = num(res.body['TotalCount']) ?? 0;
    const messages = Array.isArray(res.body['Messages']) ? (res.body['Messages'] as Json[]) : [];
    if (total < 1 || !messages.length) return null;
    // More than one match would mean we cannot tell which one is ours: treat as "not sure" (owner check).
    if (total > 1) return null;
    return str(messages[0]?.['MessageID']);
  }

  async suppress(email: string, stream: 'transactional' | 'broadcast', signal: AbortSignal): Promise<void> {
    const res = await httpRequest(
      this.ctx,
      `${this.base}/message-streams/${encodeURIComponent(this.streamId(stream))}/suppressions`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify({ Suppressions: [{ EmailAddress: email }] }) },
      { label: 'postmark.suppress', signal },
    );
    const body = (await readJson(res)) as Json | null;
    const first = Array.isArray(body?.['Suppressions']) ? ((body?.['Suppressions'] as Json[])[0] ?? null) : null;
    if (res.status !== 200 || str(first?.['Status']) !== 'Suppressed') {
      throw new AppError('PROCESSING_FAILED', `Postmark did not add the address to its suppression list (HTTP ${res.status}${first ? `, ${String(first['Status'])}` : ''}).`);
    }
  }

  parseWebhook(body: unknown): NormalisedEmailEvent[] {
    return parsePostmarkWebhook(body);
  }
}
