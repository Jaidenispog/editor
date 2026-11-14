import { and, eq, inArray } from 'drizzle-orm';
import { CancelledError, NonRetryableError, WebsiteChangeSchema, isInScope, siteScopeFrom, type ApplyResult, type JobPayload } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { loadConnection, recordConnectionCheck } from '../lib/connections.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { loadSettings } from '../lib/plan-context.js';
import { TransientAdapterError } from '../website/adapters/types.js';
import { WordPressAdapter } from '../website/adapters/wordpress.js';
import { applyChange } from '../website/apply.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';
import { WebsiteFetcher, followRedirects } from '../website/fetcher.js';

/** Plain message when the editing connection is not usable. */
export const CONNECTION_NEEDS_ATTENTION = 'Your website editing connection needs attention. Check it in Settings → Integrations.';

/** Splits the stored `username:applicationPassword` credential. */
export function splitWordPressCredential(plain: string): { username: string; applicationPassword: string } | null {
  const idx = plain.indexOf(':');
  if (idx <= 0) return null;
  return {
    username: plain.slice(0, idx),
    applicationPassword: plain.slice(idx + 1),
  };
}

/**
 * `website.edit_apply` (design §7.4, §8): applies one change the owner approved. Claims `approved → applying` (or a
 * stale `applying` on a retry), never runs without `approved_by`, applies through WordPress with the exact-once rule,
 * reads the page back, and records the outcome. A retry after a write that already landed reports `already_applied`.
 */
