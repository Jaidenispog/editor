import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { CancelledError } from '@studio/core';
import { BlockedHostError, resolveSafeAddress, systemResolver, type HostResolver } from './ssrf.js';

/**
 * The website crawler's HTTP client (design §7.1). Stricter than `lib/http.ts`: GET and HEAD only, no cookies, no
 * authentication, no JavaScript, every host resolved and checked by the SSRF guard and the connection pinned to the
 * checked address, ports 80/443 only, redirects never followed automatically (callers re-validate every hop), size and
 * time caps, at most 400 requests per check, and polite spacing between requests to the owner's site.
 */

export const AUDIT_USER_AGENT = 'StudioAssistantAudit/1.0 (website check requested by the site owner)';
export const CONNECT_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_REQUESTS_PER_CHECK = 400;
export const MAX_REDIRECTS = 5;
/** Minimum gap between requests to the owner's site. */
export const POLITE_INTERVAL_MS = 500;
/**
 * A check spends at most this long waiting between requests to the owner's site (robots.txt `Crawl-delay` makes the
 * gap longer): every owner-site request after the first costs one gap, so with `Crawl-delay: 10` at most 72 more
 * requests are made. This keeps a check well inside the job's 20-minute limit.
 */
export const MAX_POLITE_WAIT_MS = 12 * 60_000;

/** Who may be connected to. Production uses {@link DEFAULT_FETCH_POLICY}; only tests build another one in code. */
export interface FetchPolicy {
  /** Tests only: allow 127.0.0.1 / ::1 so a local fixture server can stand in for a website. */
  allowLoopback: boolean;
  /** Tests only: connect to this port instead of 80 (plain http) — the fixture server's real port. */
  testHttpPort?: number;
  /** Host resolver (tests map fixture host names to 127.0.0.1, or simulate DNS rebinding). */
  resolver?: HostResolver;
  /** Gap between requests to the owner's site in milliseconds (default 500; tests use less). */
  politeIntervalMs?: number;
  /** Time limits (tests shorten them). */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** The production policy: no loopback, real DNS, real ports, 500 ms spacing. */
export const DEFAULT_FETCH_POLICY: FetchPolicy = { allowLoopback: false };

/** One response, reduced to what the check needs. Never contains cookies or credentials. */
export interface FetchResult {
  url: string;
  method: 'GET' | 'HEAD';
  status: number | null;
  headers: Record<string, string>;
  /** Decompressed body (GET only), capped at `maxBytes`. */
  body: Buffer | null;
  /** The body was longer than `maxBytes` (reading stopped). */
  truncated: boolean;
  ttfbMs: number | null;
  totalMs: number | null;
  /** Sent with gzip, br or deflate. */
  compressed: boolean | null;
  /** Bytes on the wire (from Content-Length, or counted). */
  transferBytes: number | null;
  /** The `Location` header of a redirect. */
  location: string | null;
  /** Plain reason when there was no HTTP answer. */
  error: string | null;
  /** True when the SSRF guard refused the host (nothing was sent). */
  blocked: boolean;
}

/** One logged request (for tests and the smoke script; no headers, no bodies). */
export interface RequestLogEntry {
  method: 'GET' | 'HEAD';
  url: string;
  status: number | null;
  at: number;
}

/** Options for one request. */
export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  accept?: string;
  /** Extra request headers (only `range` is used, for a first-byte check). */
  range?: string;
  signal?: AbortSignal | undefined;
}

/** Raised when a check reaches its request budget. */
export class RequestBudgetError extends Error {
  constructor() {
    super(`The check reached its limit of ${MAX_REQUESTS_PER_CHECK} requests`);
    this.name = 'RequestBudgetError';
  }
}

/** Raised when another request to the owner's site would take the polite waiting past {@link MAX_POLITE_WAIT_MS}. */
export class PoliteWaitBudgetError extends Error {
  constructor() {
    super('The check reached its limit for waiting between requests to your site');
    this.name = 'PoliteWaitBudgetError';
  }
}

/** A fetcher for one check: counts requests, spaces requests to the owner's hosts and logs every request. */
export class WebsiteFetcher {
  readonly log: RequestLogEntry[] = [];
  private requests = 0;
  private ownerRequests = 0;
  /** Spacing committed so far between requests to the owner's site (an upper bound on the time spent waiting). */
  private ownerSpacingMs = 0;
  private lastOwnerRequestAt = Number.NEGATIVE_INFINITY;
  private intervalMs: number;
  private readonly ownerHosts: Set<string>;

