import { eq } from 'drizzle-orm';
import { CancelledError, formatDateTime, instagramPollDelaySeconds, manualStepMessage, methodVariantRefusal, validatePostLink, type TargetStatus } from '@studio/core';
import { schema, type PublishProviderState } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import { recordConnectionCheck } from '../lib/connections.js';
import { enqueueTracked } from '../lib/jobs.js';
import { JobInterruptedError, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { MetaGraphClient } from '../lib/meta/graph.js';
import { mapGraphError, type MappedGraphError } from './errors.js';
import { liveEligibility, markPublishedByPlatform, refreshPostStatus, toManualStep, updateTarget, type PostRow, type TargetRow } from './post-status.js';

/**
 * Instagram direct publishing (`method = instagram_api`), design §7.1.4: container → resumable upload → poll
 * `status_code` → `copyright_check_status` (never publish on a match) → `media_publish` → read back the permalink.
 * Every step is safe to repeat: the container id is saved before the upload, `submitted_at` is set just before
 * `media_publish`, and a retry reads the container's status before doing anything (PUBLISHED is never published
 * again).
 */

/** How long to wait before trying again when the daily posting limit is reached. */
export const QUOTA_RETRY_MINUTES = 60;

/** The account, connection and a client for one target, or the manual step it needs instead. */
type Prepared = { ok: true; client: MetaGraphClient; igUserId: string; account: typeof schema.socialAccounts.$inferSelect } | { ok: false };

const ACTIVE: readonly TargetStatus[] = ['processing'];

function graphLog(state: PublishProviderState, err: unknown, mapped: MappedGraphError): PublishProviderState['graphErrors'] {
  const g = err as { code?: number | null; subcode?: number | null };
  const list = [...(state.graphErrors ?? []), { code: g.code ?? null, subcode: g.subcode ?? null, message: mapped.message.slice(0, 300), at: new Date().toISOString() }];
  return list.slice(-5);
}

/** Loads the account and the decrypted `meta` credential; moves the target to "reconnect" when either is unusable. */
async function prepare(ctx: WorkerContext, run: TrackedRun, target: TargetRow): Promise<Prepared> {
  const account = target.accountId ? await ctx.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, target.accountId) }) : null;
  const conn = account?.connectionId ? await ctx.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, account.connectionId) }) : null;
  const token = conn?.status === 'connected' ? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted) : null;
  if (!account || account.status !== 'connected' || !token) {
    await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', manualStepMessage('reconnect_account', 'instagram'));
    await refreshPostStatus(ctx.db, target.postId);
    return { ok: false };
  }
  return { ok: true, client: new MetaGraphClient(ctx, ctx.env, token, run.signal), igUserId: account.externalId, account };
}

/**
 * Applies a mapped Graph failure to the target (and to the account and connection for token or permission
 * problems). Transient failures are rethrown so pg-boss retries with backoff.
 */
async function applyGraphFailure(ctx: WorkerContext, run: TrackedRun, target: TargetRow, err: unknown, account: typeof schema.socialAccounts.$inferSelect | null): Promise<void> {
  const mapped = mapGraphError(err);
  const graphErrors = graphLog(target.providerState, err, mapped);
  switch (mapped.kind) {
    case 'transient':
    case 'not_ready':
      if (run.willRetry) {
        await updateTarget(ctx.db, target.id, ACTIVE, { providerState: { graphErrors }, statusMessage: 'Instagram had a temporary problem; trying again shortly.' });
      } else {
        // Last attempt: settle the target so it never stays "processing"; Retry reads the container status first.
        await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: mapped.message.slice(0, 500), error: mapped.message.slice(0, 500), providerState: { graphErrors, retryable: true } });
        await refreshPostStatus(ctx.db, target.postId);
      }
      throw err;
    case 'quota':
      await requeueForQuota(ctx, target, null);
      return;
    case 'reauth':
      if (account) await ctx.db.update(schema.socialAccounts).set({ status: 'needs_reauth', lastError: mapped.message.slice(0, 500), updatedAt: new Date() }).where(eq(schema.socialAccounts.id, account.id));
      await recordConnectionCheck(ctx.db, 'meta', { status: 'needs_reauth', lastError: 'Instagram needs reconnecting: the access token is no longer valid.' });
      await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', manualStepMessage('reconnect_account', 'instagram'), { providerState: { graphErrors }, error: mapped.message.slice(0, 500) });
      break;
    case 'permission':
    case 'discovery':
      await recordConnectionCheck(ctx.db, 'meta', { status: 'error', lastError: mapped.message });
      await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: mapped.message.slice(0, 500), error: mapped.message.slice(0, 500), providerState: { graphErrors, retryable: false } });
      await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.failed', entityType: 'publish_target', entityId: target.id, data: { platform: 'instagram', reason: mapped.kind } }, ctx.logger);
      break;
    default:
      await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: mapped.message.slice(0, 500), error: mapped.message.slice(0, 500), providerState: { graphErrors, retryable: mapped.retryable } });
      await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.failed', entityType: 'publish_target', entityId: target.id, data: { platform: 'instagram', reason: mapped.kind } }, ctx.logger);
  }
  await refreshPostStatus(ctx.db, target.postId);
}

