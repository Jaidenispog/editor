import 'server-only';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  AppError,
  BUSINESS_TIMEZONE,
  SQUARE_DASHBOARD_URL,
  classifyVariation,
  effectiveLocationId,
  formatCurrencyAud,
  formatDate,
  formatDateTime,
  newId,
  parseSquareCapabilities,
  parseSquareConfig,
  selfTestAllowed,
  selfTestIsCurrent,
  squareIntegrationState,
  squareNotificationSentence,
  suspensionWords,
  writeGateReason,
  type SquareConnectionConfig,
  type SquareTier1Status,
} from '@studio/core';
import { schema, type Database } from '@studio/db';
import { purgeSquareData } from '@studio/db/square-purge';
import type { SessionUser } from '../auth.js';
import { writeAudit } from '../audit.js';
import { getDb } from '../db.js';
import { getEnv } from '../env.js';
import { formatRelative } from '../format.js';
import { createTrackedJob } from '../jobs.js';
import { missingEnv } from '../integrations/types.js';
import type { BookingChangeDto, SelfTestDto, SquareRevokeDto, SquareServiceDto, SquareStatusDto, Tier1LineDto } from '../shared/square-dto.js';
import { toChangeDto } from './change-dto.js';

/** The stored `square` connection row, or null. */
export async function loadSquareConnection(db: Database = getDb()) {
  return (await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'square')).limit(1))[0] ?? null;
}

/** Plain words for each Tier 1 checklist line (design §4.5). Plan prices are never shown. */
export function tier1Lines(t: SquareTier1Status): Tier1LineDto[] {
  const line = (key: Tier1LineDto['key'], label: string, ok: string, missing: string, unknown: string): Tier1LineDto => {
    const mark = t.checklist[key];
    return { key, label, mark, explanation: mark === 'ok' ? ok : mark === 'missing' ? missing : unknown };
  };
  return [
    line(
      'plan',
      'Square plan allows it',
      'Square says your plan lets apps change bookings.',
      'Your Square Appointments plan doesn’t allow apps to change bookings. Square says Appointments Plus or Premium is required. Check the current price in your Square Dashboard before upgrading.',
      'Not checked yet: Studio Assistant reads this from Square at the next sync.',
    ),
    line('scopes', 'Permission to change bookings', 'Square granted permission to change bookings.', 'Studio Assistant only has permission to read your bookings.', 'Not checked yet.'),
    line('bookableService', 'At least one bookable service', 'At least one service is confirmed free of no-show fees.', 'No service is confirmed as free of no-show fees yet.', 'Not checked yet: no services have been read from Square.'),
    line('selfTest', 'Self-test passed', 'The self-test passed on this Square account.', 'The self-test did not pass on this Square account.', 'The self-test has not been run.'),
    line('switch', 'Switched on', 'Booking changes are switched on.', 'Booking changes are switched off.', 'Booking changes are switched off.'),
  ];
}

/** Services with their per-service label and the barbers who offer them. */
export function serviceDtos(config: SquareConnectionConfig): SquareServiceDto[] {
  const snap = config.snapshot;
  if (!snap) return [];
  const names = new Map(snap.teamMembers.map((t) => [t.id, t.displayName]));
  return snap.services.map((s) => {
    const c = classifyVariation(s, snap.businessProfile, config.serviceConfirmations, config.serviceWriteRejections);
    let priceLabel: string | null = null;
    if (s.price && s.price.currency === 'AUD') {
      const cents = Number(s.price.amount);
      if (Number.isSafeInteger(cents)) priceLabel = formatCurrencyAud(cents);
    }
    return {
      variationId: s.variationId,
      name: s.variationName && s.variationName !== 'Regular' && s.variationName !== s.itemName ? `${s.itemName} · ${s.variationName}` : s.itemName,
      durationMinutes: s.durationMinutes,
      priceLabel,
      label: c.label,
      labelReason: c.reason,
      teamMemberIds: s.teamMemberIds,
      teamMemberNames: s.teamMemberIds.map((id) => names.get(id) ?? 'A team member'),
      confirmed: config.serviceConfirmations[s.variationId]?.version === s.version,
    };
  });
}

/** Message for the card when the owner must reconnect or the last sync failed. */
function stateMessage(r: ReturnType<typeof squareIntegrationState>, lastError: string | null): string | null {
  if (r.state === 'needs_reauth') {
    if (r.reauthReason === 'env_changed') {
      return r.environment === 'production'
        ? 'Studio Assistant is now set to live Square. Reconnect to load your real bookings; the test data will be removed.'
        : 'Studio Assistant is now set to Square’s sandbox (test) environment. Reconnect to load test data; the live data will be removed.';
    }
    if (r.reauthReason === 'scopes') return 'Square didn’t grant all the read permissions Studio Assistant needs. Reconnect and approve them.';
    return lastError ?? 'Square needs you to reconnect.';
  }
  if (r.state === 'error') return lastError ?? 'The last sync with Square failed.';
  return null;
}