  constructor(
    private readonly policy: FetchPolicy,
    ownerHosts: string[],
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    this.ownerHosts = new Set(ownerHosts.map((h) => h.toLowerCase()));
    this.intervalMs = policy.politeIntervalMs ?? POLITE_INTERVAL_MS;
  }

  /** Requests made so far. */
  get requestCount(): number {
    return this.requests;
  }

  /** Uses a longer gap (robots.txt `Crawl-delay`) when it is longer than the default. */
  setCrawlDelay(seconds: number | null): void {
    if (seconds !== null && seconds * 1000 > this.intervalMs) this.intervalMs = Math.round(seconds * 1000);
  }

  /**
   * How many more requests to the owner's site fit in the polite-wait budget at the current gap (the first request to
   * the site costs no gap). Lets a crawl keep budget for what matters most (the home page) before optional requests.
   */
  get ownerRequestsLeft(): number {
    const spacing = Math.floor((MAX_POLITE_WAIT_MS - this.ownerSpacingMs) / Math.max(1, this.intervalMs));
    return (this.ownerRequests === 0 ? 1 : 0) + Math.max(0, spacing);
  }

  /** Current gap between requests to the owner's site, in milliseconds. */
  get politeIntervalMs(): number {
    return this.intervalMs;
  }

  /** One request, no redirects followed. HTTP error statuses are returned, not thrown; network problems are in `error`. */
  async request(url: string, options: RequestOptions = {}): Promise<FetchResult> {
    const method = options.method ?? 'GET';
    const base: FetchResult = {
      url,
      method,
      status: null,
      headers: {},
      body: null,
      truncated: false,
      ttfbMs: null,
      totalMs: null,
      compressed: null,
      transferBytes: null,
      location: null,
      error: null,
      blocked: false,
    };
    if (options.signal?.aborted) throw abortReason(options.signal);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ...base, error: 'Not a valid address' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return {
        ...base,
        error: 'Only http and https addresses are checked',
        blocked: true,
      };
    if (u.username || u.password)
      return {
        ...base,
        error: 'Addresses with a user name or password are not checked',
        blocked: true,
      };
    const defaultPort = u.protocol === 'https:' ? 443 : 80;
    if (u.port && Number(u.port) !== defaultPort)
      return {
        ...base,
        error: 'Only the standard web ports (80 and 443) are checked',
        blocked: true,
      };
    if (this.requests >= MAX_REQUESTS_PER_CHECK) throw new RequestBudgetError();
    const host = u.hostname.toLowerCase();
    let pinned: { address: string; family: number };
    try {
      pinned = await resolveSafeAddress(host, this.policy, this.policy.resolver ?? systemResolver);
    } catch (err) {
      if (err instanceof BlockedHostError) {
        this.log.push({ method, url, status: null, at: this.now() });
        return {
          ...base,
          error: err.message,
          blocked: err.reason !== 'unresolvable',
        };
      }
      throw err;
    }
    if (this.ownerHosts.has(host)) {
      // The polite-wait budget: refuse (before sending anything) a request whose gap would pass the 12-minute cap.
      if (this.ownerRequests > 0) {
        if (this.ownerSpacingMs + this.intervalMs > MAX_POLITE_WAIT_MS) throw new PoliteWaitBudgetError();
        this.ownerSpacingMs += this.intervalMs;
      }
      this.ownerRequests++;
      const wait = this.lastOwnerRequestAt + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait, options.signal);
      this.lastOwnerRequestAt = this.now();
    }
    this.requests++;
    const result = await this.send(u, pinned, method, options);
    this.log.push({ method, url, status: result.status, at: this.now() });
    return result;
  }

  private send(u: URL, pinned: { address: string; family: number }, method: 'GET' | 'HEAD', options: RequestOptions): Promise<FetchResult> {
    const isHttps = u.protocol === 'https:';
    const port = !isHttps && this.policy.testHttpPort ? this.policy.testHttpPort : isHttps ? 443 : 80;
    const lookup: LookupFunction = (_hostname, opts, cb) => {
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    };
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const started = this.now();
    const headers: Record<string, string> = {
      'user-agent': AUDIT_USER_AGENT,
      accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'accept-language': 'en-AU,en;q=0.8',
      'accept-encoding': 'gzip, br',
    };
    if (options.range) headers['range'] = options.range;
    const timeoutMs = this.policy.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const connectTimeoutMs = this.policy.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const base: FetchResult = {
      url: u.toString(),
      method,
      status: null,
      headers: {},
      body: null,
      truncated: false,
      ttfbMs: null,
      totalMs: null,
      compressed: null,
      transferBytes: null,
      location: null,
      error: null,
      blocked: false,
    };

    return new Promise<FetchResult>((resolve, reject) => {
      let settled = false;
      const finish = (r: FetchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ ...r, totalMs: r.totalMs ?? this.now() - started });
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        options.signal?.removeEventListener('abort', onAbort);
        reject(err);
      };
      const req = (isHttps ? https : http).request({
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        lookup,
        agent: false,
        timeout: connectTimeoutMs,
      });
      const total = setTimeout(() => {
        req.destroy();
        finish({
          ...base,
          error: `The server didn't answer within ${Math.round(timeoutMs / 1000)} seconds`,
        });
      }, timeoutMs);
      const onAbort = () => {
        req.destroy();
        fail(abortReason(options.signal));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('timeout', () => {
        req.destroy();
        finish({
          ...base,
          error: `The server didn't answer within ${Math.round(connectTimeoutMs / 1000)} seconds`,
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => finish({ ...base, error: plainNetworkError(err) }));
      req.on('response', (res) => {
        req.setTimeout(0);
        const ttfbMs = this.now() - started;
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== 'set-cookie') resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        const encoding = (resHeaders['content-encoding'] ?? '').toLowerCase();
        const compressed = /gzip|br|deflate/.test(encoding);
        const status = res.statusCode ?? null;
        const contentLength = resHeaders['content-length'] ? Number(resHeaders['content-length']) : null;
        const common = {
          ...base,
          status,
          headers: resHeaders,
          ttfbMs,
          compressed,
          location: resHeaders['location'] ?? null,
        };
        if (method === 'HEAD' || (status !== null && status >= 300 && status < 400)) {
          res.resume();
          res.on('end', () =>
            finish({
              ...common,
              transferBytes: Number.isFinite(contentLength) ? contentLength : null,
            }),
          );
          res.on('error', () =>
            finish({
              ...common,
              transferBytes: Number.isFinite(contentLength) ? contentLength : null,
            }),
          );
          return;
        }
        let wire = 0;
        res.on('data', (c: Buffer) => {
          wire += c.length;
        });
        let stream: Readable = res;
        if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
        else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          if (size + c.length > maxBytes) {
            chunks.push(c.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            res.destroy();
            finish({
              ...common,
              body: Buffer.concat(chunks),
              truncated: true,
              transferBytes: Number.isFinite(contentLength) ? contentLength : wire,
            });
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        stream.on('end', () =>
          finish({
            ...common,
            body: Buffer.concat(chunks),
            truncated,
            transferBytes: Number.isFinite(contentLength) ? contentLength : wire,
          }),
        );
        stream.on('error', () =>
          finish({
            ...common,
            body: Buffer.concat(chunks),
            truncated,
            transferBytes: wire,
            error: chunks.length ? null : 'The page could not be read',
          }),
        );
      });
      req.end();
    });
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const r: unknown = signal?.reason;
  return r instanceof Error ? r : new CancelledError('Stopped');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Plain words for a network failure (never the raw stack). */
export function plainNetworkError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The address could not be found';
    case 'ECONNREFUSED':
      return 'The server refused the connection';
    case 'ECONNRESET':
      return 'The server closed the connection';
    case 'ETIMEDOUT':
      return "The server didn't answer in time";
    case 'CERT_HAS_EXPIRED':
      return "The site's security certificate has expired";
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return "The site's security certificate isn't valid";
    default:
      return 'The server could not be reached';
  }
}

/** A request followed through redirects (each hop re-validated). */
export interface FollowResult {
  final: FetchResult;
  /** Addresses visited before the final one. */
  chain: string[];
  /** A redirect pointed outside the allowed area and was not followed. */
  leftScope: string | null;
}

/**
 * Follows redirects by hand, up to five hops. Every `Location` is resolved against the current address and must pass
 * `allowHop` (the crawl scope for the owner's pages); the SSRF guard checks every hop again inside `request`.
 */
export async function followRedirects(fetcher: WebsiteFetcher, url: string, options: RequestOptions & { allowHop: (next: string) => boolean }): Promise<FollowResult> {
  const chain: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetcher.request(current, options);
    if (res.status === null || res.status < 300 || res.status >= 400 || !res.location) return { final: res, chain, leftScope: null };
    let next: string;
    try {
      next = new URL(res.location, current).toString();
    } catch {
      return { final: res, chain, leftScope: null };
    }
    if (!options.allowHop(next)) return { final: res, chain: [...chain, current], leftScope: next };
    if (hop >= MAX_REDIRECTS - 1)
      return {
        final: { ...res, error: 'Too many redirects' },
        chain: [...chain, current],
        leftScope: null,
      };
    chain.push(current);
    current = next;
  }
}
