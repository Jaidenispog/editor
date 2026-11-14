import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@studio/db';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { buildBusinessProfileIntegrations } from './integrations/business_profile.js';
import { buildEmailIntegrations } from './integrations/email.js';
import { buildMusicIntegrations } from './integrations/music.js';
import { buildPreferencesIntegrations } from './integrations/preferences.js';
import { buildPublishingIntegrations } from './integrations/publishing.js';
import { buildSquareIntegrations } from './integrations/square.js';
import { buildStudioIntegrations } from './integrations/studio.js';
import { buildTrendsIntegrations } from './integrations/trends.js';
import type { ConnectionFacts, IntegrationBuilder, IntegrationEnv } from './integrations/types.js';
import { buildWebsiteIntegrations } from './integrations/website.js';
import type { IntegrationStatus } from './shared/integration-types.js';

export type { IntegrationStatus, IntegrationArea } from './shared/integration-types.js';
export type { ConnectionFacts, IntegrationEnv } from './integrations/types.js';

/** One builder per module, in display order. Modules edit only their own `./integrations/<module>.ts`. */
const BUILDERS: readonly IntegrationBuilder[] = [
  buildStudioIntegrations,
  buildMusicIntegrations,
  buildPreferencesIntegrations,
  buildTrendsIntegrations,
  buildPublishingIntegrations,
  buildSquareIntegrations,
  buildEmailIntegrations,
  buildBusinessProfileIntegrations,
  buildWebsiteIntegrations,
];

/**
 * Builds the status list from environment presence and stored connections. Pure, so it is unit tested; messages
 * tell the owner exactly what is needed and never imply that anything is connected when it is not. Manual paths
 * (posting by hand, the review link) never depend on these cards.
 */
export function buildIntegrationStatuses(env: IntegrationEnv, facts: ConnectionFacts, builders: readonly IntegrationBuilder[] = BUILDERS): IntegrationStatus[] {
  const out = builders.flatMap((build) => build(env, facts));
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.id)) throw new Error(`Two integration cards use the id ${s.id}`);
    seen.add(s.id);
  }
  return out;
}

/** Live integration statuses for this server (used by /api/integrations/status and the section pages). */
export async function getIntegrationStatuses(): Promise<IntegrationStatus[]> {
  const env = getEnv();
  const db = getDb();
  const c = schema.integrationConnections;
  const w = schema.trendWatches;
  const j = schema.jobs;
  const [connections, socialAccounts, trendWatches, profileCheck] = await Promise.all([
    db
      .select({ provider: c.provider, status: c.status, displayName: c.displayName, capabilities: c.capabilities, config: c.config, lastError: c.lastError, lastSyncAt: c.lastSyncAt })
      .from(c),
    db
      .select({ platform: schema.socialAccounts.platform, status: schema.socialAccounts.status, username: schema.socialAccounts.username, capabilities: schema.socialAccounts.capabilities })
      .from(schema.socialAccounts),
    db.select({ provider: w.provider, enabled: w.enabled, status: w.status, statusMessage: w.statusMessage, lastSuccessAt: w.lastSuccessAt }).from(w),
    // The Business Profile card may say "Checking" only while its read-only check is really queued or running.
    db.query.jobs.findFirst({ columns: { id: true }, where: and(eq(j.type, 'reviews.gbp.sync'), inArray(j.status, ['queued', 'running'])) }),
  ]);
  const checksInFlight = profileCheck ? ['google_business_profile'] : [];
  return buildIntegrationStatuses(env, { connections, socialAccounts, trendWatches, checksInFlight });
}