const REVOKE_OUTCOMES = ['integration.square.revoked', 'integration.square.revoke_failed', 'integration.square.revoke_skipped'] as const;

/** What the owner is told when Square did not confirm the revoke (design §6). The page's address is not linked. */
export function revokeFailedMessage(environment: 'sandbox' | 'production', reason: string | null): string {
  const account = environment === 'production' ? 'your Square account' : 'your Square sandbox (test) account';
  const why =
    reason === 'environment_changed'
      ? `Studio Assistant has since been switched to the other Square environment, so it could not ask Square to remove its access to ${account}.`
      : reason === 'not_configured'
        ? `Square is not set up on the server any more, so Studio Assistant could not ask Square to remove its access to ${account}.`
        : `Square did not confirm that Studio Assistant's access to ${account} was removed.`;
  return `${why} To be sure, open the App integrations page in ${account}'s Square Dashboard and remove Studio Assistant.`;
}

/** The revoke outcome after the latest disconnect: from its audit entry, or from the job while it is still running. */
export async function squareRevokeOutcome(db: Database, conn: { id: string; status: string; config: unknown } | null): Promise<SquareRevokeDto | null> {
  if (!conn || conn.status !== 'disconnected') return null;
  const a = schema.auditLog;
  const disconnected = (await db.select().from(a).where(and(eq(a.action, 'integration.square.disconnected'), eq(a.entityId, conn.id))).orderBy(desc(a.createdAt)).limit(1))[0];
  if (!disconnected) return null;
  const environment = parseSquareConfig(conn.config).environment;
  const outcome = (await db.select().from(a).where(and(inArray(a.action, [...REVOKE_OUTCOMES]), gte(a.createdAt, disconnected.createdAt))).orderBy(desc(a.createdAt)).limit(1))[0];
  if (outcome?.action === 'integration.square.revoked') return { state: 'revoked', message: 'Square confirmed that Studio Assistant no longer has access to your Square account.' };
  if (outcome?.action === 'integration.square.revoke_failed') {
    const reason = typeof outcome.data['reason'] === 'string' ? (outcome.data['reason'] as string) : null;
    return { state: 'failed', message: revokeFailedMessage(environment, reason) };
  }
  if (outcome) return null;
  const j = schema.jobs;
  const job = (await db.select({ status: j.status }).from(j).where(and(eq(j.type, 'square.revoke'), gte(j.createdAt, disconnected.createdAt))).orderBy(desc(j.createdAt)).limit(1))[0];
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running') return { state: 'pending', message: 'Asking Square to remove Studio Assistant’s access…' };
  if (job.status === 'failed' || job.status === 'cancelled') return { state: 'failed', message: revokeFailedMessage(environment, null) };
  return null;
}

/** Test-only options: `tier1Available` overrides `SQUARE_TIER1_AVAILABLE` (production code never passes it). */
export interface Tier1Options {
  tier1Available?: boolean | undefined;
}

/** The three step rows of a self-test, in order (for its progress line). */
async function selfTestSteps(db: Database, selfTestId: string | null, config: SquareConnectionConfig, now: Date): Promise<BookingChangeDto[]> {
  if (!selfTestId) return [];
  const t = schema.squareBookingChanges;
  const rows = await db.select().from(t).where(eq(t.selfTestId, selfTestId));
  const names = new Map((config.snapshot?.teamMembers ?? []).map((m) => [m.id, m.displayName]));
  return (['create', 'reschedule', 'cancel'] as const).flatMap((k) => {
    const r = rows.find((x) => x.kind === k);
    return r ? [toChangeDto(r, names, now)] : [];
  });
}

/**
 * Why the booking-changes switch cannot be turned on (lines 1–4 must be ticked), or null. A pause is cleared by
 * turning the switch on again once the cause is fixed, so the pause itself is not a reason here.
 */
export function enableReason(t: SquareTier1Status): string | null {
  return writeGateReason({ tier1: { ...t, suspendedReason: '', checklist: { ...t.checklist, switch: 'ok' } }, selfTest: false });
}

