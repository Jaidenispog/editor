import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { AppError, CancelledError } from '@studio/core';
import type { WorkerContext } from '../context.js';

/** Default time limit for one external request. Uploads pass a longer one. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Header names whose values are never logged. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-postmark-server-token', 'x-goog-api-key', 'cookie', 'set-cookie', 'x-api-key']);
/** Query-string, form and JSON field names whose values are never logged. */
const SECRET_FIELDS = new Set(['access_token', 'refresh_token', 'appsecret_proof', 'input_token', 'client_secret', 'code', 'code_verifier', 'token', 'id_token', 'password', 'api_key', 'key']);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Short, stable stand-in for an email address in logs (the same address always gives the same value). */
export function hashEmail(email: string): string {
  return `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
}

/** Replaces every email address in a string with its hash. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, (m) => hashEmail(m));
}

/** A URL with secret query values replaced and emails hashed, safe to log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (SECRET_FIELDS.has(key.toLowerCase())) u.searchParams.set(key, '[redacted]');
    return redactEmails(u.toString());
  } catch {
    return '[unparseable url]';
  }
}

/** Header names and values safe to log (secret headers keep only their name). */
export function redactHeaders(headers: ConstructorParameters<typeof Headers>[0] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, name) => {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? '[redacted]' : redactEmails(value);
  });
  return out;
}

/**
 * Deep copy of a value with secret fields replaced and email addresses hashed. Form-encoded strings
 * (`a=1&code=…`) are redacted field by field. Used for anything an external call might write to a log.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[nested]';
  if (typeof value === 'string') {
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(value)) {
      const params = new URLSearchParams(value);
      for (const key of [...params.keys()]) if (SECRET_FIELDS.has(key.toLowerCase())) params.set(key, '[redacted]');
      return redactEmails(params.toString());
    }
    return redactEmails(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k.toLowerCase()) || SECRET_HEADERS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Thrown when an external request takes longer than its time limit. Transient: the job may retry. */
export class HttpTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'HttpTimeoutError';
  }
}

/** Options for one external request. */
export interface HttpRequestOptions {
  /** Short name for logs, e.g. `google.token` (never contains secrets). */
  label: string;
  /** The run's signal; aborting it (owner cancel, worker shutdown) cancels the request. */
  signal?: AbortSignal | undefined;
  /** Time limit for this request in milliseconds (default 30 s). */
  timeoutMs?: number;
}

/**
 * `fetch` tied to the run's AbortSignal with a per-call time limit, through the context's injectable `fetch`.
 * Logs only the label, method, redacted URL, status and duration. A cancelled run throws CancelledError; a time-out
 * throws HttpTimeoutError. HTTP error statuses are returned, not thrown, so each module maps them itself.
 */
export async function httpRequest(ctx: Pick<WorkerContext, 'fetch' | 'logger'>, url: string, init: RequestInit, options: HttpRequestOptions): Promise<Response> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const started = Date.now();
  const method = (init.method ?? 'GET').toUpperCase();
  const log: Logger = ctx.logger;
  try {
    const res = await fetchImpl(url, { ...init, signal });
    log.debug({ http: { label: options.label, method, url: redactUrl(url), status: res.status, ms: Date.now() - started } }, 'external request');
    return res;
  } catch (err) {
    if (options.signal?.aborted) {
      const reason: unknown = options.signal.reason;
      throw reason instanceof Error ? reason : new CancelledError('Stopped before the request finished');
    }
    if (timeout.aborted) {
      log.warn({ http: { label: options.label, method, url: redactUrl(url), timeoutMs } }, 'external request timed out');
      throw new HttpTimeoutError(options.label, timeoutMs);
    }
    log.warn({ http: { label: options.label, method, url: redactUrl(url), error: redactEmails(err instanceof Error ? err.message : String(err)) } }, 'external request failed');
    throw new AppError('PROCESSING_FAILED', `${options.label} could not be reached`, { cause: err });
  }
}

/** Reads a JSON response body, or null when it is empty or not JSON (never throws). */
export async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}
