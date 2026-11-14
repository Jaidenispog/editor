import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { CancelledError } from '@studio/core';
import type { FetchPolicy } from './fetcher.js';
import { BlockedHostError, resolveSafeAddress, systemResolver } from './ssrf.js';

/**
 * A `fetch` for the WordPress REST API with the crawler's SSRF guard (design §7.1, §7.4.2): the host is resolved and
 * checked by `resolveSafeAddress` (no private, loopback, link-local or reserved address), and the connection is pinned
 * to that checked address, so DNS rebinding cannot swap it. Only https on port 443 (plain http only on a test
 * policy's fixture port), no credentials in the address, and redirects are never followed: a 3xx comes back as it is
 * and the adapter refuses it. The owner's site and its DNS are untrusted, so nothing it answers can steer the worker
 * to another host.
 */

/** The largest WordPress answer read (a page's raw content with its fields). */
export const WORDPRESS_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function abortReason(signal: AbortSignal | null | undefined): Error {
  const r: unknown = signal?.reason;
  return r instanceof Error ? r : new CancelledError('Stopped');
}

/** Builds the guarded fetch for one policy (production: {@link DEFAULT_FETCH_POLICY} in fetcher.ts). */
export function createGuardedFetch(policy: FetchPolicy): typeof fetch {
  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const testHttp = url.protocol === 'http:' && policy.testHttpPort !== undefined;
    if (url.protocol !== 'https:' && !testHttp) throw new BlockedHostError(url.hostname, 'port');
    if (url.username || url.password) throw new BlockedHostError(url.hostname, 'port');
    if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new BlockedHostError(url.hostname, 'port');
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortReason(signal);
    const pinned = await resolveSafeAddress(url.hostname, policy, policy.resolver ?? systemResolver);
    const lookup: LookupFunction = (_hostname, opts, cb) => {
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
      else cb(null, pinned.address, pinned.family);
    };
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (init.body != null && typeof init.body !== 'string') throw new TypeError('The WordPress transport only sends text bodies');
    const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
    if (body) headers['content-length'] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const req = (url.protocol === 'https:' ? https : http).request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: testHttp ? policy.testHttpPort : 443,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? 'GET').toUpperCase(),
        headers,
        lookup,
        agent: false,
        timeout: policy.connectTimeoutMs ?? 10_000,
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      });
      const onAbort = () => {
        req.destroy();
        done(() => reject(abortReason(signal)));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('timeout', () => {
        req.destroy();
        done(() => reject(new Error('The WordPress site did not answer in time')));
      });
      req.on('error', (err) => done(() => reject(err)));
      req.on('response', (res) => {
        req.setTimeout(0);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > WORDPRESS_MAX_RESPONSE_BYTES) {
            res.destroy();
            done(() => reject(new Error('The WordPress answer was too large')));
            return;
          }
          chunks.push(c);
        });
        res.on('error', (err) => done(() => reject(err)));
        res.on('end', () =>
          done(() => {
            const code = res.statusCode ?? 502;
            const status = code >= 200 && code <= 599 ? code : 502;
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== 'set-cookie') out.set(k, Array.isArray(v) ? v.join(', ') : v);
            resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks), { status, headers: out }));
          }),
        );
      });
      if (body) req.write(body);
      req.end();
    });
  };
  return guarded as typeof fetch;
}
