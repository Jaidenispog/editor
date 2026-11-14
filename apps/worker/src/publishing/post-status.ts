import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  checkPublishEligibility,
  derivePostStatus,
  musicClearanceFor,
  newId,
  normaliseLicence,
  postStatusMessage,
  type ManualStep,
  type PublishEligibility,
  type TargetPlatform,
  type TargetStatus,
} from '@studio/core';
import { schema, type Database, type PublishProviderState } from '@studio/db';
import { writeWorkerAudit } from '../lib/audit.js';
import { recordFeedback } from '../lib/feedback.js';

/** One `publish_targets` row. */
export type TargetRow = typeof schema.publishTargets.$inferSelect;
/** One `publish_posts` row. */
export type PostRow = typeof schema.publishPosts.$inferSelect;
type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Derives `publish_posts.status` (and its one-line message) from the post's targets and writes it. Called after
 * every target transition. Drafts stay drafts; a failed target never undoes a published one.
 */
export async function refreshPostStatus(db: Db, postId: string): Promise<string | null> {
  const post = await db.query.publishPosts.findFirst({ columns: { id: true, approvedAt: true }, where: eq(schema.publishPosts.id, postId) });
  if (!post) return null;
  const targets = await db.select({ status: schema.publishTargets.status }).from(schema.publishTargets).where(eq(schema.publishTargets.postId, postId));
  const status = derivePostStatus(Boolean(post.approvedAt), targets as Array<{ status: TargetStatus }>);
  await db
    .update(schema.publishPosts)
    .set({ status, statusMessage: postStatusMessage(status, targets as Array<{ status: TargetStatus }>), updatedAt: new Date() })
    .where(eq(schema.publishPosts.id, postId));
  return status;
}

/** Fields a transition may change. */
export type TargetPatch = Partial<Omit<typeof schema.publishTargets.$inferInsert, 'id' | 'postId' | 'providerState'>> & { providerState?: Partial<PublishProviderState> };

/**
 * Updates a target only while it is still in one of `from` (the conditional update that makes every transition
 * safe against a second worker). `providerState` is merged, never replaced. Returns the updated row or null.
 */
export async function updateTarget(db: Db, targetId: string, from: readonly TargetStatus[], patch: TargetPatch): Promise<TargetRow | null> {
  const { providerState, ...rest } = patch;
  const rows = await db
    .update(schema.publishTargets)
    .set({
      ...rest,
      ...(providerState ? { providerState: sql`${schema.publishTargets.providerState} || ${JSON.stringify(providerState)}::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.publishTargets.id, targetId), inArray(schema.publishTargets.status, [...from])))
    .returning();
  return rows[0] ?? null;
}

/** Moves a target to "your turn" with the step's plain message. */
export async function toManualStep(db: Db, targetId: string, from: readonly TargetStatus[], step: ManualStep, message: string, extra: TargetPatch = {}): Promise<TargetRow | null> {
  return updateTarget(db, targetId, from, { ...extra, status: 'manual_step_required', manualStep: step, statusMessage: message });
}

/** The version's music facts and the live publish eligibility of its platforms (the worker's pre-publish re-check). */
export async function liveEligibility(db: Db, editVersionId: string, platforms: TargetPlatform[]): Promise<{ eligibility: PublishEligibility; plan: typeof schema.editVersions.$inferSelect['plan']; trackId: string | null } | null> {
  const version = await db.query.editVersions.findFirst({ columns: { plan: true }, where: eq(schema.editVersions.id, editVersionId) });
  if (!version?.plan) return null;
  const music = version.plan.audio.music;
  const track = music ? await db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, music.trackId) }) : null;
  const licence = track && !track.deletedAt ? track.licence : null;
  const eligibility = checkPublishEligibility({ hasMusic: Boolean(music), licence, originalSoundEnabled: version.plan.audio.originalSound.enabled, platforms });
  return { eligibility, plan: version.plan, trackId: track && !track.deletedAt ? track.id : null };
}

/**
 * What happens when a target is confirmed published (platform read-back or the owner's "I've posted it"), in one
 * transaction: a `publish` feedback event with the plan's facts (once per version and platform) and, for a file with
 * music, one `music_usage` row (`purpose 'publish'`, the platform, the licence as it is now). Never at approval.
 */
export async function recordPublishedEffects(db: Database, target: Pick<TargetRow, 'id' | 'platform' | 'method' | 'mediaVariant'>, post: Pick<PostRow, 'id' | 'editVersionId' | 'projectId'>, userId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const version = await tx.query.editVersions.findFirst({ columns: { id: true, editId: true, plan: true }, where: eq(schema.editVersions.id, post.editVersionId) });
    if (!version) return;
    const edit = await tx.query.edits.findFirst({ columns: { id: true, styleId: true }, where: eq(schema.edits.id, version.editId) });
    const existing = await tx
      .select({ id: schema.feedbackEvents.id })
      .from(schema.feedbackEvents)
      .where(and(eq(schema.feedbackEvents.editVersionId, version.id), eq(schema.feedbackEvents.type, 'publish'), sql`${schema.feedbackEvents.data}->>'platform' = ${target.platform}`))
      .limit(1);
    if (existing.length === 0) {
      await recordFeedback(tx, {
        type: 'publish',
        userId,
        projectId: post.projectId,
        editId: edit?.id ?? version.editId,
        editVersionId: version.id,
        styleId: edit?.styleId ?? null,
        plan: version.plan,
        data: { platform: target.platform, method: target.method, variant: target.mediaVariant, postId: post.id },
      });
    }
    const music = version.plan?.audio.music;
    if (target.mediaVariant === 'standard' && music) {
      const track = await tx.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, music.trackId) });
      if (track) {
        await tx
          .insert(schema.musicUsage)
          .values({
            id: newId(),
            trackId: track.id,
            editVersionId: version.id,
            purpose: 'publish',
            platform: target.platform,
            licenceSnapshot: normaliseLicence(track.licence),
            clearance: musicClearanceFor(track.deletedAt ? null : track.licence),
            createdBy: userId,
          })
          .onConflictDoNothing();
      }
    }
  });
}

/** Marks a target published by the platform's read-back (worker side), with its audit entry and effects. */
export async function markPublishedByPlatform(
  db: Database,
  target: TargetRow,
  values: { externalPostId: string | null; publishedUrl: string | null; message: string },
): Promise<TargetRow | null> {
  const now = new Date();
  const updated = await updateTarget(db, target.id, ['processing', 'queued'], {
    status: 'published',
    manualStep: null,
    externalPostId: values.externalPostId ?? target.externalPostId,
    publishedUrl: values.publishedUrl,
    publishedAt: target.publishedAt ?? now,
    statusMessage: values.message,
    error: null,
  });
  if (!updated) return null;
  const post = await db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, target.postId) });
  await writeWorkerAudit(db, { userId: null, action: 'publish.target.published', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform, method: target.method, variant: target.mediaVariant, postId: target.postId } });
  if (post) await recordPublishedEffects(db, updated, post, post.approvedBy);
  await refreshPostStatus(db, target.postId);
  return updated;
}