/** Everything the Square card and the Appointments header show (never tokens or secrets). */
export async function getSquareStatus(user: SessionUser, db: Database = getDb(), now: Date = new Date(), opts: Tier1Options = {}): Promise<SquareStatusDto> {
  const env = getEnv();
  const conn = await loadSquareConnection(db);
  const missing = missingEnv(env, ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET']);
  const r = squareIntegrationState({
    envPresent: missing.length === 0,
    webhookKeyPresent: Boolean(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
    environment: env.SQUARE_ENVIRONMENT,
    connection: conn
      ? { status: conn.status, externalAccountId: conn.externalAccountId, scopes: conn.scopes, config: conn.config, capabilities: conn.capabilities, lastSyncAt: conn.lastSyncAt, lastError: conn.lastError }
      : null,
    now,
    tier1Available: opts.tier1Available,
  });
  const config = parseSquareConfig(conn?.config);
  const caps = parseSquareCapabilities(conn?.capabilities);
  const hasData = Boolean(conn && conn.status !== 'disconnected' && conn.status !== 'not_configured');
  const locationId = effectiveLocationId(config);
  const location = config.snapshot?.locations.find((l) => l.id === locationId) ?? null;
  const job = hasData
    ? ((await db.select().from(schema.jobs).where(eq(schema.jobs.type, 'square.sync')).orderBy(desc(schema.jobs.createdAt)).limit(1))[0] ?? null)
    : null;
  const owner = user.role === 'owner';
  const summary = !r.tier1.available
    ? 'Not available yet: booking changes are made in Square. Studio Assistant reads your bookings.'
    : r.tier1.ready
      ? 'On: you can book, move and cancel from Studio Assistant. Square re-checks every change before it is made.'
      : r.tier1.suspendedReason
        ? suspensionWords(r.tier1.suspendedReason)
        : 'Off: booking changes are made in Square.';
  const connected = r.state === 'connected';
  const enableWhy = connected ? enableReason(r.tier1) : 'Connect Square first.';
  const selfTestCurrent = selfTestIsCurrent(caps, r.environment, conn?.externalAccountId ?? null);
  const runWhy = !connected ? 'Connect Square first.' : caps.selfTestStatus === 'running' ? 'A self-test is running.' : selfTestAllowed(r.tier1) ? null : (writeGateReason({ tier1: r.tier1, selfTest: true }) ?? 'Not available.');
  const selfTest: SelfTestDto = {
    status: caps.selfTestStatus,
    current: selfTestCurrent,
    atLabel: caps.selfTestAt ? formatDateTime(caps.selfTestAt) : null,
    failure: caps.selfTestStatus === 'failed' ? caps.selfTestFailure : null,
    canRun: owner && runWhy === null,
    runReason: owner ? runWhy : 'Only the owner can run the self-test.',
    notifies: caps.squareNotifiesApiBookings,
    askNotification: owner && selfTestCurrent && caps.selfTestEnvironment === 'production' && caps.selfTestStatus !== 'running' && caps.selfTestStatus !== 'none' && caps.squareNotifiesApiBookings === 'unknown',
    steps: hasData ? await selfTestSteps(db, caps.selfTestId, config, now) : [],
  };
  return {
    state: r.state,
    liveMode: r.liveMode,
    environment: r.environment,
    dataEnvironment: hasData ? config.environment : null,
    missingEnv: missing,
    message: stateMessage(r, conn?.lastError ?? null),
    merchantName: conn?.displayName || config.snapshot?.merchantName || null,
    needsLocation: r.needsLocation,
    locations: (config.snapshot?.locations ?? []).filter((l) => l.status === 'ACTIVE').map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })),
    locationId,
    timezoneWarning: caps.locationTimezone && caps.locationTimezone !== BUSINESS_TIMEZONE ? `Your Square location is set to ${caps.locationTimezone}. Studio Assistant shows Melbourne time.` : null,
    lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
    lastSyncLabel: conn?.lastSyncAt ? formatRelative(conn.lastSyncAt) : null,
    stale: r.stale,
    webhooks: r.webhooks,
    lastWebhookLabel: config.lastWebhookAt ? formatRelative(config.lastWebhookAt) : null,
    bookingSiteUrl: location?.bookingSiteUrl ?? null,
    dashboardUrl: SQUARE_DASHBOARD_URL[config.environment],
    tier1: {
      available: r.tier1.available,
      ready: r.tier1.ready,
      summary,
      lines: tier1Lines(r.tier1),
      canEnable: owner && r.tier1.available && enableWhy === null,
      enableReason: enableWhy,
      switchOn: caps.writesEnabled,
      canGivePermission: owner && connected && r.tier1.available && r.tier1.checklist.scopes !== 'ok',
      notificationSentence: squareNotificationSentence(caps.squareNotifiesApiBookings),
    },
    selfTest,
    services: serviceDtos(config),
    teamMembers: config.snapshot?.teamMembers ?? [],
    sync: job ? { jobId: job.id, status: job.status, progress: job.progress, message: job.message } : null,
    canManage: owner,
    details: owner && conn ? { merchantId: conn.externalAccountId, scopes: conn.scopes, tokenExpiresLabel: conn.tokenExpiresAt ? formatDate(conn.tokenExpiresAt) : null } : null,
    revoke: owner ? await squareRevokeOutcome(db, conn) : null,
  };
}

