import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  AppError,
  AuditSummarySchema,
  OPEN_EDIT_STATUSES,
  OPENING_DAY_NAMES,
  QUERY_GROUPS,
  WebsiteAuditResultSchema,
  WebsiteChangeSchema,
  WebsiteSettingsSchema,
  buildQueryClassifier,
  changeTitle,
  checkCopyClaims,
  classifyQuery,
  clearWriteMarker,
  editDedupeKey,
  fixedSince,
  inSiteScope,
  isInScope,
  newId,
  normaliseAuPhone,
  notListedRemainder,
  ownershipHost,
  ownershipMatches,
  realBusinessName,
  renderEditInstructions,
  sameUrl,
  siteScopeFrom,
  type AppSettings,
  type ApplyResult,
  type QueryClassifier,
  type QueryGroup,
  type Verification,
  type WebsiteAuditResult,
  type WebsiteChange,
  type WebsiteEditSource,
  type WebsiteEditStatus,
} from '@studio/core';
import { resolvedPrivateHostReason } from '@studio/core/address-ranges';
import { approvalDestination, approvalHash } from '@studio/core/website-approval';
import { schema } from '@studio/db';
import type { AuditSummaryDto, GroupTotals, QueryRowDto, SearchPanelState, SearchPerformanceDto, WebsiteEditDto, WebsiteOverviewDto } from '@/components/website/types';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { encryptToken } from './crypto.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { getIntegrationStatuses } from './integrations.js';
import { chosenProperty } from './integrations/website.js';
import { createTrackedJob, toJobDto } from './jobs.js';
import { getLogger } from './logger.js';
import { getSettings, updateSettingsLocked } from './settings.js';

/**
 * Website page data and actions (design §9). Every function here is for the owner only (routes call `requireOwner`).
 * Long work (checks, applies, wording, syncs) is always a worker job; nothing here calls the owner's site, WordPress or
 * Google. DTOs never contain tokens, passwords, page HTML or apply internals beyond outcome, message and verification.
 */

/** Minimum gap between finished checks. */
export const AUDIT_COOLDOWN_MS = 5 * 60_000;
/** Minimum gap between manual Search Console refreshes. */
export const SEARCH_SYNC_COOLDOWN_MS = 15 * 60_000;

type EditRow = typeof schema.websiteEdits.$inferSelect;
type AuditRow = typeof schema.websiteAudits.$inferSelect;
type ConnRow = typeof schema.integrationConnections.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------------------------

/** Business details that are missing, with what each one enables (design §4.1 step 3). */
export function missingBusinessDetails(settings: Pick<AppSettings, 'brand' | 'business'>): WebsiteOverviewDto['setup']['missingDetails'] {
  const b = settings.business;
  const out: WebsiteOverviewDto['setup']['missingDetails'] = [];
  if (!realBusinessName(settings.brand.businessName))
    out.push({
      field: 'businessName',
      label: 'Business name (Branding)',
      enables: 'Add your business name so we can check your website and Google listing use the same one.',
    });
  if (!b.addressLine.trim())
    out.push({
      field: 'addressLine',
      label: 'Street address',
      enables: 'Add your street address so we can check your website shows it.',
    });
  if (!b.suburb.trim() || !b.postcode.trim())
    out.push({
      field: 'suburb',
      label: 'Suburb and postcode',
      enables: 'Add your suburb and postcode so we can check local details.',
    });
  if (!normaliseAuPhone(b.phone))
    out.push({
      field: 'phone',
      label: 'Phone number',
      enables: 'Add your phone number so we can check your website shows the same one.',
    });
  if (!b.bookingLink.trim())
    out.push({
      field: 'bookingLink',
      label: 'Booking link',
      enables: 'Add your booking link so we can check visitors can find it.',
    });
  if (b.openingHours.length === 0)
    out.push({
      field: 'openingHours',
      label: 'Opening hours',
      enables: 'Add your opening hours so the business details code can include them.',
    });
  return out;
}

/** Opening hours as plain lines ("Tuesday: 09:00–17:30"); days without hours say "Closed". */
export function openingHoursLines(hours: AppSettings['business']['openingHours']): string[] {
  return (Object.keys(OPENING_DAY_NAMES) as Array<keyof typeof OPENING_DAY_NAMES>).map((d) => {
    const ranges = hours.filter((r) => r.day === d).sort((a, b) => a.opens.localeCompare(b.opens));
    return `${OPENING_DAY_NAMES[d]}: ${ranges.length ? ranges.map((r) => `${r.opens}–${r.closes}`).join(', ') : 'Closed'}`;
  });
}

/** Whether a change can be applied through the website connection, with the reason when it can't (design §4.3). */
export function applyAvailability(
  change: WebsiteChange,
  status: WebsiteEditStatus,
  conn: Pick<ConnRow, 'status' | 'capabilities'> | null | undefined,
): { ok: boolean; reason: string | null } {
  if (status !== 'proposed' && status !== 'apply_failed') return { ok: false, reason: null };
  if (!conn || conn.status === 'disconnected')
    return {
      ok: false,
      reason: 'Connect WordPress in Settings → Integrations to apply changes from here.',
    };
  if (conn.status !== 'connected')
    return {
      ok: false,
      reason: 'Your website editing connection needs attention. Check it in Settings → Integrations.',
    };
  const supported = typeof conn.capabilities['supportedKinds'] === 'string' ? conn.capabilities['supportedKinds'].split(',') : [];
  if (!supported.includes(change.kind)) {
    const what: Record<WebsiteChange['kind'], string> = {
      page_title: 'page titles',
      meta_description: 'search descriptions',
      structured_data: 'business details code',
      head_snippet: 'header code',
      robots_txt: 'robots.txt',
      text_replace: 'page text',
      image_alt_text: 'image descriptions',
    };
    return {
      ok: false,
      reason: `WordPress can't change ${what[change.kind]} through its standard connection; use the steps instead.`,
    };
  }
  return { ok: true, reason: null };
}

/** Days covered by a range ending on the last day with data. */
export function rangeDays(range: SearchPerformanceDto['range']): number {
  return range === '28d' ? 28 : range === '3m' ? 91 : 487;
}

/** One stored Search Console row as read for grouping. */
export interface StoredSearchRow {
  periodStart: string;
  kind: string;
  key: string;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
}

const emptyTotals = (): GroupTotals => ({
  clicks: 0,
  impressions: 0,
  position: null,
});

/**
 * Groups stored rows at read time (design §6.5, §9.2): totals per group with impression-weighted average position,
 * the "not listed" remainder (total minus listed, per day, clamped at 0, never redistributed), a daily series and the
 * top 20 searches per group. Only numbers Google returned are used.
 */
