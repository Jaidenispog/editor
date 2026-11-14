import { and, eq, inArray } from 'drizzle-orm';
import { CancelledError, NonRetryableError, WebsiteChangeSchema, isInScope, siteScopeFrom, type ApplyResult, type JobPayload } from '@studio/core';
import { approvalDestination, approvalHash } from '@studio/core/website-approval';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { loadConnection, recordConnectionCheck } from '../lib/connections.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { loadSettings } from '../lib/plan-context.js';
import { TransientAdapterError } from '../website/adapters/types.js';
import { AdapterRedirectError, WordPressAdapter } from '../website/adapters/wordpress.js';
import { applyChange } from '../website/apply.js';
import { defaultWebsiteDeps, type WebsiteDeps } from '../website/deps.js';
import { WebsiteFetcher, followRedirects } from '../website/fetcher.js';
import { createGuardedFetch } from '../website/guarded-fetch.js';
import { BlockedHostError, resolveSafeAddress, systemResolver } from '../website/ssrf.js';

/** Plain message when the editing connection is not usable. */
export const CONNECTION_NEEDS_ATTENTION = 'Your website editing connection needs attention. Check it in Settings → Integrations.';

/** Plain message when the change or its destination is no longer what the owner approved. */
export const APPROVAL_NO_LONGER_MATCHES =
  'The change or the WordPress site it goes to changed after you approved it, so nothing was changed. Check the change and apply it again.';

/**
 * The HTTP context for WordPress calls: the SSRF-guarded, address-pinned transport (no redirects followed), unless a
 * test injected its own fake `fetch`.
 */
export function wordPressContext(ctx: WorkerContext, deps: Pick<WebsiteDeps, 'fetchPolicy'>): Pick<WorkerContext, 'fetch' | 'logger'> {
  return { logger: ctx.logger, fetch: ctx.fetch ?? createGuardedFetch(deps.fetchPolicy) };
}

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
  // The durable "a write was sent" record (design §7.4.1): kept across retries and failures whose outcome is unknown,
  // so a later attempt can tell a write that landed from one that never did. It belongs to one change (changeHash):
  // applyChange ignores it for any other wording, and it is dropped when WordPress definitely refused the write.
  const stored = edit.applyResult;
  let marker: Pick<ApplyResult, 'writeSentAt' | 'preWriteHash' | 'changeHash' | 'resourceId' | 'resourceType'> | null =
    stored.writeSentAt && stored.preWriteHash && stored.changeHash && stored.resourceId
      ? {
          writeSentAt: stored.writeSentAt,
          preWriteHash: stored.preWriteHash,
          changeHash: stored.changeHash,
          resourceId: stored.resourceId,
          ...(stored.resourceType ? { resourceType: stored.resourceType } : {}),
        }
      : null;
  // What the owner approved (kept on the row across retries of this job; a failure ends the approval).
  const approved = stored.approvalHash ?? null;
  const fail = async (outcome: NonNullable<ApplyResult['outcome']>, message: string, extra: Partial<ApplyResult> = {}) => {
    await ctx.db
      .update(t)
      .set({
        status: 'apply_failed',
        statusReason: outcome,
        statusMessage: message,
        applyResult: { adapter: 'wordpress', outcome, message, ...extra, ...(marker ?? {}) },
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
  // The approval covers the change and the destination the dialog showed: a WordPress connection saved again for
  // another site (or relabelled live/staging), or a change whose text moved on, is never written on that approval.
  const destination = approvalDestination(conn);
  if (!approved || !destination || approvalHash(change.data, destination) !== approved) {
    await fail('error', APPROVAL_NO_LONGER_MATCHES);
    throw new NonRetryableError('VALIDATION', APPROVAL_NO_LONGER_MATCHES);
  }
  // The same address guard as the read-only check, here too: the address (or its DNS) may have changed since.
  try {
    await resolveSafeAddress(new URL(baseUrl).hostname, deps.fetchPolicy, deps.fetchPolicy.resolver ?? systemResolver);
  } catch (err) {
    const message = err instanceof BlockedHostError && err.reason === 'unresolvable' ? `The WordPress address could not be found, so nothing was changed.` : 'The WordPress address points to a private or reserved address, so nothing was changed.';
    await fail('error', message);
    throw new NonRetryableError('VALIDATION', message);
  }
  const settings = await loadSettings(ctx);
  const adapter = new WordPressAdapter(wordPressContext(ctx, deps), {
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
    const attempt = await applyChange(adapter, change.data, run.signal, readPublic, {
      prior:
        marker?.preWriteHash && marker.changeHash && marker.resourceId
          ? { resourceId: marker.resourceId, preWriteHash: marker.preWriteHash, changeHash: marker.changeHash }
          : null,
      beforeWrite: async (target, preWriteHash, changeHash) => {
        const next = { writeSentAt: deps.now().toISOString(), preWriteHash, changeHash, resourceId: target.resourceId, resourceType: target.resourceType };
        // Only while this attempt still holds the change: a row moved on meanwhile is never written. The approval
        // stays with the marker, so a retry of this job still knows what was approved.
        const rows = await ctx.db
          .update(t)
          .set({ applyResult: { adapter: 'wordpress', ...next, approvalHash: approved }, updatedAt: deps.now() })
          .where(and(eq(t.id, edit.id), eq(t.status, 'applying')))
          .returning({ id: t.id });
        if (rows.length) marker = next;
        return rows.length > 0;
      },
    });
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
        attempt.outcome === 'already_applied' && !attempt.earlierWrite
          ? 'Your website already shows this, so nothing needed changing.'
          : verification === 'confirmed_public'
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
            earlierWrite: attempt.earlierWrite,
            kind: change.data.kind,
            pageUrl: change.data.pageUrl,
            // writeWorkerAudit trims every string to 200 characters (design §10.6).
            before: 'before' in change.data ? change.data.before : null,
            after: change.data.after,
          },
        },
        ctx.logger,
      );
      await run.progress(1, attempt.outcome === 'applied' ? 'Change applied' : 'Change was already applied');
      return;
    }
    // WordPress definitely refused the write (401, 403, 404): nothing landed, so no later attempt may treat the page as
    // "written by us" (the record would otherwise outlive the refusal and turn a later page edit into a conflict).
    if (attempt.writeRefused) marker = null;
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
    if (err instanceof AdapterRedirectError) {
      await fail('error', err.message);
      throw new NonRetryableError('PROCESSING_FAILED', err.message);
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