export async function handleWebsiteEditApply(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: JobPayload<'website.edit_apply'>,
  deps: WebsiteDeps = defaultWebsiteDeps(ctx),
): Promise<void> {
  const t = schema.websiteEdits;
  const claimed = await ctx.db
    .update(t)
    .set({
      status: 'applying',
      statusMessage: 'Applying…',
      updatedAt: deps.now(),
    })
    .where(and(eq(t.id, payload.editId), inArray(t.status, ['approved', 'applying'])))
    .returning();
  const edit = claimed[0];
  if (!edit) {
    await run.message('This change is not waiting to be applied');
    return;
  }
  const fail = async (outcome: NonNullable<ApplyResult['outcome']>, message: string, extra: Partial<ApplyResult> = {}) => {
    await ctx.db
      .update(t)
      .set({
        status: 'apply_failed',
        statusReason: outcome,
        statusMessage: message,
        applyResult: { adapter: 'wordpress', outcome, message, ...extra },
        updatedAt: deps.now(),
      })
      .where(eq(t.id, edit.id));
    await writeWorkerAudit(
      ctx.db,
      {
        userId: edit.approvedBy,
        action: 'website.edit.apply_failed',
        entityType: 'website_edit',
        entityId: edit.id,
        data: {
          outcome,
          kind: (edit.proposedChange as { kind?: string }).kind ?? null,
          pageUrl: edit.pageUrl,
        },
      },
      ctx.logger,
    );
  };
  if (!edit.approvedBy || !edit.approvedAt) {
    await fail('error', 'This change was not approved, so nothing was changed.');
    throw new NonRetryableError('VALIDATION', 'The change was not approved by the owner.');
  }
  const change = WebsiteChangeSchema.safeParse(edit.proposedChange);
  if (!change.success) {
    await fail('error', 'This change could not be read, so nothing was changed.');
    throw new NonRetryableError('VALIDATION', 'The stored change could not be read.');
  }
  const conn = await loadConnection(ctx.db, 'website');
  const plain = conn && conn.status === 'connected' ? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted) : null;
  const cred = plain ? splitWordPressCredential(plain) : null;
  const baseUrl = typeof conn?.config['baseUrl'] === 'string' ? conn.config['baseUrl'] : null;
  if (!conn || !cred || !baseUrl) {
    await fail('auth', CONNECTION_NEEDS_ATTENTION);
    throw new NonRetryableError('INTEGRATION_NOT_CONFIGURED', CONNECTION_NEEDS_ATTENTION);
  }
  const settings = await loadSettings(ctx);
  const adapter = new WordPressAdapter(ctx, {
    baseUrl,
    ...cred,
    publicWebsite: settings.business.website,
  });
  const scope = siteScopeFrom(settings.business.website);
  const readPublic = async (url: string): Promise<string | null> => {
    if (!scope || !isInScope(url, scope)) return null;
    const fetcher = new WebsiteFetcher(deps.fetchPolicy, [scope.host, scope.twinHost], deps.crawlerClock?.now, deps.crawlerClock?.sleep);
    const res = await followRedirects(fetcher, url, {
      method: 'GET',
      maxBytes: 5 * 1024 * 1024,
      signal: run.signal,
      allowHop: (u) => isInScope(u, scope),
    });
    return res.final.status !== null && res.final.status < 300 && res.final.body ? res.final.body.toString('utf8') : null;
  };
  try {
    await run.progress(0.2, 'Applying the change through WordPress…');
    const attempt = await applyChange(adapter, change.data, run.signal, readPublic);
    const now = deps.now();
    const resultBase: ApplyResult = {
      adapter: 'wordpress',
      ...(attempt.target
        ? {
            resourceType: attempt.target.resourceType,
            resourceId: attempt.target.resourceId,
          }
        : {}),
      outcome: attempt.outcome,
      message: attempt.message.slice(0, 500),
      revisionNote: 'WordPress keeps the previous version in the page’s revisions.',
    };
    if (attempt.outcome === 'applied' || attempt.outcome === 'already_applied') {
      const verification = attempt.verification ?? 'confirmed_api';
      const message =
        verification === 'confirmed_public'
          ? 'Changed on your website. Confirmed through WordPress and visible on the public page.'
          : 'Changed on your website. Confirmed through WordPress; not visible on the public page yet (your site may cache pages for a while).';
      await ctx.db
        .update(t)
        .set({
          status: 'applied',
          appliedVia: 'wordpress',
          appliedAt: now,
          statusReason: null,
          statusMessage: message,
          applyResult: {
            ...resultBase,
            verification,
            verifiedAt: now.toISOString(),
          },
          updatedAt: now,
        })
        .where(eq(t.id, edit.id));
      await writeWorkerAudit(
        ctx.db,
        {
          userId: edit.approvedBy,
          action: 'website.edit.applied',
          entityType: 'website_edit',
          entityId: edit.id,
          data: {
            outcome: attempt.outcome,
            kind: change.data.kind,
            pageUrl: change.data.pageUrl,
            before: 'before' in change.data ? change.data.before : null,
            after: change.data.after,
          },
        },
        ctx.logger,
      );
      await run.progress(1, attempt.outcome === 'applied' ? 'Change applied' : 'Change was already applied');
      return;
    }
    if (attempt.outcome === 'auth')
      await recordConnectionCheck(ctx.db, 'website', {
        status: 'needs_reauth',
        lastError: attempt.message,
      });
    await fail(attempt.outcome, attempt.message, {
      ...resultBase,
      verification: attempt.verification ?? undefined,
    });
    await run.progress(1, 'The change was not applied');
  } catch (err) {
    if (err instanceof CancelledError) {
      // Owner cancel or shutdown: the claim is released only if nothing was written yet; a retry re-reads first.
      if (!run.willRetry) await fail('error', 'Applying was stopped. Nothing was changed unless the page shows the new text; check again before retrying.');
      throw err;
    }
    if (err instanceof TransientAdapterError) {
      if (!run.willRetry) {
        await fail('error', err.message);
        throw new NonRetryableError('PROCESSING_FAILED', err.message);
      }
      await ctx.db
        .update(t)
        .set({
          statusMessage: 'Your website didn’t respond; trying again shortly.',
          updatedAt: deps.now(),
        })
        .where(eq(t.id, edit.id));
    } else if (!run.willRetry) {
      await fail('error', 'Something went wrong while applying. Check the page before trying again.');
    }
    throw err;
  }
}
