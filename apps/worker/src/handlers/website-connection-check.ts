import { eq, sql } from 'drizzle-orm';
import { AppError, NonRetryableError, siteScopeFrom, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { loadConnection, recordConnectionCheck } from '../lib/connections.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import { getGoogleAccessToken } from '../lib/google/oauth.js';
import { SearchConsoleError, autoSelectProperty, canRead, listSites } from '../lib/google/search-console.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { checkProfilePerformance } from '../modules/business_profile/performance.js';
import { loadSettings } from '../lib/plan-context.js';
import { TransientAdapterError } from '../website/adapters/types.js';
import { WordPressAdapter } from '../website/adapters/wordpress.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';
import { resolveSafeAddress, systemResolver } from '../website/ssrf.js';
import { splitWordPressCredential, wordPressContext } from './website-edit-apply.js';

/**
 * `website.connection_check` (design §8): read-only. Search Console: refresh the token and list properties
 * (`sites.list`), auto-select the one for the website when exactly one readable property matches, then queue the
 * first sync. WordPress: REST discovery and the user's rights. Business Profile Performance: a 7-day read that tells
 * whether Google has approved API access. Never writes to any external system.
 */
export async function handleWebsiteConnectionCheck(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: JobPayload<'website.connection_check'>,
  deps: WebsiteDeps = defaultWebsiteDeps(ctx),
): Promise<void> {
  if (payload.provider === 'google_search_console') return checkSearchConsole(ctx, run, payload.reason);
  // Business Profile Performance probe (WP9, design §7.3): read-only, on the shared Business Profile connection.
  if (payload.provider === 'business_profile_performance') {
    await checkProfilePerformance(ctx, run, payload.reason, deps.now);
    return;
  }
  return checkWordPress(ctx, run, deps);
}

async function checkSearchConsole(ctx: WorkerContext, run: TrackedRun, reason: 'connect' | 'manual' | 'daily'): Promise<void> {
  const conn = await loadConnection(ctx.db, 'google_search_console');
  if (!conn || conn.status === 'disconnected' || !conn.refreshTokenEncrypted) {
    await run.message('Search Console is not connected');
    return;
  }
  await run.progress(0.2, 'Checking your Search Console access…');
  let token: string;
  try {
    token = await getGoogleAccessToken(ctx, 'google_search_console', run.signal);
  } catch (err) {
    if (err instanceof AppError && err.code === 'INTEGRATION_NOT_CONFIGURED') throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
    throw err;
  }
  let sites;
  try {
    sites = await listSites(ctx, token, run.signal);
  } catch (err) {
    if (err instanceof SearchConsoleError && err.kind !== 'transient') {
      await recordConnectionCheck(ctx.db, 'google_search_console', {
        status: err.kind === 'reauth' ? 'needs_reauth' : 'error',
        lastError: err.message,
        capabilities: { searchConsoleProblem: err.kind },
      });
      throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', err.message);
    }
    throw err;
  }
  const settings = await loadSettings(ctx);
  const scope = siteScopeFrom(settings.business.website);
  const current = typeof conn.config['siteUrl'] === 'string' ? conn.config['siteUrl'] : null;
  const keep = current && sites.some((s) => s.siteUrl === current) ? current : null;
  const chosen = keep ?? autoSelectProperty(sites, scope);
  const host = scope ? scope.host.replace(/^www\./, '') : null;
  const lastError = chosen
    ? null
    : !host
      ? 'Add your website address in Settings → Business so we can find its Search Console property.'
      : sites.some((s) => canRead(s.permissionLevel) && s.siteUrl.toLowerCase().includes(host))
        ? `Google lists more than one property for ${host}. Choose the one for the studio.`
        : `Your Google account has no Search Console property for ${host}. Verify the website in Search Console (a DNS record can take up to 48 hours), then press Check again.`;
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({
      config: sql`${t.config} || ${JSON.stringify({ properties: sites, siteUrl: chosen })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(t.provider, 'google_search_console'));
  await recordConnectionCheck(ctx.db, 'google_search_console', {
    status: 'connected',
    lastError,
    capabilities: {
      searchConsoleProblem: null,
      propertyCount: sites.length,
      propertyChosen: Boolean(chosen),
    },
  });
  if (chosen && (reason === 'connect' || !current)) {
    await enqueueTracked(ctx, 'search.sync', { source: 'search_console', reason: 'connect' }, { singletonKey: 'search-sync:search_console' });
  }
  await run.progress(1, chosen ? `Search Console property: ${chosen}` : 'Choose your Search Console property');
}

async function checkWordPress(ctx: WorkerContext, run: TrackedRun, deps: WebsiteDeps): Promise<void> {
  const conn = await loadConnection(ctx.db, 'website');
  const plain = conn && conn.status !== 'disconnected' ? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted) : null;
  const cred = plain ? splitWordPressCredential(plain) : null;
  const baseUrl = typeof conn?.config['baseUrl'] === 'string' ? conn.config['baseUrl'] : null;
  if (!conn || !cred || !baseUrl) {
    await run.message('WordPress is not connected');
    return;
  }
  await run.progress(0.2, 'Checking WordPress (read-only)…');
  try {
    // The owner typed this address: refuse private and reserved addresses, like the crawler does.
    await resolveSafeAddress(new URL(baseUrl).hostname, deps.fetchPolicy, deps.fetchPolicy.resolver ?? systemResolver);
  } catch (err) {
    await recordConnectionCheck(ctx.db, 'website', {
      status: 'error',
      lastError: err instanceof Error ? err.message : 'The WordPress address could not be checked.',
    });
    throw new NonRetryableError('VALIDATION', 'The WordPress address points to a private or unknown address.');
  }
  const settings = await loadSettings(ctx);
  const adapter = new WordPressAdapter(wordPressContext(ctx, deps), {
    baseUrl,
    ...cred,
    publicWebsite: settings.business.website,
  });
  let check;
  try {
    check = await adapter.check(run.signal);
  } catch (err) {
    if (err instanceof TransientAdapterError && !run.willRetry) {
      await recordConnectionCheck(ctx.db, 'website', {
        status: 'error',
        lastError: "Your website didn't respond to the check. Try again later.",
      });
      throw new NonRetryableError('PROCESSING_FAILED', err.message);
    }
    throw err;
  }
  const capabilities = {
    environment: check.environment,
    supportedKinds: check.supportedKinds.join(','),
    roles: check.roles.join(','),
    editPages: check.capabilities['edit_pages'] ?? false,
    editPublishedPages: check.capabilities['edit_published_pages'] ?? false,
    editOthersPages: check.capabilities['edit_others_pages'] ?? false,
    note: check.note,
  };
  const t = schema.integrationConnections;
  await ctx.db
    .update(t)
    .set({
      config: sql`${t.config} || ${JSON.stringify({ environment: check.environment })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(t.provider, 'website'));
  await recordConnectionCheck(ctx.db, 'website', {
    status: check.ok ? 'connected' : check.needsReauth ? 'needs_reauth' : 'error',
    lastError: check.problem,
    capabilities,
    ...(check.identity ? { displayName: check.identity.slice(0, 120) } : {}),
  });
  await run.progress(1, check.ok ? `Connected as ${check.identity ?? 'your WordPress user'}` : (check.problem ?? 'WordPress check failed'));
}