/** Queues a read-only `square.sync`. */
export async function queueSquareSync(reason: 'connect' | 'manual'): Promise<string> {
  const job = await createTrackedJob({ type: 'square.sync', payload: { reason }, projectId: null, refId: null, singletonKey: 'square-sync' });
  return job.id;
}

/** Requires a usable connection for actions that read from Square. */
export async function requireSquareConnected(db: Database = getDb()) {
  const conn = await loadSquareConnection(db);
  const env = getEnv();
  if (!env.SQUARE_APPLICATION_ID || !env.SQUARE_APPLICATION_SECRET) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Square is not set up on the server yet.', { status: 409 });
  if (!conn || (conn.status !== 'connected' && conn.status !== 'error')) throw new AppError('CONFLICT', 'Square is not connected. Connect it in Settings → Integrations.');
  if (parseSquareConfig(conn.config).environment !== env.SQUARE_ENVIRONMENT) throw new AppError('CONFLICT', 'Square was connected in the other environment. Reconnect Square in Settings → Integrations.');
  return conn;
}

/** Owner changes on the card: the location, a service confirmation, or the booking-changes switch. */
export async function updateSquareSettings(
  user: SessionUser,
  body: { locationId?: string | undefined; writesEnabled?: boolean | undefined; serviceConfirmation?: { variationId: string; confirmed: boolean } | undefined },
  db: Database = getDb(),
  opts: Tier1Options = {},
): Promise<void> {
  const conn = await requireSquareConnected(db);
  const t = schema.integrationConnections;
  const config = parseSquareConfig(conn.config);
  if (body.locationId !== undefined) {
    const loc = config.snapshot?.locations.find((l) => l.id === body.locationId && l.status === 'ACTIVE');
    if (!loc) throw new AppError('VALIDATION', 'That location is not in your Square account.');
    // Bookings of every other location are removed in the same transaction, under the connection row's lock (the lock
    // the worker's writes take FOR SHARE), so a sync still running for the old choice cannot copy them back.
    const removed = await db.transaction(async (tx) => {
      await tx.select({ id: t.id }).from(t).where(eq(t.id, conn.id)).for('update');
      await tx.update(t).set({ config: sql`${t.config} || ${JSON.stringify({ locationId: loc.id })}::jsonb`, updatedAt: new Date() }).where(eq(t.id, conn.id));
      const b = schema.bookings;
      return tx.delete(b).where(and(eq(b.squareEnvironment, config.environment), ne(b.locationId, loc.id))).returning({ id: b.id });
    });
    await writeAudit({ userId: user.id, action: 'integration.square.location_selected', entityType: 'integration_connection', entityId: conn.id, data: { locationId: loc.id, otherLocationBookingsRemoved: removed.length } });
    await queueSquareSync('manual');
  }
  if (body.serviceConfirmation) {
    const { variationId, confirmed } = body.serviceConfirmation;
    const service = config.snapshot?.services.find((s) => s.variationId === variationId);
    if (!service) throw new AppError('VALIDATION', 'That service is not in your Square catalogue.');
    const entry = { version: service.version, confirmedBy: user.id, confirmedAt: new Date().toISOString() };
    const next = confirmed
      ? sql`jsonb_set(${t.config}, '{serviceConfirmations}', coalesce(${t.config}->'serviceConfirmations', '{}'::jsonb) || ${JSON.stringify({ [variationId]: entry })}::jsonb)`
      : sql`jsonb_set(${t.config}, '{serviceConfirmations}', coalesce(${t.config}->'serviceConfirmations', '{}'::jsonb) - ${variationId}::text)`;
    await db.update(t).set({ config: next, updatedAt: new Date() }).where(eq(t.id, conn.id));
    await writeAudit({ userId: user.id, action: confirmed ? 'integration.square.service_confirmed' : 'integration.square.service_unconfirmed', entityType: 'integration_connection', entityId: conn.id, data: { variationId, version: service.version } });
  }
  if (body.writesEnabled !== undefined) {
    if (body.writesEnabled) {
      // Re-read under the row lock: lines 1–4 must be ticked now. Turning it on again also clears a pause whose
      // cause is fixed (the plan flag and permissions are re-checked here, and by the worker before every change).
      const refused = await db.transaction(async (tx) => {
        const locked = (await tx.select().from(t).where(eq(t.id, conn.id)).limit(1).for('update'))[0];
        if (!locked) return 'Square is not connected.';
        const r = squareIntegrationState({
          envPresent: true,
          webhookKeyPresent: false,
          environment: getEnv().SQUARE_ENVIRONMENT,
          connection: { status: locked.status, externalAccountId: locked.externalAccountId, scopes: locked.scopes, config: locked.config, capabilities: locked.capabilities, lastSyncAt: locked.lastSyncAt, lastError: locked.lastError },
          now: new Date(),
          tier1Available: opts.tier1Available,
        });
        const why = r.tier1.available ? enableReason(r.tier1) : 'Booking changes from Studio Assistant aren’t available yet. Make changes in Square.';
        if (why) return why;
        await tx.update(t).set({ capabilities: sql`${t.capabilities} || '{"writesEnabled": true, "writesSuspendedReason": ""}'::jsonb`, updatedAt: new Date() }).where(eq(t.id, conn.id));
        return null;
      });
      if (refused) throw new AppError('CONFLICT', refused);
      await writeAudit({ userId: user.id, action: 'integration.square.writes_enabled', entityType: 'integration_connection', entityId: conn.id });
      return;
    }
    await db.update(t).set({ capabilities: sql`${t.capabilities} || '{"writesEnabled": false}'::jsonb`, updatedAt: new Date() }).where(eq(t.id, conn.id));
    await writeAudit({ userId: user.id, action: 'integration.square.writes_disabled', entityType: 'integration_connection', entityId: conn.id });
  }
}

