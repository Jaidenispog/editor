import { resolveCname, resolveTxt } from 'node:dns/promises';
import { eq } from 'drizzle-orm';
import { newId, senderDomain, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { recordConnectionCheck } from '../lib/connections.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { defaultEmailDeps, postmarkSettings, type EmailDeps } from '../lib/email/provider.js';

/** DNS look-ups used for the advisory hints (injectable for tests; never an error, only a hint). */
export interface DnsLookups {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

const realDns: DnsLookups = { resolveTxt, resolveCname };

/** Advisory DNS hints for the sender domain (design §8.5): DMARC TXT and the custom Return-Path CNAME. */
export async function dnsHints(domain: string, dns: DnsLookups = realDns): Promise<{ dmarcFound: boolean | null; returnPathFound: boolean | null }> {
  const settle = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5_000).unref())]);
    } catch {
      return null;
    }
  };
  const txt = await settle(dns.resolveTxt(`_dmarc.${domain}`));
  const cname = await settle(dns.resolveCname(`pm-bounces.${domain}`));
  return {
    dmarcFound: txt === null ? false : txt.some((parts) => parts.join('').trim().toLowerCase().startsWith('v=dmarc1')),
    returnPathFound: cname === null ? false : cname.length > 0,
  };
}

/** Makes sure the `postmark` connection row exists (one row per provider; no secret is stored in it). */
async function ensurePostmarkRow(ctx: WorkerContext): Promise<void> {
  await ctx.db.insert(schema.integrationConnections).values({ id: newId(), provider: 'postmark', status: 'not_configured', displayName: 'Postmark' }).onConflictDoNothing();
}

/**
 * `email.provider.check` (daily at 4:37 am Melbourne time and on demand): read-only. Reads Postmark's server,
 * streams and webhooks, plus two advisory DNS hints, and records the outcome on the `postmark` row. Never sends.
 */
export async function handleEmailProviderCheck(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'email.provider.check'>, deps: EmailDeps = defaultEmailDeps(ctx), dns: DnsLookups = realDns): Promise<void> {
  const settings = postmarkSettings(ctx.env);
  if (!settings || !deps.provider) {
    const row = await ctx.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'postmark') });
    if (row) await recordConnectionCheck(ctx.db, 'postmark', { status: 'not_configured', lastError: null });
    await run.progress(1, 'Email sending is not set up on the server');
    return;
  }
  await ensurePostmarkRow(ctx);
  const result = await deps.provider.check(run.signal);
  run.checkCancelled();
  const domain = senderDomain(settings.from);
  const hints = domain ? await dnsHints(domain, dns) : { dmarcFound: null, returnPathFound: null };
  const status = result.state === 'needs_reauth' ? 'needs_reauth' : result.state === 'error' ? 'error' : 'connected';
  await recordConnectionCheck(ctx.db, 'postmark', {
    status,
    displayName: result.serverName || 'Postmark',
    lastError: result.message || null,
    capabilities: {
      deliveryType: result.deliveryType,
      transactionalStream: result.streams.transactional,
      broadcastStream: result.streams.broadcast,
      webhooksConfigured: result.webhooks.configured,
      dmarcFound: hints.dmarcFound,
      returnPathFound: hints.returnPathFound,
      // A successful check lets sending resume after an auth or sender problem.
      ...(status === 'connected' ? { sendingBlocked: false } : {}),
      checkedAt: new Date().toISOString(),
      checkReason: payload.reason,
    },
  });
  await run.progress(1, result.state === 'connected' ? `Postmark is ready (${result.deliveryType === 'sandbox' ? 'test server' : 'live'})` : result.message);
}
