import { and, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  CancelledError,
  NonRetryableError,
  WebsiteAuditResultSchema,
  buildFinding,
  ownershipMatches,
  prioritiseFindings,
  runWebsiteChecks,
  settingsSnapshot,
  siteScopeFrom,
  summariseAudit,
  type JobPayload,
  type WebsiteAuditResult,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { friendlyFailure, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { loadSettings } from '../lib/plan-context.js';
import { refreshChanges, watchTextsFor } from '../website/changes.js';
import { crawlSite } from '../website/crawl.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';
import { WebsiteFetcher } from '../website/fetcher.js';

/** Checks whose results are kept in full; older checks keep only their summary (design §8.1). */
export const KEEP_FULL_RESULTS = 20;

/**
 * `website.audit` (design §7.1, §8): claims the queued check, crawls the owner's confirmed site, runs the checks,
 * stores the validated result and summary, and refreshes prepared changes in the same transaction. A retry starts the
 * crawl again and overwrites the result (idempotent). Cancelling discards the partial result. Never changes the site.
 */
export async function handleWebsiteAudit(ctx: WorkerContext, run: TrackedRun, payload: JobPayload<'website.audit'>, deps: WebsiteDeps = defaultWebsiteDeps(ctx)): Promise<void> {
  const a = schema.websiteAudits;
  const claimed = await ctx.db
    .update(a)
    .set({
      status: 'running',
      startedAt: deps.now(),
      error: null,
      updatedAt: deps.now(),
    })
    .where(and(eq(a.id, payload.auditId), inArray(a.status, ['queued', 'running'])))
    .returning();
  const audit = claimed[0];
  if (!audit) {
    await run.message('This check had already finished');
    return;
  }
  const finish = async (status: 'failed' | 'cancelled', error: string) => {
    await ctx.db
      .update(a)
      .set({
        status,
        error,
        result: null,
        finishedAt: deps.now(),
        updatedAt: deps.now(),
      })
      .where(and(eq(a.id, audit.id), eq(a.status, 'running')));
  };
  try {
    const settings = await loadSettings(ctx);
    const scope = siteScopeFrom(settings.business.website);
    if (!scope) throw new NonRetryableError('VALIDATION', 'Add your website address in Settings → Business, then check again.');
    if (!ownershipMatches(scope, settings.website.ownershipConfirmedHost))
      throw new NonRetryableError('VALIDATION', 'Confirm on the Website page that this is your own website, then check again.');
    const fetcher = new WebsiteFetcher(deps.fetchPolicy, [scope.host, scope.twinHost], deps.crawlerClock?.now, deps.crawlerClock?.sleep);
    const snapshot = settingsSnapshot(settings);
    const out = await crawlSite({
      scope,
      snapshot,
      checkExternalLinks: settings.website.checkExternalLinks,
      watchTexts: await watchTextsFor(ctx.db),
      fetcher,
      signal: run.signal,
      progress: (f, m) => run.progress(f, m),
      checkCancelled: () => run.checkCancelled(),
    });
    run.checkCancelled();
    const findings = out.blockedByRobots
      ? out.facts.robots.googlebotBlocksHome
        ? [
            buildFinding('robots_blocks_google', 'robots', {
              detail: 'Your robots.txt asks Google not to read your home page.',
              pages: [scope.rootUrl],
            }),
          ]
        : out.facts.robots.status === 'unreachable'
          ? [
              // The site answers but robots.txt gives a server error: nothing more is read (RFC 9309), and the owner
              // is told why, since Google also stops reading the site while this lasts.
              buildFinding('robots_unreachable', 'robots', {
                detail: `${new URL('/robots.txt', scope.rootUrl).toString()} gave a server error.`,
              }),
            ]
          : []
      : out.homeNotRead
        ? // The home page could not be read (a very long Crawl-delay, or it forwards to an address robots.txt keeps us
          // out of): no findings, only the partial reason; never a false "site unreachable".
          []
        : prioritiseFindings(runWebsiteChecks(out.facts, settings, deps.now()));
    const result: WebsiteAuditResult = WebsiteAuditResultSchema.parse({
      ...out.facts,
      findings,
    });
    const summary = summariseAudit(result, out.partialReasons);
    const status = out.partialReasons.length ? 'partial' : 'complete';
    const refreshed = await ctx.db.transaction(async (tx) => {
      const stored = await tx
        .update(a)
        .set({
          status,
          result,
          summary,
          url: scope.rootUrl,
          error: null,
          finishedAt: deps.now(),
          updatedAt: deps.now(),
        })
        .where(and(eq(a.id, audit.id), eq(a.status, 'running')))
        .returning({ id: a.id });
      if (!stored.length) return null; // cancelled or replaced meanwhile
      if (out.blockedByRobots || out.homeNotRead || !result.pages.some((p) => p.status !== null && p.status < 400 && !p.skipped)) return { inserted: 0, refreshed: 0, superseded: 0, verified: 0 };
      return refreshChanges(tx, {
        auditId: audit.id,
        facts: out.facts,
        findings,
        extras: {
          robotsText: out.robotsText,
          tagline: settings.brand.tagline,
          instagramHandle: settings.business.instagramHandle,
          tiktokHandle: settings.business.tiktokHandle,
        },
        textHits: out.textHits,
        now: deps.now(),
      });
    });
    const pages = summary.pagesChecked;
    await run.progress(1, refreshed ? `Checked ${pages} page${pages === 1 ? '' : 's'}; ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'The check was stopped');
  } catch (err) {
    if (err instanceof CancelledError) {
      const outcome = await stopOutcome(run);
      if (outcome === 'cancelled') await finish('cancelled', 'Check cancelled. Nothing was changed.');
      else if (outcome === 'failed') await finish('failed', 'The check was interrupted before it could finish. Try again.');
      // 'resume': the row stays running; the queue's next attempt claims it again and starts over.
    } else if (err instanceof NonRetryableError || !run.willRetry) {
      await finish('failed', friendlyFailure(err));
    }
    throw err;
  }
}

/** Cleanup: only the newest checks keep their full result; older ones keep their summary (`result = NULL`). */
export async function trimOldAuditResults(ctx: WorkerContext): Promise<string> {
  const a = schema.websiteAudits;
  const keep = await ctx.db.select({ id: a.id }).from(a).where(isNotNull(a.result)).orderBy(desc(a.createdAt)).limit(KEEP_FULL_RESULTS);
  if (keep.length < KEEP_FULL_RESULTS) return 'website: nothing to trim';
  const trimmed = await ctx.db
    .update(a)
    .set({ result: null, updatedAt: new Date() })
    .where(
      and(
        isNotNull(a.result),
        notInArray(
          a.id,
          keep.map((k) => k.id),
        ),
        sql`${a.status} not in ('queued', 'running')`,
      ),
    )
    .returning({ id: a.id });
  return `website: trimmed ${trimmed.length} old check result${trimmed.length === 1 ? '' : 's'}`;
}