/**
 * Disconnect (design §4.1): the tokens are wiped and the row kept as `disconnected`; optionally every copied
 * booking and client (and every stored Square webhook delivery) is removed in the same transaction (customers are
 * scrubbed, never deleted), under the connection row's lock so a running sync cannot write them back. Square is then
 * asked to revoke the app's access by `square.revoke`, which needs only the application secret.
 */
export async function disconnectSquare(user: SessionUser, purgeData: boolean, db: Database = getDb()): Promise<{ status: 'disconnected'; revokeJobId: string | null; purged: boolean }> {
  const t = schema.integrationConnections;
  const conn = await loadSquareConnection(db);
  if (!conn || conn.status === 'disconnected') throw new AppError('CONFLICT', 'Square is not connected.');
  const environment = parseSquareConfig(conn.config).environment;
  await db.transaction(async (tx) => {
    // The same row lock the worker's mirror writes take FOR SHARE (withMirrorGuard): a sync still running waits for
    // the purge and then sees "disconnected", so it can never write the purged bookings and clients back.
    await tx.select({ id: t.id }).from(t).where(eq(t.id, conn.id)).for('update');
    await tx
      .update(t)
      .set({
        status: 'disconnected',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        scopes: [],
        capabilities: sql`${t.capabilities} || '{"writesEnabled": false}'::jsonb`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(t.id, conn.id));
    await tx.insert(schema.auditLog).values({ id: newId(), userId: user.id, action: 'integration.square.disconnected', entityType: 'integration_connection', entityId: conn.id, data: { environment, purgeData } });
    // Changes still waiting are withdrawn (the worker also refuses any change once the connection is gone).
    const sc = schema.squareBookingChanges;
    await tx.update(sc).set({ status: 'cancelled', statusMessage: 'Square was disconnected.', finishedAt: new Date(), updatedAt: new Date() }).where(eq(sc.status, 'queued'));
    if (purgeData) await purgeSquareData(tx as unknown as Database, { environment, userId: user.id, reason: 'disconnected' });
  });
  let revokeJobId: string | null = null;
  if (conn.externalAccountId) {
    const job = await createTrackedJob({ type: 'square.revoke', payload: { merchantId: conn.externalAccountId, environment }, projectId: null, refId: null, singletonKey: `square-revoke:${conn.externalAccountId}` });
    revokeJobId = job.id;
  }
  return { status: 'disconnected', revokeJobId, purged: purgeData };
}

/** Formats an instant in Melbourne time for labels ("14 Nov 2026, 9:42 am"). */
export function melbourneLabel(at: Date | string): string {
  return formatDateTime(at);
}