/** Back to queued with a plain message, and a new attempt in an hour (the container, if any, is kept). */
async function requeueForQuota(ctx: WorkerContext, target: TargetRow, quota: { usage: number; total: number } | null): Promise<void> {
  const at = new Date(Date.now() + QUOTA_RETRY_MINUTES * 60_000);
  const when = formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' });
  await updateTarget(ctx.db, target.id, ACTIVE, {
    status: 'queued',
    statusMessage: `Instagram's daily posting limit is reached; trying again at ${when}.`,
    providerState: { nextAttemptAt: at.toISOString(), ...(quota ? { quota } : {}) },
  });
  await enqueueTracked(ctx, 'publish.target', { targetId: target.id, postId: target.postId, projectId: (await projectOf(ctx, target.postId)) ?? null }, { singletonKey: `publish-target:${target.id}`, startAfter: at });
  await refreshPostStatus(ctx.db, target.postId);
}

async function projectOf(ctx: WorkerContext, postId: string): Promise<string | null> {
  const p = await ctx.db.query.publishPosts.findFirst({ columns: { projectId: true }, where: eq(schema.publishPosts.id, postId) });
  return p?.projectId ?? null;
}

/** Schedules the next status read of the target's container. */
async function schedulePoll(ctx: WorkerContext, target: TargetRow, pollNo: number, delaySec: number): Promise<void> {
  await enqueueTracked(
    ctx,
    'publish.poll',
    { targetId: target.id, postId: target.postId, projectId: await projectOf(ctx, target.postId), pollNo },
    { singletonKey: `publish-poll:${target.id}`, startAfter: new Date(Date.now() + delaySec * 1000) },
  );
}

/**
 * Runs a claimed Instagram target from wherever it stopped. `post` is the target's post; the caller has already
 * set the target to `processing`.
 */
export async function runInstagramTarget(ctx: WorkerContext, run: TrackedRun, target: TargetRow, post: PostRow): Promise<void> {
  const prepared = await prepare(ctx, run, target);
  if (!prepared.ok) return;
  const { client, igUserId, account } = prepared;
  const verified = Boolean(account.capabilities['verifiedDirectAt']);
  if (!target.isVerification && (!verified || !account.directPublishEnabled)) {
    await updateTarget(ctx.db, target.id, ACTIVE, {
      status: 'failed',
      statusMessage: verified ? 'Direct publishing is switched off in Settings → Integrations. Post it yourself, or switch it on and retry.' : 'Direct publishing is not switched on. Make a first verification post, or post it yourself.',
      providerState: { retryable: verified },
    });
    await refreshPostStatus(ctx.db, target.postId);
    return;
  }
  if (!target.mediaKey) {
    await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: "The video file isn't ready. Press Retry to prepare it again.", providerState: { retryable: true } });
    await refreshPostStatus(ctx.db, target.postId);
    return;
  }

  try {
    let state = target.providerState;
    let containerId = target.externalContainerId;
    if (containerId) {
      const status = await client.containerStatus(containerId);
      run.checkCancelled();
      if (status.statusCode === 'PUBLISHED') return await readBack(ctx, client, igUserId, target, post);
      if (status.statusCode === 'FINISHED') {
        if (isResuming(target)) return await publishNow(ctx, client, igUserId, target, post);
        return await continueAfterProcessing(ctx, client, target, 0);
      }
      if (status.statusCode === 'IN_PROGRESS' && state.uploadDone) {
        await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Instagram is processing the video', providerState: { statusCode: status.statusCode } });
        return await schedulePoll(ctx, target, 0, 60);
      }
      if (status.statusCode === 'EXPIRED' || status.statusCode === 'ERROR') {
        // Nothing was published from this container, so a new one is safe.
        containerId = null;
        state = { ...state, uploadDone: false };
        await updateTarget(ctx.db, target.id, ACTIVE, { externalContainerId: null, providerState: { uploadDone: false, statusCode: status.statusCode } });
      }
    }

    // Before anything new goes to Instagram: the licence as it is now must still allow this file.
    if (!target.submittedAt) {
      const live = await liveEligibility(ctx.db, post.editVersionId, ['instagram']);
      const e = live?.eligibility.perPlatform[0];
      const refusal = !e ? 'This version no longer exists.' : methodVariantRefusal(e, 'instagram_api', target.mediaVariant);
      if (refusal) {
        await toManualStep(ctx.db, target.id, ACTIVE, 'music_licence_changed', manualStepMessage('music_licence_changed', 'instagram'), { error: refusal.slice(0, 500) });
        await refreshPostStatus(ctx.db, target.postId);
        return;
      }
    }

    if (!containerId) {
      const quota = await client.publishingLimit(igUserId);
      if (quota.total !== null && quota.usage >= quota.total) return await requeueForQuota(ctx, target, { usage: quota.usage, total: quota.total });
      await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Uploading to Instagram…', ...(quota.total !== null ? { providerState: { quota: { usage: quota.usage, total: quota.total } } } : {}) });
      containerId = await client.createReelContainer(igUserId, { caption: post.caption, thumbOffsetMs: post.coverTimeSec !== null ? post.coverTimeSec * 1000 : null });
      // Saved before anything else, so a retry finds this container instead of making a second one.
      await updateTarget(ctx.db, target.id, ACTIVE, { externalContainerId: containerId, providerState: { uploadDone: false, containerCreatedAt: new Date().toISOString(), statusCode: 'IN_PROGRESS' } });
      state = { ...state, uploadDone: false };
    }

    if (!state.uploadDone) {
      const stat = await ctx.store.stat(target.mediaKey);
      if (!stat) {
        await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: 'The video file is missing from storage. Press Retry to prepare it again.', mediaKey: null, providerState: { retryable: true } });
        await refreshPostStatus(ctx.db, target.postId);
        return;
      }
      await run.progress(0.3, 'Uploading to Instagram…');
      const stream = await ctx.store.getStream(target.mediaKey);
      await client.uploadResumable(containerId, stream, stat.size);
      run.checkCancelled();
      await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Instagram is processing the video', providerState: { uploadDone: true } });
    }
    await schedulePoll(ctx, { ...target, externalContainerId: containerId }, 0, 60);
  } catch (err) {
    const fresh = (await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, target.id) })) ?? target;
    if (err instanceof CancelledError || err instanceof JobInterruptedError) return await settleStopped(ctx, run, fresh, err);
    await applyGraphFailure(ctx, run, fresh, err, account);
  }
}

