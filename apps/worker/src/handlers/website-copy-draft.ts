import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { WebsiteAuditResultSchema, WebsiteChangeSchema, normaliseAuPhone, realBusinessName, sameUrl, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { loadSettings, recordAiUsage } from '../lib/plan-context.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';

/** Shown when every AI option failed the checks. */
export const DRAFTS_REJECTED_MESSAGE = "The AI suggestions didn't pass our checks, so none are shown. The suggestion above still works.";

/**
 * `website.copy_draft` (design §6.7, §8): one AI wording request for a title or search description, only after the
 * owner's click. Replaces (never appends to) the change's options. Skips with a message when AI is not configured.
 * Usage is logged to `ai_usage` with purpose `website_copy`. Nothing is applied: the owner chooses an option, then
 * presses Apply or makes the change by hand.
 */
export async function handleWebsiteCopyDraft(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: JobPayload<'website.copy_draft'>,
  deps: WebsiteDeps = defaultWebsiteDeps(ctx),
): Promise<void> {
  const writer = deps.copywriter;
  if (!writer) {
    await run.message('AI is not configured');
    return;
  }
  const t = schema.websiteEdits;
  const edit = await ctx.db.query.websiteEdits.findFirst({
    where: eq(t.id, payload.editId),
  });
  const change = edit ? WebsiteChangeSchema.safeParse(edit.proposedChange) : null;
  if (!edit || !change?.success || (change.data.kind !== 'page_title' && change.data.kind !== 'meta_description')) {
    await run.message('Wording suggestions are only for page titles and search descriptions');
    return;
  }
  const settings = await loadSettings(ctx);
  const a = schema.websiteAudits;
  const latest = await ctx.db.query.websiteAudits.findFirst({
    where: and(isNotNull(a.result)),
    orderBy: desc(a.createdAt),
  });
  const result = latest?.result ? WebsiteAuditResultSchema.safeParse(latest.result) : null;
  const page = result?.success ? result.data.pages.find((p) => sameUrl(p.finalUrl, change.data.pageUrl) || sameUrl(p.url, change.data.pageUrl)) : undefined;
  await run.progress(0.2, 'Writing suggestions…');
  const out = await writer.draft(
    {
      task: change.data.kind,
      facts: {
        businessName: realBusinessName(settings.brand.businessName),
        suburb: settings.business.suburb,
        state: settings.business.state,
        tagline: settings.brand.tagline,
        hasBookingLink: settings.business.bookingLink.trim() !== '',
        phone: normaliseAuPhone(settings.business.phone)?.national ?? '',
      },
      page: {
        url: change.data.pageUrl,
        currentTitle: page?.title ?? null,
        currentDescription: page?.metaDescription ?? null,
        h1: page?.h1 ?? [],
        textSample: page?.textSample ?? null,
      },
    },
    { signal: run.signal },
  );
  await recordAiUsage(ctx, null, 'website_copy', out.usage);
  await ctx.db
    .update(t)
    .set({
      aiOptions: out.options,
      aiDraftedAt: deps.now(),
      statusMessage: out.options.length ? '' : DRAFTS_REJECTED_MESSAGE,
      updatedAt: deps.now(),
    })
    .where(eq(t.id, edit.id));
  await run.progress(1, out.options.length ? `${out.options.length} suggestion${out.options.length === 1 ? '' : 's'} ready` : 'No suggestions passed our checks');
}
