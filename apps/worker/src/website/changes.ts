import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  OPEN_EDIT_STATUSES,
  WebsiteChangeSchema,
  editDedupeKey,
  normaliseUrl,
  observeChange,
  prepareChanges,
  refreshChange,
  sameUrl,
  supersedeReason,
  verificationFromObservation,
  newId,
  type CrawlFacts,
  type Finding,
  type PrepareExtras,
  type WebsiteChange,
  type WebsiteEditSource,
  type WebsiteEditStatus,
} from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { DbTransaction } from '../lib/connections.js';

/**
 * After a check (design §6.9, one transaction): prepared changes are inserted once per dedupe key (a re-run refreshes
 * `before`, and `after` only while the wording is still the rule's own), open changes whose finding disappeared or
 * whose page changed are superseded, and applied changes waiting for confirmation are verified from the page facts.
 */

const SUPERSEDE_MESSAGES = {
  finding_gone: 'The latest check no longer found this problem.',
  page_changed: 'Your page changed since this was suggested.',
} as const;

/** Strings to look for in each page's text: the old and new text of open and unconfirmed text replacements. */
export async function watchTextsFor(db: Database | DbTransaction): Promise<Map<string, string[]>> {
  const t = schema.websiteEdits;
  const rows = await db
    .select({ change: t.proposedChange, status: t.status })
    .from(t)
    .where(inArray(t.status, [...OPEN_EDIT_STATUSES, 'applied']));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const parsed = WebsiteChangeSchema.safeParse(r.change);
    if (!parsed.success || parsed.data.kind !== 'text_replace') continue;
    const key = normaliseUrl(parsed.data.pageUrl) ?? parsed.data.pageUrl;
    out.set(key, [...(out.get(key) ?? []), parsed.data.before, parsed.data.after].filter(Boolean));
  }
  return out;
}

/** Counts of what the refresh did (for the job message and tests). */
export interface RefreshSummary {
  inserted: number;
  refreshed: number;
  superseded: number;
  verified: number;
}

/** Refreshes prepared changes after a finished check. Pass the open transaction that stores the check's result. */
export async function refreshChanges(
  tx: DbTransaction,
  input: {
    auditId: string;
    facts: CrawlFacts;
    findings: Finding[];
    extras: PrepareExtras;
    textHits: Map<string, Set<string>>;
    now: Date;
  },
): Promise<RefreshSummary> {
  const t = schema.websiteEdits;
  const summary: RefreshSummary = {
    inserted: 0,
    refreshed: 0,
    superseded: 0,
    verified: 0,
  };
  const prepared = prepareChanges(input.facts, input.findings, input.extras);
  const seenKeys = new Set<string>();
  for (const p of prepared) {
    const parsed = WebsiteChangeSchema.safeParse(p.change);
    if (!parsed.success) continue;
    const dedupeKey = editDedupeKey(parsed.data);
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    const existing = await tx
      .select()
      .from(t)
      .where(and(eq(t.dedupeKey, dedupeKey), inArray(t.status, [...OPEN_EDIT_STATUSES])))
      .limit(1);
    const row = existing[0];
    if (row) {
      if (row.status !== 'proposed' && row.status !== 'apply_failed') continue; // approved or applying: leave alone
      const current = WebsiteChangeSchema.safeParse(row.proposedChange);
      const next = current.success ? refreshChange(current.data, row.source as WebsiteEditSource, parsed.data) : parsed.data;
      await tx
        .update(t)
        .set({
          proposedChange: next,
          findingKey: p.findingKey,
          auditId: input.auditId,
          title: p.title,
          rationale: p.rationale,
          pageUrl: next.pageUrl,
          updatedAt: input.now,
        })
        // Only while still open: an apply the owner approved meanwhile keeps the text the owner confirmed.
        .where(and(eq(t.id, row.id), inArray(t.status, ['proposed', 'apply_failed'])));
      summary.refreshed++;
      continue;
    }
    const inserted = await tx
      .insert(t)
      .values({
        id: newId(),
        auditId: input.auditId,
        title: p.title,
        rationale: p.rationale,
        pageUrl: parsed.data.pageUrl,
        proposedChange: parsed.data,
        status: 'proposed',
        source: 'audit_rule',
        findingKey: p.findingKey,
        dedupeKey,
      })
      .onConflictDoNothing()
      .returning({ id: t.id });
    if (inserted.length) summary.inserted++;
  }

  const currentFindingKeys = new Set(input.findings.map((f) => f.key));
  const pageFor = (url: string) => input.facts.pages.find((p) => sameUrl(p.finalUrl, url) || sameUrl(p.url, url));
  const hitsFor = (url: string) => input.textHits.get(normaliseUrl(url) ?? url);
  const open = await tx
    .select()
    .from(t)
    .where(inArray(t.status, ['proposed', 'apply_failed']));
  for (const row of open) {
    if (seenKeys.has(row.dedupeKey)) continue;
    const change = WebsiteChangeSchema.safeParse(row.proposedChange);
    if (!change.success) continue;
    const reason = supersedeReason({
      status: row.status as WebsiteEditStatus,
      source: row.source as WebsiteEditSource,
      change: change.data,
      findingKey: row.findingKey,
      currentFindingKeys,
      observation: observeChange(change.data, pageFor(change.data.pageUrl), hitsFor(change.data.pageUrl)),
    });
    if (!reason) continue;
    await tx
      .update(t)
      .set({
        status: 'superseded',
        statusReason: reason,
        statusMessage: SUPERSEDE_MESSAGES[reason],
        updatedAt: input.now,
      })
      .where(and(eq(t.id, row.id), inArray(t.status, ['proposed', 'apply_failed'])));
    summary.superseded++;
  }

  const applied = await tx
    .select()
    .from(t)
    .where(and(eq(t.status, 'applied'), sql`coalesce(${t.applyResult}->>'verification', 'pending') in ('pending', 'not_visible', 'confirmed_api')`));
  for (const row of applied) {
    const change = WebsiteChangeSchema.safeParse(row.proposedChange);
    if (!change.success) continue;
    const verification = verificationFromObservation(observeChange(change.data as WebsiteChange, pageFor(change.data.pageUrl), hitsFor(change.data.pageUrl)));
    if (!verification) continue;
    const when = input.now.toISOString();
    const message =
      verification === 'confirmed_public' ? `Confirmed on your site ${formatShort(input.now)}.` : 'Not showing on your site yet — it may take a while if your site uses a cache.';
    await tx
      .update(t)
      .set({
        applyResult: { ...row.applyResult, verification, verifiedAt: when },
        statusMessage: message,
        updatedAt: input.now,
      })
      .where(and(eq(t.id, row.id), eq(t.status, 'applied')));
    summary.verified++;
  }
  return summary;
}

function formatShort(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: 'numeric',
    month: 'short',
  }).format(d);
}