/** True while the target waits for (or is in) the publish step after a clean copyright check. */
function isResuming(target: TargetRow): boolean {
  const r = target.providerState['resume'];
  return r === 'publish' || r === 'publishing';
}

/**
 * The run was stopped (owner cancel, worker shutdown, time limit). A target the queue will run again stays
 * `processing` (the same job re-claims it); otherwise it fails with Retry offered. Nothing already sent is undone.
 */
async function settleStopped(ctx: WorkerContext, run: TrackedRun, target: TargetRow, err: unknown): Promise<void> {
  const outcome = await stopOutcome(run);
  if (outcome !== 'resume') {
    await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: 'Stopped before Instagram confirmed the post. Press Retry: it checks Instagram first, so nothing is posted twice.', providerState: { retryable: true } });
    await refreshPostStatus(ctx.db, target.postId);
  }
  throw err;
}

/** After the container finished processing: the copyright check decides whether publishing may go ahead. */
async function continueAfterProcessing(ctx: WorkerContext, client: MetaGraphClient, target: TargetRow, pollNo: number): Promise<void> {
  const copyright = await client.copyrightStatus(target.externalContainerId ?? '');
  await updateTarget(ctx.db, target.id, ACTIVE, { providerState: { statusCode: 'FINISHED', copyright: { status: copyright.status, matchesFound: copyright.matchesFound } } });
  if (copyright.matchesFound === true) {
    // Memo §4 / Follow-up 5: never publish on a match.
    await toManualStep(ctx.db, target.id, ACTIVE, 'review_copyright_match', manualStepMessage('review_copyright_match', 'instagram'));
    await refreshPostStatus(ctx.db, target.postId);
    return;
  }
  if (copyright.matchesFound === null || copyright.status === 'in_progress' || copyright.status === 'not_started') {
    await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Instagram is checking the music' });
    const age = containerAgeSec(target);
    const delay = instagramPollDelaySeconds(pollNo, age);
    if (delay === null) return await expire(ctx, target);
    return await schedulePoll(ctx, target, pollNo + 1, delay);
  }
  // No match: publish.target resumes at the publish step (the flag lets exactly one job claim the processing target).
  await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Publishing to Instagram…', providerState: { resume: 'publish' } });
  await enqueueTracked(ctx, 'publish.target', { targetId: target.id, postId: target.postId, projectId: await projectOf(ctx, target.postId) }, { singletonKey: `publish-target:${target.id}` });
}

function containerAgeSec(target: TargetRow): number {
  const created = typeof target.providerState['containerCreatedAt'] === 'string' ? Date.parse(target.providerState['containerCreatedAt']) : NaN;
  return Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 1000) : 0;
}

