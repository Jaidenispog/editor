import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_RESUMABLE_MAX_BYTES, newId, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { recordConnectionCheck, type ConnectionRow } from '../lib/connections.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { GraphApiError, MetaGraphClient } from '../lib/meta/graph.js';
import { DISCOVERY_HINT, mapGraphError } from '../publishing/errors.js';

/** The permissions a Unified Login system-user configuration must grant (memo §4). */
export const REQUIRED_META_SCOPES = ['instagram_basic', 'instagram_content_publish'] as const;

export const WRONG_TOKEN_MESSAGE = 'Your Meta configuration must use a System-user access token with instagram_basic and instagram_content_publish.';
export const DISCOVERY_EMPTY_MESSAGE =
  "Instagram didn't tell us which account to use. Enter your Instagram account ID (Meta Business Settings → Accounts → Instagram accounts).";

/** Writes one discovered Instagram account (platform, provider `meta_graph`, linked to the connection). */
async function upsertInstagramAccount(ctx: WorkerContext, conn: ConnectionRow, account: { id: string; username: string }, capabilities: Record<string, boolean | string | number | null>): Promise<string> {
  const now = new Date();
  const existing = await ctx.db.query.socialAccounts.findFirst({ where: and(eq(schema.socialAccounts.platform, 'instagram'), eq(schema.socialAccounts.externalId, account.id)) });
  if (existing) {
    await ctx.db
      .update(schema.socialAccounts)
      .set({
        username: account.username || existing.username,
        provider: 'meta_graph',
        connectionId: conn.id,
        status: 'connected',
        lastCheckedAt: now,
        lastError: null,
        capabilities: sql`${schema.socialAccounts.capabilities} || ${JSON.stringify(capabilities)}::jsonb`,
        updatedAt: now,
      })
      .where(eq(schema.socialAccounts.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await ctx.db.insert(schema.socialAccounts).values({
    id,
    platform: 'instagram',
    externalId: account.id,
    username: account.username,
    provider: 'meta_graph',
    connectionId: conn.id,
    status: 'connected',
    lastCheckedAt: now,
    capabilities: { resumableMaxBytes: DEFAULT_RESUMABLE_MAX_BYTES, ...capabilities },
  });
  return id;
}

/** Marks every Instagram account of the connection with a status and message (token or permission problems). */
async function markAccounts(ctx: WorkerContext, connId: string, status: 'needs_reauth' | 'error', message: string): Promise<void> {
  await ctx.db
    .update(schema.socialAccounts)
    .set({ status, lastError: message.slice(0, 500), lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.socialAccounts.connectionId, connId), inArray(schema.socialAccounts.status, ['connected', 'needs_reauth', 'error'])));
}

/**
 * Meta's read-only check (design §7.1.2): `debug_token` (valid, SYSTEM_USER, both scopes, expiry), account discovery
 * (assigned accounts → granular-scope target ids → the ID the owner entered), and the publishing quota. Records the
 * outcome on the connection and the accounts. Never posts and never changes anything at Meta.
 */
async function checkMeta(ctx: WorkerContext, run: TrackedRun, conn: ConnectionRow): Promise<string> {
  const token = decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted);
  if (!token || conn.status === 'disconnected') return 'No Instagram connection to check';
  if (!ctx.env.META_APP_ID || !ctx.env.META_APP_SECRET) {
    await recordConnectionCheck(ctx.db, 'meta', { status: 'error', lastError: 'The Meta app settings (META_APP_ID and META_APP_SECRET) are missing on the server.' });
    return 'Meta app settings missing';
  }
  const client = new MetaGraphClient(ctx, ctx.env, token, run.signal);
  try {
    const facts = await client.debugToken();
    if (!facts.isValid) {
      await recordConnectionCheck(ctx.db, 'meta', { status: 'needs_reauth', lastError: 'Meta says the connection is no longer valid. Connect Instagram again.' });
      await markAccounts(ctx, conn.id, 'needs_reauth', 'Meta says the connection is no longer valid.');
      return 'Token invalid';
    }
    const missing = REQUIRED_META_SCOPES.filter((s) => !facts.scopes.includes(s));
    const expiresAt = facts.expiresAt && facts.expiresAt > 0 ? new Date(facts.expiresAt * 1000) : null;
    const tokenSummary = { tokenType: facts.type, scopes: facts.scopes, expiresAt: expiresAt?.toISOString() ?? null, checkedAt: new Date().toISOString() };
    await ctx.db
      .update(schema.integrationConnections)
      .set({ tokenExpiresAt: expiresAt, scopes: facts.scopes, config: sql`${schema.integrationConnections.config} || ${JSON.stringify({ debugToken: tokenSummary, graphVersion: client.version })}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.integrationConnections.id, conn.id));
    if (facts.type !== 'SYSTEM_USER' || missing.length) {
      await recordConnectionCheck(ctx.db, 'meta', { status: 'error', lastError: WRONG_TOKEN_MESSAGE });
      await markAccounts(ctx, conn.id, 'error', WRONG_TOKEN_MESSAGE);
      return 'Wrong token type or permissions';
    }

    // Discovery, in the memo's order.
    const pending = typeof conn.config['pendingIgUserId'] === 'string' ? conn.config['pendingIgUserId'] : null;
    let accounts: Array<{ id: string; username: string }> = [];
    if (pending) {
      accounts = [await client.instagramUser(pending)];
    } else {
      accounts = await client.assignedInstagramAccounts();
      if (accounts.length === 0) {
        for (const id of facts.contentPublishTargets.slice(0, 5)) accounts.push(await client.instagramUser(id));
      }
    }
    run.checkCancelled();
    if (accounts.length === 0) {
      await recordConnectionCheck(ctx.db, 'meta', { status: 'error', lastError: DISCOVERY_EMPTY_MESSAGE, capabilities: { discoveryEmpty: true } });
      return 'No Instagram account found';
    }
    const base = { contentPublish: true, graphVersion: client.version, tokenExpiresAt: expiresAt?.toISOString() ?? null };
    const names: string[] = [];
    for (const a of accounts) {
      const accountId = await upsertInstagramAccount(ctx, conn, a, base);
      const quota = await client.publishingLimit(a.id);
      await ctx.db
        .update(schema.socialAccounts)
        .set({
          capabilities: sql`${schema.socialAccounts.capabilities} || ${JSON.stringify({ quotaUsage: quota.usage, quotaTotal: quota.total, quotaCheckedAt: new Date().toISOString() })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.socialAccounts.id, accountId));
      names.push(`@${a.username || a.id}`);
    }
    await ctx.db
      .update(schema.integrationConnections)
      .set({ config: sql`(${schema.integrationConnections.config} - 'pendingIgUserId')`, updatedAt: new Date() })
      .where(eq(schema.integrationConnections.id, conn.id));
    await recordConnectionCheck(ctx.db, 'meta', { status: 'connected', lastError: null, displayName: names.join(', '), capabilities: { discoveryEmpty: false, accountsFound: accounts.length, graphVersion: client.version } });
    return `Checked ${names.join(', ')}`;
  } catch (err) {
    if (!(err instanceof GraphApiError)) throw err;
    const mapped = mapGraphError(err);
    if (mapped.kind === 'transient') throw err;
    if (mapped.kind === 'reauth') {
      await recordConnectionCheck(ctx.db, 'meta', { status: 'needs_reauth', lastError: 'Instagram needs reconnecting: the access token is no longer valid.' });
      await markAccounts(ctx, conn.id, 'needs_reauth', mapped.message);
      return 'Token expired';
    }
    const message = mapped.kind === 'discovery' ? DISCOVERY_HINT : pending(conn) ? `That Instagram account ID could not be read. ${mapped.message}` : mapped.message;
    await recordConnectionCheck(ctx.db, 'meta', { status: 'error', lastError: message });
    return 'Check failed';
  }
}

function pending(conn: ConnectionRow): boolean {
  return typeof conn.config['pendingIgUserId'] === 'string';
}

/**
 * `social.check`: read-only check of the publishing connections (Meta today; WP10 adds Zernio). Runs after connect,
 * on "Check connection", daily at 4:23 am Melbourne time and before a verification post. Never posts.
 */
export async function handleSocialCheck(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'social.check'>): Promise<void> {
  const rows = payload.connectionId
    ? await ctx.db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, payload.connectionId))
    : await ctx.db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'meta'));
  const results: string[] = [];
  for (const conn of rows) {
    if (conn.provider !== 'meta') continue;
    results.push(await checkMeta(ctx, run, conn));
  }
  if (payload.reason !== 'daily') {
    await writeWorkerAudit(ctx.db, { userId: null, action: 'integration.meta.checked', entityType: 'integration_connection', entityId: rows[0]?.id ?? null, data: { reason: payload.reason, result: results.join('; ') } }, ctx.logger);
  }
  await run.message(results.length ? results.join('; ') : 'No publishing connection to check');
}