export function groupSearchRows(rows: StoredSearchRow[], classifier: QueryClassifier): Pick<SearchPerformanceDto, 'groups' | 'notListed' | 'daily' | 'topQueries' | 'dataThrough'> {
  if (rows.length === 0)
    return {
      groups: null,
      notListed: null,
      daily: [],
      topQueries: null,
      dataThrough: null,
    };
  const groups = Object.fromEntries(QUERY_GROUPS.map((g) => [g, emptyTotals()])) as Record<QueryGroup, GroupTotals>;
  const weighted = Object.fromEntries(QUERY_GROUPS.map((g) => [g, 0])) as Record<QueryGroup, number>;
  const byDay = new Map<
    string,
    Record<QueryGroup | 'notListed', number> & {
      totalImpr: number;
      totalClicks: number;
      listedImpr: number;
      listedClicks: number;
    }
  >();
  const day = (d: string) => {
    let v = byDay.get(d);
    if (!v) {
      v = {
        brand: 0,
        local: 0,
        service: 0,
        other: 0,
        notListed: 0,
        totalImpr: 0,
        totalClicks: 0,
        listedImpr: 0,
        listedClicks: 0,
      };
      byDay.set(d, v);
    }
    return v;
  };
  const queries = new Map<string, QueryRowDto & { group: QueryGroup; w: number }>();
  const groupOf = new Map<string, QueryGroup>();
  for (const r of rows) {
    const clicks = r.clicks ?? 0;
    const impressions = r.impressions ?? 0;
    const d = day(r.periodStart);
    if (r.kind === 'total') {
      d.totalImpr += impressions;
      d.totalClicks += clicks;
      continue;
    }
    if (r.kind !== 'query') continue;
    let g = groupOf.get(r.key);
    if (!g) {
      g = classifyQuery(r.key, classifier);
      groupOf.set(r.key, g);
    }
    groups[g].clicks += clicks;
    groups[g].impressions += impressions;
    if (r.position !== null) weighted[g] += r.position * impressions;
    d[g] += impressions;
    d.listedImpr += impressions;
    d.listedClicks += clicks;
    const q = queries.get(r.key) ?? {
      query: r.key,
      clicks: 0,
      impressions: 0,
      position: null,
      group: g,
      w: 0,
    };
    q.clicks += clicks;
    q.impressions += impressions;
    if (r.position !== null) q.w += r.position * impressions;
    queries.set(r.key, q);
  }
  for (const g of QUERY_GROUPS) groups[g].position = groups[g].impressions > 0 ? Math.round((weighted[g] / groups[g].impressions) * 10) / 10 : null;
  let nlClicks = 0;
  let nlImpr = 0;
  const daily = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => {
      const rest = notListedRemainder({ clicks: v.totalClicks, impressions: v.totalImpr }, { clicks: v.listedClicks, impressions: v.listedImpr });
      nlClicks += rest.clicks;
      nlImpr += rest.impressions;
      return {
        date,
        brand: v.brand,
        local: v.local,
        service: v.service,
        other: v.other,
        notListed: rest.impressions,
      };
    });
  const topQueries = Object.fromEntries(
    QUERY_GROUPS.map((g) => [
      g,
      [...queries.values()]
        .filter((q) => q.group === g)
        .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
        .slice(0, 20)
        .map((q) => ({
          query: q.query,
          clicks: q.clicks,
          impressions: q.impressions,
          position: q.impressions > 0 && q.w > 0 ? Math.round((q.w / q.impressions) * 10) / 10 : null,
        })),
    ]),
  ) as Record<QueryGroup, QueryRowDto[]>;
  return {
    groups,
    notListed: { clicks: nlClicks, impressions: nlImpr },
    daily,
    topQueries,
    dataThrough: daily.at(-1)?.date ?? null,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function auditDto(a: AuditRow): AuditSummaryDto {
  const summary = AuditSummarySchema.safeParse(a.summary ?? {});
  return {
    id: a.id,
    url: a.url,
    status: a.status,
    error: a.error,
    createdAt: a.createdAt.toISOString(),
    startedAt: a.startedAt?.toISOString() ?? null,
    finishedAt: a.finishedAt?.toISOString() ?? null,
    summary: summary.success ? summary.data : AuditSummarySchema.parse({}),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

async function connection(provider: 'website' | 'google_search_console'): Promise<ConnRow | null> {
  return (
    (await getDb().query.integrationConnections.findFirst({
      where: eq(schema.integrationConnections.provider, provider),
    })) ?? null
  );
}

/**
 * Settles a queued or running check whose job will never run (cancelled before the worker started it, failed, or
 * never queued), so the "one active check" guard never blocks the owner forever.
 */
export async function reconcileActiveAudit(): Promise<void> {
  const db = getDb();
  const a = schema.websiteAudits;
  const active = await db
    .select()
    .from(a)
    .where(inArray(a.status, ['queued', 'running']));
  for (const audit of active) {
    const job = await db.query.jobs.findFirst({
      where: and(eq(schema.jobs.type, 'website.audit'), eq(schema.jobs.refId, audit.id)),
      orderBy: desc(schema.jobs.createdAt),
    });
    const stale = !job ? Date.now() - audit.createdAt.getTime() > 60_000 : job.status === 'cancelled' || job.status === 'failed';
    if (!stale) continue;
    const cancelled = job?.status === 'cancelled';
    await db
      .update(a)
      .set({
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Check cancelled. Nothing was changed.' : `The check didn't finish: ${job?.error ?? 'it could not be started'}. Try again.`,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(a.id, audit.id), inArray(a.status, ['queued', 'running'])));
  }
}

/** Everything the Website page shows on load (GET /api/website). */
export async function getWebsiteOverview(): Promise<WebsiteOverviewDto> {
  await reconcileActiveAudit();
  const db = getDb();
  const settings = await getSettings();
  const scope = siteScopeFrom(settings.business.website);
  const a = schema.websiteAudits;
  const [latest] = await db.select().from(a).orderBy(desc(a.createdAt)).limit(1);
  const lastFinished = (await db.select().from(a).where(isNotNull(a.result)).orderBy(desc(a.createdAt)).limit(2)).filter((r) => r.status === 'complete' || r.status === 'partial');
  const latestResult = lastFinished[0]?.result ? WebsiteAuditResultSchema.safeParse(lastFinished[0].result) : null;
  const previousResult = lastFinished[1]?.result ? WebsiteAuditResultSchema.safeParse(lastFinished[1].result) : null;
  const activeJob =
    latest && (latest.status === 'queued' || latest.status === 'running')
      ? ((await db.query.jobs.findFirst({
          where: and(eq(schema.jobs.type, 'website.audit'), eq(schema.jobs.refId, latest.id)),
          orderBy: desc(schema.jobs.createdAt),
        })) ?? null)
      : null;
  const open = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.websiteEdits)
    .where(inArray(schema.websiteEdits.status, [...OPEN_EDIT_STATUSES]));
  const statuses = await getIntegrationStatuses();
  const b = settings.business;
  const ownershipConfirmed = ownershipMatches(scope, settings.website.ownershipConfirmedHost);
  return {
    setup: {
      website: b.website,
      host: scope ? ownershipHost(scope.host) : null,
      websiteValid: Boolean(scope),
      ownershipConfirmed,
      ownershipConfirmedAt: ownershipConfirmed ? settings.website.ownershipConfirmedAt : null,
      missingDetails: missingBusinessDetails(settings),
      profileDetailsCheckedAt: settings.website.profileDetailsCheckedAt,
      profileDetails: {
        name: realBusinessName(settings.brand.businessName),
        address: [b.addressLine, [b.suburb, b.state, b.postcode].filter(Boolean).join(' ')].filter((s) => s.trim()).join(', '),
        phone: normaliseAuPhone(b.phone)?.national ?? b.phone,
        hours: b.openingHours.length ? openingHoursLines(b.openingHours) : [],
      },
    },
    latestAudit: latest ? auditDto(latest) : null,
    latestResult: latestResult?.success ? latestResult.data : null,
    fixedSinceLast: latestResult?.success && previousResult?.success ? fixedSince(previousResult.data.findings, latestResult.data.findings) : [],
    activeJob: activeJob ? toJobDto(activeJob) : null,
    checkBlockedReason: await auditBlockedReason(settings),
    openChanges: open[0]?.n ?? 0,
    ai: {
      copyAvailable: getEnv().AI_PROVIDER === 'anthropic' && Boolean(getEnv().ANTHROPIC_API_KEY),
    },
    connections: {
      searchConsole: statuses.find((s) => s.id === 'google_search_console') ?? null,
      wordpress: statuses.find((s) => s.id === 'website_editing') ?? null,
    },
    queryGroups: {
      brandTerms: settings.website.brandTerms,
      placeTerms: settings.website.placeTerms,
      serviceTerms: settings.website.serviceTerms,
    },
    platformHint: latestResult?.success ? latestResult.data.platformHint : null,
  };
}

/** Why a new check can't start now, or null. */
export async function auditBlockedReason(settings: AppSettings, now: Date = new Date()): Promise<string | null> {
  const scope = siteScopeFrom(settings.business.website);
  if (!scope) return 'Add your website address in Settings → Business first.';
  if (!ownershipMatches(scope, settings.website.ownershipConfirmedHost)) return 'Confirm that this is your own website first.';
  const a = schema.websiteAudits;
  const [active] = await getDb()
    .select({ id: a.id })
    .from(a)
    .where(inArray(a.status, ['queued', 'running']))
    .limit(1);
  if (active) return 'A check is already running.';
  const [last] = await getDb().select({ finishedAt: a.finishedAt }).from(a).where(isNotNull(a.finishedAt)).orderBy(desc(a.finishedAt)).limit(1);
  if (last?.finishedAt && now.getTime() - last.finishedAt.getTime() < AUDIT_COOLDOWN_MS) {
    const mins = Math.max(1, Math.round((now.getTime() - last.finishedAt.getTime()) / 60_000));
    return `Your last check finished ${mins} minute${mins === 1 ? '' : 's'} ago. Try again in a few minutes so we don't load your site unnecessarily.`;
  }
  return null;
}

/** Earlier checks, newest first (summaries only). */
export async function listAudits(limit = 20): Promise<AuditSummaryDto[]> {
  const a = schema.websiteAudits;
  const rows = await getDb()
    .select()
    .from(a)
    .orderBy(desc(a.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(auditDto);
}

/** One check with its stored result (read-only) and what was fixed since the check before it. */
export async function getAudit(id: string): Promise<{
  audit: AuditSummaryDto;
  result: WebsiteAuditResult | null;
  fixedSinceLast: string[];
}> {
  const a = schema.websiteAudits;
  const row = await getDb().query.websiteAudits.findFirst({
    where: eq(a.id, id),
  });
  if (!row) throw new AppError('NOT_FOUND', 'That website check no longer exists.');
  const parsed = row.result ? WebsiteAuditResultSchema.safeParse(row.result) : null;
  const [prev] = await getDb()
    .select()
    .from(a)
    .where(and(isNotNull(a.result), sql`${a.createdAt} < ${row.createdAt}`))
    .orderBy(desc(a.createdAt))
    .limit(1);
  const prevParsed = prev?.result ? WebsiteAuditResultSchema.safeParse(prev.result) : null;
  return {
    audit: auditDto(row),
    result: parsed?.success ? parsed.data : null,
    fixedSinceLast: parsed?.success && prevParsed?.success ? fixedSince(prevParsed.data.findings, parsed.data.findings) : [],
  };
}

function editDto(
  row: EditRow,
  conn: ConnRow | null,
  siteRoot: string | null,
  platformHint: Parameters<typeof renderEditInstructions>[1],
  aiAvailable: boolean,
  liveApplied: boolean,
): WebsiteEditDto {
  const change = WebsiteChangeSchema.parse(row.proposedChange);
  const result = row.applyResult as ApplyResult;
  const env = conn?.capabilities['environment'] === 'staging' ? 'staging' : 'live';
  let host = '';
  try {
    host = conn && typeof conn.config['baseUrl'] === 'string' ? new URL(conn.config['baseUrl']).hostname : '';
  } catch {
    host = '';
  }
  return {
    id: row.id,
    title: row.title || changeTitle(change, siteRoot),
    rationale: row.rationale,
    pageUrl: row.pageUrl,
    change,
    source: row.source as WebsiteEditSource,
    status: row.status as WebsiteEditStatus,
    statusMessage: row.statusMessage,
    statusReason: row.statusReason,
    applyAvailable: applyAvailability(change, row.status as WebsiteEditStatus, conn),
    destination: conn && conn.status === 'connected' && host ? { host, environment: env } : null,
    firstLiveApply: env === 'live' && !liveApplied,
    instructions: renderEditInstructions(change, platformHint),
    aiOptions: row.aiOptions,
    aiDraftedAt: row.aiDraftedAt?.toISOString() ?? null,
    canDraft: aiAvailable && (change.kind === 'page_title' || change.kind === 'meta_description') && (row.status === 'proposed' || row.status === 'apply_failed'),
    verification: (result.verification as Verification | undefined) ?? null,
    outcome: result.outcome ?? null,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedVia: row.appliedVia,
    // A deletion cannot be undone from here: its reverse change has no text to find (put it back in WordPress).
    canUndo: row.status === 'applied' && row.appliedVia === 'wordpress' && ((change.kind === 'text_replace' && change.after !== '') || change.kind === 'image_alt_text'),
    findingKey: row.findingKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Prepared changes for a tab: `open` (to review), `done` (applied), `dismissed` (rejected or out of date). */
export async function listEdits(filter: 'open' | 'done' | 'dismissed'): Promise<WebsiteEditDto[]> {
  await reconcileStuckEdits();
  const t = schema.websiteEdits;
  const statuses: WebsiteEditStatus[] = filter === 'open' ? ['proposed', 'approved', 'applying', 'apply_failed'] : filter === 'done' ? ['applied'] : ['rejected', 'superseded'];
  const rows = await getDb().select().from(t).where(inArray(t.status, statuses)).orderBy(desc(t.updatedAt)).limit(200);
  return mapEdits(rows);
}

/**
 * An approved or applying change whose apply job was cancelled before it ran, or failed without recording an outcome,
 * goes back to "Not applied" so the owner can see it and try again (nothing was written by a job that never ran).
 */
export async function reconcileStuckEdits(): Promise<void> {
  const db = getDb();
  const t = schema.websiteEdits;
  const stuck = await db
    .select({ id: t.id })
    .from(t)
    .where(inArray(t.status, ['approved', 'applying']));
  for (const e of stuck) {
    const job = await db.query.jobs.findFirst({
      where: and(eq(schema.jobs.type, 'website.edit_apply'), eq(schema.jobs.refId, e.id)),
      orderBy: desc(schema.jobs.createdAt),
    });
    if (!job || (job.status !== 'cancelled' && job.status !== 'failed')) continue;
    await db
      .update(t)
      .set({
        status: 'apply_failed',
        statusReason: 'error',
        statusMessage:
          job.status === 'cancelled'
            ? 'Applying was cancelled. Check the page before trying again.'
            : `The change wasn't applied: ${job.error ?? 'the job stopped'}. Check the page before trying again.`,
        updatedAt: new Date(),
      })
      .where(and(eq(t.id, e.id), inArray(t.status, ['approved', 'applying'])));
  }
}

async function mapEdits(rows: EditRow[]): Promise<WebsiteEditDto[]> {
  const [conn, settings, latest] = await Promise.all([connection('website'), getSettings(), latestResult()]);
  const scope = siteScopeFrom(settings.business.website);
  const env = getEnv();
  const aiAvailable = env.AI_PROVIDER === 'anthropic' && Boolean(env.ANTHROPIC_API_KEY);
  const [liveApplied] = await getDb()
    .select({ id: schema.websiteEdits.id })
    .from(schema.websiteEdits)
    .where(and(eq(schema.websiteEdits.appliedVia, 'wordpress'), sql`${schema.websiteEdits.applyResult}->>'outcome' in ('applied', 'already_applied')`))
    .limit(1);
  return rows.flatMap((r) => {
    try {
      return [editDto(r, conn, scope?.rootUrl ?? null, latest?.platformHint ?? null, aiAvailable, Boolean(liveApplied))];
    } catch (err) {
      getLogger().warn({ err, editId: r.id }, 'a stored website change could not be read');
      return [];
    }
  });
}

async function latestResult(): Promise<WebsiteAuditResult | null> {
  const a = schema.websiteAudits;
  const [row] = await getDb().select({ result: a.result }).from(a).where(isNotNull(a.result)).orderBy(desc(a.createdAt)).limit(1);
  const parsed = row?.result ? WebsiteAuditResultSchema.safeParse(row.result) : null;
  return parsed?.success ? parsed.data : null;
}

async function loadEdit(id: string): Promise<EditRow> {
  const row = await getDb().query.websiteEdits.findFirst({
    where: eq(schema.websiteEdits.id, id),
  });
  if (!row) throw new AppError('NOT_FOUND', 'That change no longer exists.');
  return row;
}

async function oneEditDto(id: string): Promise<WebsiteEditDto> {
  const [dto] = await mapEdits([await loadEdit(id)]);
  if (!dto) throw new AppError('INTERNAL', 'That change could not be read.');
  return dto;
}

// ---------------------------------------------------------------------------------------------
// Setup actions
// ---------------------------------------------------------------------------------------------

/** "This is my business's own website": binds checks to the saved host (server-set fields only). */
export async function confirmOwnership(user: SessionUser): Promise<{ host: string; confirmedAt: string }> {
  const at = new Date().toISOString();
  let host = '';
  await updateSettingsLocked((current) => {
    const scope = siteScopeFrom(current.business.website);
    if (!scope) throw new AppError('VALIDATION', 'Add your website address in Settings → Business first.');
    host = ownershipHost(scope.host);
    return {
      ...current,
      website: {
        ...current.website,
        ownershipConfirmedHost: host,
        ownershipConfirmedAt: at,
      },
    };
  });
  await writeAudit({
    userId: user.id,
    action: 'website.ownership.confirmed',
    entityType: 'settings',
    data: { host },
  });
  return { host, confirmedAt: at };
}

/** The manual "I've checked my Business Profile matches" tick (no API call; design §4.1 step 4). */
export async function setProfileCheck(checked: boolean): Promise<{ profileDetailsCheckedAt: string | null }> {
  const value = checked ? new Date().toISOString() : null;
  await updateSettingsLocked((current) => ({
    ...current,
    website: { ...current.website, profileDetailsCheckedAt: value },
  }));
  return { profileDetailsCheckedAt: value };
}

/** Edits the search-grouping word lists (grouping happens at read time, so history regroups at once). */
export async function updateQueryGroups(patch: {
  brandTerms?: string[] | undefined;
  placeTerms?: string[] | undefined;
  serviceTerms?: string[] | undefined;
}): Promise<AppSettings['website']> {
  const next = await updateSettingsLocked((current) => {
    const merged = WebsiteSettingsSchema.parse({
      ...current.website,
      ...(patch.brandTerms ? { brandTerms: patch.brandTerms } : {}),
      ...(patch.placeTerms ? { placeTerms: patch.placeTerms } : {}),
      ...(patch.serviceTerms ? { serviceTerms: patch.serviceTerms } : {}),
    });
    return { ...current, website: merged };
  });
  return next.website;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Starts a website check: one at a time (database guard), 5-minute cool-down, setup complete. */
export async function requestAudit(user: SessionUser): Promise<{ audit: AuditSummaryDto; job: ReturnType<typeof toJobDto> }> {
  await reconcileActiveAudit();
  const settings = await getSettings();
  const blocked = await auditBlockedReason(settings);
  const scope = siteScopeFrom(settings.business.website);
  if (blocked && !scope) throw new AppError('VALIDATION', blocked);
  if (blocked && blocked.startsWith('Confirm')) throw new AppError('VALIDATION', blocked);
  if (blocked) throw new AppError('CONFLICT', blocked);
  const id = newId();
  try {
    await getDb().insert(schema.websiteAudits).values({
      id,
      url: scope!.rootUrl,
      status: 'queued',
      requestedBy: user.id,
    });
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505')
      throw new AppError('CONFLICT', 'A check is already running.');
    throw err;
  }
  let job;
  try {
    job = await createTrackedJob({
      type: 'website.audit',
      payload: { auditId: id },
      projectId: null,
      singletonKey: 'website-audit',
    });
  } catch (err) {
    await getDb()
      .update(schema.websiteAudits)
      .set({
        status: 'failed',
        error: "The check couldn't be started. Try again.",
        finishedAt: new Date(),
      })
      .where(eq(schema.websiteAudits.id, id));
    throw err;
  }
  await writeAudit({
    userId: user.id,
    action: 'website.audit.requested',
    entityType: 'website_audit',
    entityId: id,
    data: { url: scope!.rootUrl },
  });
  const row = (await getDb().query.websiteAudits.findFirst({
    where: eq(schema.websiteAudits.id, id),
  }))!;
  return { audit: auditDto(row), job: toJobDto(job) };
}

// ---------------------------------------------------------------------------------------------
// Prepared changes
// ---------------------------------------------------------------------------------------------

/** An owner-written change (image description or a text correction) on a page of the latest check. */
export async function createOwnerEdit(
  user: SessionUser,
  input:
    | {
        kind: 'image_alt_text';
        pageUrl: string;
        imageSrc: string;
        after: string;
      }
    | { kind: 'text_replace'; pageUrl: string; before: string; after: string },
): Promise<WebsiteEditDto> {
  const latest = await latestResult();
  const page = latest?.pages.find((p) => p.skipped === null && (sameUrl(p.finalUrl, input.pageUrl) || sameUrl(p.url, input.pageUrl)));
  if (!latest || !page || !inSiteScope(input.pageUrl, latest.siteRoot)) throw new AppError('VALIDATION', 'Choose a page from your latest website check.');
  let change: WebsiteChange;
  if (input.kind === 'image_alt_text') {
    const img = page.images.find((i) => i.src === input.imageSrc);
    if (!img) throw new AppError('VALIDATION', 'That image was not on the page in your latest check.');
    change = WebsiteChangeSchema.parse({
      kind: 'image_alt_text',
      pageUrl: page.finalUrl,
      imageSrc: img.src,
      before: img.alt,
      after: input.after,
    });
  } else {
    const facts = [page.title, page.metaDescription, page.textSample, ...page.h1, ...page.nap.phones].filter(Boolean).join('\n');
    if (!facts.includes(input.before)) throw new AppError('VALIDATION', 'That text was not found on the page in your latest check.');
    change = WebsiteChangeSchema.parse({
      kind: 'text_replace',
      pageUrl: page.finalUrl,
      before: input.before,
      after: input.after,
    });
  }
  const id = newId();
  const dedupeKey = editDedupeKey(change);
  const inserted = await getDb()
    .insert(schema.websiteEdits)
    .values({
      id,
      title: changeTitle(change, latest.siteRoot),
      rationale: 'Written by you.',
      pageUrl: change.pageUrl,
      proposedChange: change,
      status: 'proposed',
      source: 'owner',
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: schema.websiteEdits.id });
  if (!inserted.length) throw new AppError('CONFLICT', 'There is already an open change for this. Edit that one instead.');
  await writeAudit({
    userId: user.id,
    action: 'website.edit.created',
    entityType: 'website_edit',
    entityId: id,
    data: { kind: change.kind, pageUrl: change.pageUrl },
  });
  return oneEditDto(id);
}

/** Statuses in which a prepared change's wording, source or status may still change. */
const EDITABLE_EDIT_STATUSES = ['proposed', 'apply_failed'] as const;
/** Audit entries keep at most this much of a change's before and after text (design §10.6). */
const AUDIT_TEXT_MAX = 200;
const auditText = (v: string | null | undefined): string | null => (typeof v === 'string' ? v.slice(0, AUDIT_TEXT_MAX) : null);
/** Answer (409) when a change was claimed for applying between reading and writing it. */
const EDIT_BEING_APPLIED = 'This change is being applied, so it can no longer be edited.';

/** Owner edits the wording (kind limits apply; claim checks are soft warnings for the owner's own text). */
export async function patchEdit(user: SessionUser, id: string, after: string): Promise<{ edit: WebsiteEditDto; warnings: string[] }> {
  const row = await loadEdit(id);
  if (row.status !== 'proposed' && row.status !== 'apply_failed') throw new AppError('CONFLICT', 'This change can no longer be edited.');
  const current = WebsiteChangeSchema.parse(row.proposedChange);
  const next = WebsiteChangeSchema.safeParse({ ...current, after });
  if (!next.success)
    throw new AppError(
      'VALIDATION',
      next.error.issues[0]?.message ? `That wording doesn't fit: ${next.error.issues[0].message}.` : "That wording doesn't fit this kind of change.",
    );
  const settings = await getSettings();
  const warnings =
    current.kind === 'page_title' || current.kind === 'meta_description' || current.kind === 'image_alt_text'
      ? checkCopyClaims(after, {
          kind: current.kind,
          businessName: realBusinessName(settings.brand.businessName),
          phone: settings.business.phone,
        })
      : [];
  // Only while still editable: an apply that claimed the row meanwhile keeps the wording the owner confirmed.
  const updated = await getDb()
    .update(schema.websiteEdits)
    .set({
      proposedChange: next.data,
      source: 'owner',
      status: 'proposed',
      statusMessage: '',
      statusReason: null,
      // A write marker belongs to the wording it was recorded for (design §7.4.1): new wording starts afresh.
      applyResult: clearWriteMarker(row.applyResult),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.websiteEdits.id, id), inArray(schema.websiteEdits.status, [...EDITABLE_EDIT_STATUSES])))
    .returning({ id: schema.websiteEdits.id });
  if (!updated.length) throw new AppError('CONFLICT', EDIT_BEING_APPLIED);
  await writeAudit({
    userId: user.id,
    action: 'website.edit.edited',
    entityType: 'website_edit',
    entityId: id,
    data: { kind: current.kind, after: auditText(after) },
  });
  return { edit: await oneEditDto(id), warnings };
}

/** Queues AI wording for a title or description (only when AI is configured). */
export async function requestDraft(user: SessionUser, id: string): Promise<{ job: ReturnType<typeof toJobDto> }> {
  const env = getEnv();
  if (env.AI_PROVIDER !== 'anthropic' || !env.ANTHROPIC_API_KEY) throw new AppError('UNSUPPORTED', 'AI wording suggestions are not set up on this server.');
  const row = await loadEdit(id);
  const change = WebsiteChangeSchema.parse(row.proposedChange);
  if (change.kind !== 'page_title' && change.kind !== 'meta_description')
    throw new AppError('UNSUPPORTED', 'Wording suggestions are only for page titles and search descriptions.');
  const job = await createTrackedJob({
    type: 'website.copy_draft',
    payload: { editId: id },
    projectId: null,
    singletonKey: `website-copy:${id}`,
  });
  await writeAudit({
    userId: user.id,
    action: 'website.edit.ai_draft_requested',
    entityType: 'website_edit',
    entityId: id,
    data: { kind: change.kind },
  });
  return { job: toJobDto(job) };
}

/** Copies one AI option into the change (source `ai_draft`, always labelled). */
export async function chooseDraft(user: SessionUser, id: string, index: number): Promise<WebsiteEditDto> {
  const row = await loadEdit(id);
  const option = row.aiOptions[index];
  if (option === undefined) throw new AppError('VALIDATION', 'That suggestion is no longer available.');
  if (row.status !== 'proposed' && row.status !== 'apply_failed') throw new AppError('CONFLICT', 'This change can no longer be edited.');
  const next = WebsiteChangeSchema.parse({
    ...WebsiteChangeSchema.parse(row.proposedChange),
    after: option,
  });
  const updated = await getDb()
    .update(schema.websiteEdits)
    .set({ proposedChange: next, source: 'ai_draft', applyResult: clearWriteMarker(row.applyResult), updatedAt: new Date() })
    .where(and(eq(schema.websiteEdits.id, id), inArray(schema.websiteEdits.status, [...EDITABLE_EDIT_STATUSES])))
    .returning({ id: schema.websiteEdits.id });
  if (!updated.length) throw new AppError('CONFLICT', EDIT_BEING_APPLIED);
  await writeAudit({
    userId: user.id,
    action: 'website.edit.ai_draft_chosen',
    entityType: 'website_edit',
    entityId: id,
    data: { index },
  });
  return oneEditDto(id);
}

/** What the confirmation dialog showed besides the new wording (each optional, checked when sent). */
export interface ApplyExpectations {
  /** The old text the dialog showed (null when the change has none). */
  expectedBefore?: string | null | undefined;
  /** The destination the dialog showed. */
  expectedDestination?: { host: string; environment: 'live' | 'staging' } | undefined;
}

/**
 * The owner's explicit "Apply now": checks the wording (and, when sent, the old text and the destination) is what the
 * dialog showed, that a connected adapter supports the change, records the approval bound to that change and
 * destination (`approvalHash`, checked again by the worker before it writes) and queues the apply job.
 */
export async function applyEdit(
  user: SessionUser,
  id: string,
  expectedAfter: string,
  expected: ApplyExpectations = {},
): Promise<{ edit: WebsiteEditDto; job: ReturnType<typeof toJobDto> }> {
  const row = await loadEdit(id);
  const change = WebsiteChangeSchema.parse(row.proposedChange);
  const before = 'before' in change ? change.before : null;
  if (change.after !== expectedAfter || (expected.expectedBefore !== undefined && expected.expectedBefore !== before))
    throw new AppError('CONFLICT', 'This change was edited since you opened it. Check the new wording and apply again.');
  const conn = await connection('website');
  const available = applyAvailability(change, row.status as WebsiteEditStatus, conn);
  if (!available.ok)
    throw new AppError(row.status === 'proposed' || row.status === 'apply_failed' ? 'UNSUPPORTED' : 'CONFLICT', available.reason ?? 'This change is not waiting to be applied.');
  const destination = approvalDestination(conn);
  if (!destination) throw new AppError('UNSUPPORTED', 'Your website editing connection needs attention. Check it in Settings → Integrations.');
  if (expected.expectedDestination) {
    let host = '';
    try {
      host = new URL(destination.baseUrl).hostname;
    } catch {
      host = '';
    }
    if (host !== expected.expectedDestination.host || destination.environment !== expected.expectedDestination.environment)
      throw new AppError('CONFLICT', 'Your WordPress connection changed since you opened this. Check where the change goes and apply again.');
  }
  const approval = approvalHash(change, destination);
  const now = new Date();
  const updated = await getDb()
    .update(schema.websiteEdits)
    .set({
      status: 'approved',
      approvedBy: user.id,
      approvedAt: now,
      statusMessage: 'Applying…',
      statusReason: null,
      // Kept beside any write marker of an earlier attempt of this same change (the worker decides with it).
      applyResult: sql`${schema.websiteEdits.applyResult} || ${JSON.stringify({ approvalHash: approval })}::jsonb`,
      updatedAt: now,
    })
    // The approval holds only for the change as it was read here (and the dialog showed): an edit or a check's refresh
    // that landed after it was read wins the race and this approval is refused (the owner confirms again).
    .where(
      and(
        eq(schema.websiteEdits.id, id),
        inArray(schema.websiteEdits.status, [...EDITABLE_EDIT_STATUSES]),
        sql`${schema.websiteEdits.proposedChange} = ${JSON.stringify(row.proposedChange)}::jsonb`,
      ),
    )
    .returning({ id: schema.websiteEdits.id });
  if (!updated.length) {
    const now2 = await loadEdit(id);
    throw new AppError(
      'CONFLICT',
      now2.status === 'proposed' || now2.status === 'apply_failed' ? 'This change was edited since you opened it. Check the new wording and apply again.' : 'This change is already being applied.',
    );
  }
  await writeAudit({
    userId: user.id,
    action: 'website.edit.apply_requested',
    entityType: 'website_edit',
    entityId: id,
    data: {
      kind: change.kind,
      pageUrl: change.pageUrl,
      before: auditText(before),
      after: auditText(change.after),
    },
  });
  const job = await createTrackedJob({
    type: 'website.edit_apply',
    payload: { editId: id },
    projectId: null,
    singletonKey: `website-edit-apply:${id}`,
  });
  return { edit: await oneEditDto(id), job: toJobDto(job) };
}

/** "I've made this change": applied by hand; the next check confirms it. */
export async function markDone(user: SessionUser, id: string): Promise<WebsiteEditDto> {
  const updated = await getDb()
    .update(schema.websiteEdits)
    .set({
      status: 'applied',
      appliedVia: 'manual',
      appliedAt: new Date(),
      applyResult: {
        verification: 'pending',
        outcome: 'applied',
        message: 'Made by hand.',
      },
      statusMessage: 'Your next website check confirms it.',
      statusReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.websiteEdits.id, id), inArray(schema.websiteEdits.status, ['proposed', 'apply_failed'])))
    .returning({ id: schema.websiteEdits.id });
  if (!updated.length) throw new AppError('CONFLICT', 'This change is not open any more.');
  await writeAudit({
    userId: user.id,
    action: 'website.edit.marked_done',
    entityType: 'website_edit',
    entityId: id,
  });
  return oneEditDto(id);
}

/** Dismisses a change with an optional reason. */
export async function rejectEdit(user: SessionUser, id: string, reason: string | undefined): Promise<WebsiteEditDto> {
  const updated = await getDb()
    .update(schema.websiteEdits)
    .set({
      status: 'rejected',
      statusMessage: reason ? `Dismissed: ${reason}` : 'Dismissed.',
      statusReason: 'dismissed',
      updatedAt: new Date(),
    })
    .where(and(eq(schema.websiteEdits.id, id), inArray(schema.websiteEdits.status, ['proposed', 'apply_failed'])))
    .returning({ id: schema.websiteEdits.id });
  if (!updated.length) throw new AppError('CONFLICT', 'This change is not open any more.');
  await writeAudit({
    userId: user.id,
    action: 'website.edit.rejected',
    entityType: 'website_edit',
    entityId: id,
    data: { reason: reason ?? '' },
  });
  return oneEditDto(id);
}

/** Undo of a change applied through WordPress: a new reverse change the owner then applies with the normal confirm. */
export async function undoEdit(user: SessionUser, id: string): Promise<WebsiteEditDto> {
  const row = await loadEdit(id);
  const change = WebsiteChangeSchema.parse(row.proposedChange);
  if (row.status !== 'applied' || row.appliedVia !== 'wordpress' || (change.kind !== 'text_replace' && change.kind !== 'image_alt_text'))
    throw new AppError('UNSUPPORTED', 'Only changes applied through WordPress can be undone from here.');
  if (change.kind === 'text_replace' && change.after === '')
    throw new AppError('UNSUPPORTED', 'Removed text cannot be put back from here, because there is nothing left to find on the page. Restore it from the page’s revisions in WordPress.');
  const reverse: WebsiteChange =
    change.kind === 'text_replace'
      ? {
          kind: 'text_replace',
          pageUrl: change.pageUrl,
          before: change.after || change.before,
          after: change.before,
        }
      : {
          kind: 'image_alt_text',
          pageUrl: change.pageUrl,
          imageSrc: change.imageSrc,
          before: change.after,
          after: change.before && change.before.trim().length >= 3 ? change.before : change.after,
        };
  if (change.kind === 'image_alt_text' && (!change.before || change.before.trim().length < 3))
    throw new AppError('UNSUPPORTED', 'The image had no description before, so there is nothing to put back. Edit the description instead.');
  const newIdValue = newId();
  const inserted = await getDb()
    .insert(schema.websiteEdits)
    .values({
      id: newIdValue,
      title: `Undo: ${row.title}`,
      rationale: 'Puts back the text from before the earlier change.',
      pageUrl: reverse.pageUrl,
      proposedChange: reverse,
      status: 'proposed',
      source: 'undo',
      revertsEditId: row.id,
      dedupeKey: editDedupeKey(reverse),
    })
    .onConflictDoNothing()
    .returning({ id: schema.websiteEdits.id });
  if (!inserted.length) throw new AppError('CONFLICT', 'An undo for this change is already waiting.');
  await writeAudit({
    userId: user.id,
    action: 'website.edit.undo_requested',
    entityType: 'website_edit',
    entityId: newIdValue,
    data: { reverts: row.id },
  });
  return oneEditDto(newIdValue);
}

// ---------------------------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------------------------

/** The search performance panel (design §4.5). No numbers unless connected and Google returned rows. */
export async function getSearchPerformance(range: SearchPerformanceDto['range'], canRefresh: boolean): Promise<SearchPerformanceDto> {
  const env = getEnv();
  const [conn, settings] = await Promise.all([connection('google_search_console'), getSettings()]);
  const classifier = buildQueryClassifier(settings);
  const properties = Array.isArray(conn?.config['properties'])
    ? (
        conn.config['properties'] as Array<{
          siteUrl?: unknown;
          permissionLevel?: unknown;
        }>
      )
        .filter((p) => typeof p.siteUrl === 'string')
        .map((p) => {
          const level = typeof p.permissionLevel === 'string' ? p.permissionLevel : '';
          const readable = ['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(level);
          return {
            siteUrl: String(p.siteUrl),
            permission: level === 'siteOwner' ? 'Owner' : level === 'siteFullUser' ? 'Full' : level === 'siteRestrictedUser' ? 'Restricted' : 'No access',
            readable,
          };
        })
    : [];
  const empty = (state: SearchPanelState, message: string | null): SearchPerformanceDto => ({
    state,
    message,
    property: chosenProperty(
      conn
        ? {
            provider: conn.provider,
            status: conn.status,
            displayName: conn.displayName,
            config: conn.config,
          }
        : undefined,
    ),
    properties,
    range,
    dataThrough: null,
    lastSyncAt: conn?.lastSyncAt?.toISOString() ?? null,
    groups: null,
    notListed: null,
    daily: [],
    topQueries: null,
    brandAmbiguous: classifier.brandAmbiguous,
    canRefresh: false,
  });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return empty('not_configured', null);
  if (!conn || conn.status === 'disconnected' || conn.status === 'not_configured') return empty('not_connected', null);
  if (conn.status === 'needs_reauth') return empty('needs_reauth', conn.lastError);
  if (conn.status === 'error') return empty('error', conn.lastError);
  const property = typeof conn.config['siteUrl'] === 'string' ? conn.config['siteUrl'] : null;
  if (!property) return empty(properties.some((p) => p.readable) ? 'choose_property' : 'no_property', conn.lastError);
  const m = schema.searchMetrics;
  const [last] = await getDb()
    .select({ d: sql<string>`max(${m.periodStart})::text` })
    .from(m)
    .where(and(eq(m.source, 'search_console'), eq(m.property, property)));
  if (!last?.d) {
    const syncing = await getDb().query.jobs.findFirst({
      where: and(eq(schema.jobs.type, 'search.sync'), inArray(schema.jobs.status, ['queued', 'running'])),
    });
    return {
      ...empty(syncing ? 'syncing' : 'no_data', null),
      canRefresh: canRefresh && !syncing,
    };
  }
  const from = addDays(last.d, -(rangeDays(range) - 1));
  const rows = await getDb()
    .select({
      periodStart: m.periodStart,
      kind: m.kind,
      key: m.key,
      clicks: m.clicks,
      impressions: m.impressions,
      position: m.position,
    })
    .from(m)
    .where(and(eq(m.source, 'search_console'), eq(m.property, property), eq(m.granularity, 'day'), gte(m.periodStart, from), ne(m.kind, 'metric')));
  return {
    ...empty('connected', null),
    ...groupSearchRows(rows, classifier),
    canRefresh,
  };
}

/** Manual refresh (at most every 15 minutes). */
export async function requestSearchSync(user: SessionUser): Promise<{ job: ReturnType<typeof toJobDto> }> {
  const conn = await connection('google_search_console');
  if (!conn || conn.status !== 'connected' || typeof conn.config['siteUrl'] !== 'string')
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Search Console and choose your property first.');
  const recent = await getDb().query.jobs.findFirst({
    where: and(eq(schema.jobs.type, 'search.sync'), sql`${schema.jobs.createdAt} > now() - interval '15 minutes'`, ne(schema.jobs.status, 'failed')),
  });
  if (recent || (conn.lastSyncAt && Date.now() - conn.lastSyncAt.getTime() < SEARCH_SYNC_COOLDOWN_MS))
    throw new AppError('RATE_LIMITED', 'Updated a few minutes ago. Try again later.');
  const job = await createTrackedJob({
    type: 'search.sync',
    payload: { source: 'search_console', reason: 'manual' },
    projectId: null,
    singletonKey: 'search-sync:search_console',
  });
  await writeAudit({
    userId: user.id,
    action: 'search.sync.requested',
    entityType: 'integration_connection',
    entityId: conn.id,
    data: { source: 'search_console' },
  });
  return { job: toJobDto(job) };
}

/** Chooses the Search Console property (one of the listed ones) and queues the first sync. */
export async function selectSearchConsoleProperty(user: SessionUser, siteUrl: string): Promise<{ property: string; job: ReturnType<typeof toJobDto> }> {
  const conn = await connection('google_search_console');
  if (!conn || conn.status !== 'connected') throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Search Console first.');
  const listed = Array.isArray(conn.config['properties'])
    ? (conn.config['properties'] as Array<{
        siteUrl?: unknown;
        permissionLevel?: unknown;
      }>)
    : [];
  const entry = listed.find((p) => p.siteUrl === siteUrl);
  if (!entry || !['siteOwner', 'siteFullUser', 'siteRestrictedUser'].includes(String(entry.permissionLevel)))
    throw new AppError('VALIDATION', 'Choose one of the properties your Google account can read.');
  const t = schema.integrationConnections;
  await getDb()
    .update(t)
    .set({
      config: sql`${t.config} || ${JSON.stringify({ siteUrl })}::jsonb`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(t.provider, 'google_search_console'));
  await writeAudit({
    userId: user.id,
    action: 'integration.google_search_console.property_selected',
    entityType: 'integration_connection',
    entityId: conn.id,
    data: { siteUrl },
  });
  const job = await createTrackedJob({
    type: 'search.sync',
    payload: { source: 'search_console', reason: 'connect' },
    projectId: null,
    singletonKey: 'search-sync:search_console',
  });
  return { property: siteUrl, job: toJobDto(job) };
}

/** Queues a read-only connection check. */
export async function checkWebsiteConnection(provider: 'google_search_console' | 'website'): Promise<{ job: ReturnType<typeof toJobDto> }> {
  const conn = await connection(provider);
  if (!conn || conn.status === 'disconnected')
    throw new AppError('INTEGRATION_NOT_CONFIGURED', provider === 'website' ? 'Connect WordPress first.' : 'Connect Search Console first.');
  const job = await createTrackedJob({
    type: 'website.connection_check',
    payload: { provider, reason: 'manual' },
    projectId: null,
    singletonKey: `website-check:${provider}`,
  });
  return { job: toJobDto(job) };
}

/** Disconnects Search Console (Google revokes through the shared job) and optionally deletes its stored numbers. */
export async function disconnectSearchConsole(user: SessionUser, deleteData: boolean): Promise<void> {
  const conn = await connection('google_search_console');
  if (!conn || conn.status === 'disconnected') return;
  const t = schema.integrationConnections;
  await getDb().update(t).set({ status: 'disconnected', lastError: null, updatedAt: new Date() }).where(eq(t.id, conn.id));
  if (deleteData) await getDb().delete(schema.searchMetrics).where(eq(schema.searchMetrics.source, 'search_console'));
  await createTrackedJob({
    type: 'google.disconnect',
    payload: { connectionId: conn.id },
    projectId: null,
    singletonKey: `google-disconnect:${conn.id}`,
  });
  await writeAudit({
    userId: user.id,
    action: 'integration.google_search_console.disconnected',
    entityType: 'integration_connection',
    entityId: conn.id,
    data: { deleteData },
  });
}

/** Saves the WordPress connection (credential encrypted, never echoed) and queues the read-only check. */
export async function saveWordPress(
  user: SessionUser,
  input: { baseUrl: string; username: string; applicationPassword: string },
): Promise<{ state: 'checking'; job: ReturnType<typeof toJobDto> }> {
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'https:') throw new AppError('VALIDATION', 'Use your site’s https:// address.');
  if (base.username || base.password || (base.port && base.port !== '443')) throw new AppError('VALIDATION', 'Use your site’s plain https:// address.');
  // The worker refuses private addresses when it connects (with DNS, every time); refuse them here as well, also for a
  // name that resolves to one, so the owner hears at once instead of after the check runs.
  const privateHost = await resolvedPrivateHostReason(base.hostname, async (host) => dnsLookup(host, { all: true, verbatim: true }));
  if (privateHost) throw new AppError('VALIDATION', `That address points to ${privateHost}, not a public website. Use your site’s public https:// address.`);
  const baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const values = {
    status: 'not_configured' as const,
    accessTokenEncrypted: encryptToken(`${input.username.trim()}:${input.applicationPassword.trim()}`),
    refreshTokenEncrypted: null,
    displayName: input.username.trim().slice(0, 120),
    config: { baseUrl },
    capabilities: {},
    lastError: null,
    updatedAt: new Date(),
  };
  const rows = await getDb()
    .insert(schema.integrationConnections)
    .values({ id: newId(), provider: 'website', ...values })
    .onConflictDoUpdate({
      target: schema.integrationConnections.provider,
      set: values,
    })
    .returning({ id: schema.integrationConnections.id });
  await writeAudit({
    userId: user.id,
    action: 'integration.website.connected',
    entityType: 'integration_connection',
    entityId: rows[0]?.id ?? null,
    data: { baseUrl },
  });
  const job = await createTrackedJob({
    type: 'website.connection_check',
    payload: { provider: 'website', reason: 'connect' },
    projectId: null,
    singletonKey: 'website-check:website',
  });
  return { state: 'checking', job: toJobDto(job) };
}

/** Disconnects WordPress: wipes the credential; approved changes go back to "to review". */
export async function disconnectWordPress(user: SessionUser): Promise<void> {
  const conn = await connection('website');
  if (!conn) return;
  const t = schema.integrationConnections;
  await getDb()
    .update(t)
    .set({
      status: 'disconnected',
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      capabilities: {},
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(t.id, conn.id));
  await getDb()
    .update(schema.websiteEdits)
    .set({
      status: 'proposed',
      approvedBy: null,
      approvedAt: null,
      statusMessage: 'WordPress was disconnected before this was applied.',
      updatedAt: new Date(),
    })
    .where(eq(schema.websiteEdits.status, 'approved'));
  await writeAudit({
    userId: user.id,
    action: 'integration.website.disconnected',
    entityType: 'integration_connection',
    entityId: conn.id,
  });
}

/** True when a URL is on the confirmed site (for showing an "Open" link next to page addresses). */
export function isOwnSitePage(url: string, website: string): boolean {
  const scope = siteScopeFrom(website);
  return scope ? isInScope(url, scope) : false;
}