async function expire(ctx: WorkerContext, target: TargetRow): Promise<void> {
  await updateTarget(ctx.db, target.id, ACTIVE, { status: 'failed', statusMessage: "Instagram's upload expired. Retry to upload again.", providerState: { retryable: true } });
  await refreshPostStatus(ctx.db, target.postId);
}

/** The one non-repeatable call: `submitted_at` first, then `media_publish`, then the read-back. */
async function publishNow(ctx: WorkerContext, client: MetaGraphClient, igUserId: string, target: TargetRow, post: PostRow): Promise<void> {
  const containerId = target.externalContainerId ?? '';
  const marked = await updateTarget(ctx.db, target.id, ACTIVE, { submittedAt: new Date(), statusMessage: 'Publishing to Instagram…', providerState: { resume: null } });
  if (!marked) return;
  await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.submitted', entityType: 'publish_target', entityId: target.id, data: { platform: 'instagram', method: 'instagram_api', variant: target.mediaVariant } }, ctx.logger);
  const mediaId = await client.publishContainer(igUserId, containerId);
  const saved = await updateTarget(ctx.db, target.id, ACTIVE, { externalPostId: mediaId, publishedAt: new Date() });
  await readBack(ctx, client, igUserId, saved ?? { ...marked, externalPostId: mediaId }, post);
}

/** Step 8: the permalink of the published reel, recovering the media id when only the container's PUBLISHED status is known. */
async function readBack(ctx: WorkerContext, client: MetaGraphClient, igUserId: string, target: TargetRow, post: PostRow): Promise<void> {
  let mediaId = target.externalPostId;
  let permalink: string | null = null;
  if (mediaId) {
    permalink = await client.permalink(mediaId);
  } else {
    const since = (target.submittedAt?.getTime() ?? target.createdAt.getTime()) - 60_000;
    const recent = await client.recentMedia(igUserId);
    const match = recent
      .filter((m) => (m.timestamp ? Date.parse(m.timestamp) >= since : false) && (m.caption ?? '') === post.caption)
      .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''))[0];
    if (match) {
      mediaId = match.id;
      permalink = match.permalink;
    }
  }
  const url = permalink ? validatePostLink('instagram', permalink) : null;
  const message = url
    ? `Published ${formatDateTime(new Date(), { dateStyle: undefined, timeStyle: 'short' })}`
    : 'Instagram reports this reel was published. Open Instagram to see it, or paste the link.';
  await markPublishedByPlatform(ctx.db, target, { externalPostId: mediaId, publishedUrl: url, message });
}

/** `publish.poll` for an Instagram target: reads the container until it settles. */
export async function runInstagramPoll(ctx: WorkerContext, run: TrackedRun, target: TargetRow, post: PostRow, pollNo: number): Promise<void> {
  if (target.status !== 'processing' || !target.externalContainerId) return;
  if (isResuming(target)) return;
  const prepared = await prepare(ctx, run, target);
  if (!prepared.ok) return;
  try {
    const status = await prepared.client.containerStatus(target.externalContainerId);
    await updateTarget(ctx.db, target.id, ACTIVE, { providerState: { statusCode: status.statusCode, lastPollNo: pollNo } });
    switch (status.statusCode) {
      case 'FINISHED':
        return await continueAfterProcessing(ctx, prepared.client, target, pollNo);
      case 'PUBLISHED':
        return await readBack(ctx, prepared.client, prepared.igUserId, target, post);
      case 'ERROR':
        await updateTarget(ctx.db, target.id, ACTIVE, {
          status: 'failed',
          statusMessage: `Instagram couldn't process the video.${status.status ? ` Instagram said: ${status.status}` : ''}`.slice(0, 500),
          error: status.status.slice(0, 500) || null,
          providerState: { retryable: true },
        });
        await refreshPostStatus(ctx.db, target.postId);
        return;
      case 'EXPIRED':
        return await expire(ctx, target);
      default: {
        await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Instagram is processing the video' });
        const delay = instagramPollDelaySeconds(pollNo, containerAgeSec(target));
        if (delay === null) return await expire(ctx, target);
        return await schedulePoll(ctx, target, pollNo + 1, delay);
      }
    }
  } catch (err) {
    if (err instanceof CancelledError || err instanceof JobInterruptedError) throw err;
    const mapped = mapGraphError(err);
    if (mapped.kind === 'not_ready') {
      const delay = instagramPollDelaySeconds(pollNo, containerAgeSec(target));
      if (delay === null) return await expire(ctx, target);
      return await schedulePoll(ctx, target, pollNo + 1, delay);
    }
    await applyGraphFailure(ctx, run, target, err, prepared.account);
  }
}
