import 'server-only';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  AppError,
  META_ONLY_FILE_SUFFIX,
  META_ONLY_LABEL,
  STYLES,
  TARGET_PLATFORM_NAMES,
  checkPublishEligibility,
  computeTimeline,
  defaultCoverTimeSec,
  derivePostStatus,
  manualStepMessage,
  melbourneScheduleLabel,
  methodVariantRefusal,
  musicClearanceFor,
  newId,
  normaliseLicence,
  postStatusMessage,
  resolveSchedule,
  targetActionsFor,
  validateCaption,
  validatePostLink,
  type ApprovePublishPostsSchema,
  type CreatePublishPostItem,
  type CreatePublishPosts,
  type MediaVariant,
  type PatchPublishPostSchema,
  type PlatformEligibility,
  type PublishEligibility,
  type PublishTargetInput,
  type ResolveAction,
  type StyleId,
  type TargetPlatform,
  type TargetStatus,
} from '@studio/core';
import { testOnlyBaseUrl } from '@studio/config';
import { schema, type Database, type EditVersion } from '@studio/db';
import { requireOwner } from './api.js';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { encryptToken } from './crypto.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { recordFeedback } from './feedback.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { downloadNameFor, maybeSignedUrl, signedUrlFor } from './media-links.js';
import { getSettings } from './settings.js';
import { getBlobStore } from './storage.js';
import { getAccessibleProject, getAccessibleVersion, projectVisibilityFilter } from './studio-access.js';
import type {
  CandidateVersionDto,
  EligibilityDto,
  EligibilityItemDto,
  MethodOption,
  PublishBadgeDto,
  PublishingConnectionsDto,
  PublishPostDto,
  PublishPostListDto,
  SocialAccountDto,
  TargetDto,
  TargetMediaDto,
} from './shared/publishing-dto.js';

type PostRow = typeof schema.publishPosts.$inferSelect;
type TargetRow = typeof schema.publishTargets.$inferSelect;
type AccountRow = typeof schema.socialAccounts.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Where Meta's sign-in starts and returns (the state cookie is scoped to it). */
export const META_OAUTH_PATH = '/api/integrations/instagram';
/** Settings Meta's Unified Login needs on the server. */
export const META_ENV = ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID'] as const;
/** The code exchange runs once, inline, with this time limit and no retry (codes are single-use). */
export const META_EXCHANGE_TIMEOUT_MS = 10_000;
/** A reconnect warning shows from this many days before the token expires. */
export const TOKEN_WARNING_DAYS = 7;

function styleName(id: string): string {
  return STYLES[id as StyleId]?.name ?? id;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function handleLabel(handle: string, platform: TargetPlatform): string {
  const h = handle.trim().replace(/^@/, '');
  return h ? `@${h}` : `your ${TARGET_PLATFORM_NAMES[platform]} account`;
}

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------

/** A post the user may see: posts follow their project's rule; a post whose project was deleted is the owner's. */
async function getAccessiblePost(postId: string, user: SessionUser): Promise<PostRow> {
  const post = await getDb().query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, postId) });
  const notFound = () => new AppError('NOT_FOUND', 'That post could not be found.');
  if (!post) throw notFound();
  if (post.projectId) await getAccessibleProject(post.projectId, user).catch(() => Promise.reject(notFound()));
  else if (user.role !== 'owner') throw notFound();
  return post;
}

async function getAccessibleTarget(targetId: string, user: SessionUser): Promise<{ target: TargetRow; post: PostRow }> {
  const target = await getDb().query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, targetId) });
  if (!target) throw new AppError('NOT_FOUND', 'That destination could not be found.');
  const post = await getAccessiblePost(target.postId, user);
  return { target, post };
}

// ---------------------------------------------------------------------------------------------
// Eligibility and methods
// ---------------------------------------------------------------------------------------------

/** The live music facts and eligibility of a version for both platforms. */
async function eligibilityFor(db: Database | Tx, version: Pick<EditVersion, 'plan'>): Promise<PublishEligibility> {
  const music = version.plan?.audio.music ?? null;
  const track = music ? await db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, music.trackId) }) : null;
  return checkPublishEligibility({
    hasMusic: Boolean(music),
    licence: track && !track.deletedAt ? track.licence : null,
    originalSoundEnabled: Boolean(version.plan?.audio.originalSound.enabled),
    platforms: ['instagram', 'tiktok'],
  });
}

/** The Instagram account that direct publishing would use (the first connected one), if any. */
async function instagramAccount(db: Database | Tx): Promise<AccountRow | null> {
  const rows = await db
    .select()
    .from(schema.socialAccounts)
    .where(and(eq(schema.socialAccounts.platform, 'instagram'), eq(schema.socialAccounts.provider, 'meta_graph')))
    .orderBy(desc(schema.socialAccounts.updatedAt));
  return rows.find((r) => r.status === 'connected') ?? rows[0] ?? null;
}

/** Whether direct publishing to Instagram is set up on the server. */
function metaConfigured(): boolean {
  const env = getEnv();
  return META_ENV.every((k) => Boolean(env[k]?.trim()));
}

/** The methods the composer offers for each platform. "Post it yourself" is always available. */
function methodOptions(account: AccountRow | null, handles: { instagram: string; tiktok: string }): Record<TargetPlatform, MethodOption[]> {
  const igHandle = account?.username ? `@${account.username}` : handleLabel(handles.instagram, 'instagram');
  const instagram: MethodOption[] = [];
  if (account && metaConfigured()) {
    const verified = Boolean(account.capabilities['verifiedDirectAt']);
    if (account.status !== 'connected') {
      instagram.push({ method: 'instagram_api', available: false, reason: 'Reconnect Instagram in Settings → Integrations first.', isVerification: !verified, accountId: account.id, handle: igHandle });
    } else if (!verified) {
      instagram.push({ method: 'instagram_api', available: true, isVerification: true, accountId: account.id, handle: igHandle });
    } else {
      instagram.push({
        method: 'instagram_api',
        available: account.directPublishEnabled,
        ...(account.directPublishEnabled ? {} : { reason: 'Direct publishing is switched off in Settings → Integrations.' }),
        isVerification: false,
        accountId: account.id,
        handle: igHandle,
      });
    }
  }
  instagram.push({ method: 'manual', available: true, isVerification: false, handle: handleLabel(handles.instagram, 'instagram') });
  const tiktok: MethodOption[] = [{ method: 'manual', available: true, isVerification: false, handle: handleLabel(handles.tiktok, 'tiktok') }];
  return { instagram, tiktok };
}

/** Prior targets of versions on each platform (for the "already posted" warning and the duplicate rule). */
async function priorTargets(db: Database | Tx, versionIds: string[]): Promise<Array<{ versionId: string; platform: TargetPlatform; status: TargetStatus; publishedAt: Date | null; submittedAt: Date | null }>> {
  if (versionIds.length === 0) return [];
  const rows = await db
    .select({ versionId: schema.publishPosts.editVersionId, platform: schema.publishTargets.platform, status: schema.publishTargets.status, publishedAt: schema.publishTargets.publishedAt, submittedAt: schema.publishTargets.submittedAt })
    .from(schema.publishTargets)
    .innerJoin(schema.publishPosts, eq(schema.publishTargets.postId, schema.publishPosts.id))
    .where(and(inArray(schema.publishPosts.editVersionId, versionIds), isNotNull(schema.publishPosts.approvedAt)));
  return rows as Array<{ versionId: string; platform: TargetPlatform; status: TargetStatus; publishedAt: Date | null; submittedAt: Date | null }>;
}

/**
 * GET /api/publishing/eligibility: what the composer may offer for each chosen version (files per platform with the
 * music rule, methods, prior posts, the default cover and the caption footer). Nothing is preselected.
 */
export async function getPublishingEligibility(versionIds: string[], user: SessionUser): Promise<EligibilityDto> {
  const ids = [...new Set(versionIds)].slice(0, 5);
  if (ids.length === 0) throw new AppError('VALIDATION', 'Choose at least one edit to publish.');
  const db = getDb();
  const settings = await getSettings();
  const handles = { instagram: settings.business.instagramHandle, tiktok: settings.business.tiktokHandle };
  const account = await instagramAccount(db);
  const methods = methodOptions(account, handles);
  const prior = await priorTargets(db, ids);
  const items: EligibilityItemDto[] = [];
  for (const id of ids) {
    const { version, edit, project } = await getAccessibleVersion(id, user);
    if (version.status !== 'preview_ready' || !version.plan) throw new AppError('CONFLICT', 'One of the chosen edits is not ready yet. Wait for its preview, then publish.');
    const e = await eligibilityFor(db, version);
    items.push({
      versionId: version.id,
      projectId: project.id,
      projectTitle: project.title,
      styleName: styleName(edit.styleId),
      versionNo: version.versionNo,
      previewUrl: await maybeSignedUrl(version.previewKey),
      durationSec: computeTimeline(version.plan).totalDurationSec,
      exportStatus: version.exportStatus,
      noMusicExportStatus: version.variantExports?.no_music?.status ?? 'none',
      defaultCoverTimeSec: defaultCoverTimeSec(version.plan),
      captionSuffix: e.captionSuffix,
      hasMusic: Boolean(version.plan.audio.music),
      eligibility: e.perPlatform,
      notes: e.notes,
      methods,
      priorTargets: prior
        .filter((p) => p.versionId === version.id && (p.status === 'published' || p.status === 'processing' || p.submittedAt))
        .map((p) => ({ platform: p.platform, status: p.status, publishedAt: iso(p.publishedAt) })),
    });
  }
  const caps = account?.capabilities ?? {};
  return {
    items,
    quota: account && typeof caps['quotaUsage'] === 'number' ? { instagram: { usage: caps['quotaUsage'], total: typeof caps['quotaTotal'] === 'number' ? caps['quotaTotal'] : null, checkedAt: typeof caps['quotaCheckedAt'] === 'string' ? caps['quotaCheckedAt'] : null } } : {},
    captionFooter: settings.publishing.captionFooter,
    canApprove: user.role === 'owner',
  };
}

/** Recent finished edits the user may publish (the composer's picker; nothing ticked). */
export async function listCandidateVersions(user: SessionUser, limit = 30): Promise<CandidateVersionDto[]> {
  const rows = await getDb()
    .select({ versionId: schema.editVersions.id, versionNo: schema.editVersions.versionNo, durationSec: schema.editVersions.previewDurationSec, updatedAt: schema.editVersions.updatedAt, styleId: schema.edits.styleId, projectTitle: schema.projects.title })
    .from(schema.editVersions)
    .innerJoin(schema.edits, eq(schema.editVersions.editId, schema.edits.id))
    .innerJoin(schema.projects, eq(schema.edits.projectId, schema.projects.id))
    .where(and(isNull(schema.projects.deletedAt), isNull(schema.edits.deletedAt), projectVisibilityFilter(user), eq(schema.editVersions.status, 'preview_ready')))
    .orderBy(desc(schema.editVersions.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ versionId: r.versionId, projectTitle: r.projectTitle, styleName: styleName(r.styleId), versionNo: r.versionNo, durationSec: r.durationSec, updatedAt: r.updatedAt.toISOString() }));
}

// ---------------------------------------------------------------------------------------------
// Create, approve, change, cancel
// ---------------------------------------------------------------------------------------------

/** Checks one destination against the music rule and the methods on offer; returns its account and verification flag. */
function checkTarget(t: PublishTargetInput, e: PlatformEligibility | undefined, options: MethodOption[]): { accountId: string | null; isVerification: boolean } {
  if (!e) throw new AppError('VALIDATION', 'Choose Instagram or TikTok.');
  if (t.method === 'zernio') throw new AppError('UNSUPPORTED', 'Automatic TikTok posting is not available yet. Choose "Post it yourself".');
  const option = options.find((o) => o.method === t.method);
  if (!option || !option.available) throw new AppError('VALIDATION', option?.reason ?? `That way of posting to ${TARGET_PLATFORM_NAMES[t.platform]} isn't available. Choose "Post it yourself".`);
  const refusal = methodVariantRefusal(e, t.method, t.variant);
  if (refusal) throw new AppError('VALIDATION', refusal);
  return { accountId: option.accountId ?? null, isVerification: option.isVerification };
}

/** Validates one compose item and returns what to store. */
async function resolveItem(db: Database | Tx, item: CreatePublishPostItem, user: SessionUser, methods: Record<TargetPlatform, MethodOption[]>, now: Date) {
  const { version, project } = await getAccessibleVersion(item.editVersionId, user);
  if (version.status !== 'preview_ready' || !version.plan) throw new AppError('CONFLICT', 'This edit is not ready yet. Wait for its preview, then publish.');
  const e = await eligibilityFor(db, version);
  const caption = validateCaption(item.caption, e.captionSuffix);
  if (!caption.ok) throw new AppError('VALIDATION', caption.errors[0] ?? 'The caption is too long.');
  let scheduledFor: Date | null = null;
  if (item.mode === 'scheduled' && item.schedule) {
    const r = resolveSchedule(item.schedule, now);
    if (!r.ok) throw new AppError('VALIDATION', r.message);
    scheduledFor = r.instant;
  }
  const targets = item.targets.map((t) => ({ ...t, ...checkTarget(t, e.perPlatform.find((p) => p.platform === t.platform), methods[t.platform]) }));
  const duration = computeTimeline(version.plan).totalDurationSec;
  return { version, project, caption, scheduledFor, targets, eligibility: e, coverTimeSec: Math.min(item.coverTimeSec, duration) };
}

/** Throws 409 when a version already went out (or is going out) on a platform, unless the owner ticked "Post again". */
async function assertNoRepeat(db: Database | Tx, versionId: string, platforms: TargetPlatform[], allowRepeat: boolean): Promise<void> {
  if (allowRepeat) return;
  const prior = (await priorTargets(db, [versionId])).filter((p) => platforms.includes(p.platform) && (p.status === 'published' || p.status === 'processing' || p.submittedAt));
  if (prior[0]) {
    const p = prior[0];
    throw new AppError('CONFLICT', `This edit was already ${p.status === 'published' ? 'posted' : 'sent'} to ${TARGET_PLATFORM_NAMES[p.platform]}. Tick "Post again" to make a second post.`, { details: { platform: p.platform } });
  }
}

/**
 * POST /api/publish-posts: creates one draft post per video with its destinations, after checking access, the music
 * rule, the methods on offer, the caption, the Melbourne schedule (10 minutes to 90 days ahead, DST-aware) and the
 * duplicate rule. Nothing is sent until the owner approves.
 */
export async function createPublishPosts(input: CreatePublishPosts, user: SessionUser, now: Date = new Date()): Promise<{ posts: PublishPostDto[] }> {
  const db = getDb();
  const settings = await getSettings();
  const methods = methodOptions(await instagramAccount(db), { instagram: settings.business.instagramHandle, tiktok: settings.business.tiktokHandle });
  const resolved: Array<{ item: CreatePublishPostItem } & Awaited<ReturnType<typeof resolveItem>>> = [];
  for (const item of input.items) {
    const r = await resolveItem(db, item, user, methods, now);
    await assertNoRepeat(db, r.version.id, item.targets.map((t) => t.platform), input.allowRepeat);
    resolved.push({ item, ...r });
  }
  const ids: string[] = [];
  await db.transaction(async (tx) => {
    for (const r of resolved) {
      const postId = newId();
      ids.push(postId);
      await tx.insert(schema.publishPosts).values({
        id: postId,
        projectId: r.project.id,
        editVersionId: r.version.id,
        createdBy: user.id,
        caption: r.caption.finalCaption,
        coverTimeSec: r.coverTimeSec,
        mode: r.item.mode,
        scheduledFor: r.scheduledFor,
        status: 'draft',
        statusMessage: 'Draft: not approved yet',
      });
      for (const t of r.targets) {
        const id = newId();
        await tx.insert(schema.publishTargets).values({
          id,
          postId,
          platform: t.platform,
          accountId: t.accountId,
          idempotencyKey: `pt_${id}`,
          method: t.method,
          delivery: t.delivery,
          mediaVariant: t.variant,
          isVerification: t.isVerification,
          statusMessage: 'Waiting for approval',
        });
      }
    }
  });
  await writeAudit({ userId: user.id, action: 'publish.drafted', entityType: 'publish_post', data: { postIds: ids, allowRepeat: input.allowRepeat } });
  return { posts: await Promise.all(ids.map((id) => getPublishPost(id, user))) };
}

/**
 * POST /api/publish-posts/approve (owner): approves drafts, re-running the music rule and storing it with the
 * licence snapshot in `music_check`, then queues `publish.prepare`. Idempotent for posts already approved. No
 * feedback event or usage-ledger row is written here: those wait until a destination is really published.
 */
export async function approvePublishPosts(input: z.infer<typeof ApprovePublishPostsSchema>, user: SessionUser, now: Date = new Date()): Promise<{ posts: PublishPostDto[] }> {
  requireOwner(user);
  const db = getDb();
  for (const postId of [...new Set(input.postIds)]) {
    const post = await getAccessiblePost(postId, user);
    if (post.approvedAt) continue;
    if (post.status !== 'draft') throw new AppError('CONFLICT', 'This post can no longer be approved.');
    const targets = await db.query.publishTargets.findMany({ where: eq(schema.publishTargets.postId, post.id) });
    if (targets.some((t) => t.method === 'zernio') && input.consent?.tiktokPublic !== true) {
      throw new AppError('VALIDATION', 'Tick the box to confirm you have watched the video and want it posted publicly to TikTok.');
    }
    if (post.mode === 'scheduled' && (!post.scheduledFor || post.scheduledFor.getTime() < now.getTime() + 60_000)) {
      throw new AppError('VALIDATION', 'The scheduled time has passed. Choose a new time, then approve.');
    }
    const version = await db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, post.editVersionId) });
    if (!version?.plan) throw new AppError('CONFLICT', 'This edit no longer exists.');
    const e = await eligibilityFor(db, version);
    const reasons: string[] = [];
    for (const t of targets) {
      const pe = e.perPlatform.find((p) => p.platform === t.platform);
      const refusal = pe ? methodVariantRefusal(pe, t.method, t.mediaVariant) : 'Unknown platform.';
      if (refusal) reasons.push(refusal);
    }
    if (reasons.length) throw new AppError('VALIDATION', `The music licence changed since this draft was made: ${reasons[0]}`);
    const approved = await db
      .update(schema.publishPosts)
      .set({
        approvedBy: user.id,
        approvedAt: now,
        status: 'approved',
        statusMessage: 'Approved',
        musicCheck: { ok: true, reasons: e.perPlatform.flatMap((p) => p.reasons), perPlatform: e.perPlatform, licenceSnapshot: e.licenceSnapshot, checkedAt: now.toISOString() },
        updatedAt: now,
      })
      .where(and(eq(schema.publishPosts.id, post.id), isNull(schema.publishPosts.approvedAt)))
      .returning({ id: schema.publishPosts.id });
    if (approved.length === 0) continue;
    await db.update(schema.publishTargets).set({ statusMessage: post.mode === 'scheduled' ? 'Preparing for the scheduled time…' : 'Preparing the full-quality video…', updatedAt: now }).where(eq(schema.publishTargets.postId, post.id));
    await writeAudit({ userId: user.id, action: 'publish.approved', entityType: 'publish_post', entityId: post.id, data: { mode: post.mode, targets: targets.map((t) => ({ platform: t.platform, method: t.method, variant: t.mediaVariant, isVerification: t.isVerification })) } });
    await createTrackedJob({ type: 'publish.prepare', payload: { postId: post.id, projectId: post.projectId }, projectId: post.projectId, singletonKey: `publish-prepare:${post.id}` });
  }
  return { posts: await Promise.all(input.postIds.map((id) => getPublishPost(id, user))) };
}

/** Writes the post's derived status (web twin of the worker's `refreshPostStatus`). */
export async function refreshPostStatus(db: Database | Tx, postId: string): Promise<void> {
  const post = await db.query.publishPosts.findFirst({ columns: { approvedAt: true }, where: eq(schema.publishPosts.id, postId) });
  if (!post) return;
  const targets = (await db.select({ status: schema.publishTargets.status }).from(schema.publishTargets).where(eq(schema.publishTargets.postId, postId))) as Array<{ status: TargetStatus }>;
  const status = derivePostStatus(Boolean(post.approvedAt), targets);
  await db.update(schema.publishPosts).set({ status, statusMessage: postStatusMessage(status, targets), updatedAt: new Date() }).where(eq(schema.publishPosts.id, postId));
}

/**
 * PATCH /api/publish-posts/[id]: changing only the time keeps the approval; changing the caption, cover or
 * destinations returns an approved post to draft (owner only once approved). Refused once anything was sent.
 */
export async function patchPublishPost(postId: string, input: z.infer<typeof PatchPublishPostSchema>, user: SessionUser, now: Date = new Date()): Promise<PublishPostDto> {
  const db = getDb();
  const post = await getAccessiblePost(postId, user);
  if (post.approvedAt) requireOwner(user);
  const targets = await db.query.publishTargets.findMany({ where: eq(schema.publishTargets.postId, post.id) });
  const editable = targets.every((t) => !t.submittedAt && (t.status === 'queued' || (t.status === 'manual_step_required' && t.manualStep === 'post_in_app')));
  if (!editable) throw new AppError('CONFLICT', 'This post has already started going out, so it can no longer be changed. Cancel what has not been sent instead.');
  const scheduleOnly = input.caption === undefined && input.coverTimeSec === undefined && input.targets === undefined;
  const values: Partial<typeof schema.publishPosts.$inferInsert> = { updatedAt: now };
  if (input.schedule) {
    const r = resolveSchedule(input.schedule, now);
    if (!r.ok) throw new AppError('VALIDATION', r.message);
    values.mode = 'scheduled';
    values.scheduledFor = r.instant;
  }
  const version = await db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, post.editVersionId) });
  if (!version?.plan) throw new AppError('CONFLICT', 'This edit no longer exists.');
  const e = await eligibilityFor(db, version);
  if (input.caption !== undefined) {
    const c = validateCaption(input.caption, e.captionSuffix);
    if (!c.ok) throw new AppError('VALIDATION', c.errors[0] ?? 'The caption is too long.');
    values.caption = c.finalCaption;
  }
  if (input.coverTimeSec !== undefined) {
    values.coverTimeSec = Math.min(input.coverTimeSec, computeTimeline(version.plan).totalDurationSec);
    values.coverKey = null;
  }
  let newTargets: Array<PublishTargetInput & { accountId: string | null; isVerification: boolean }> | null = null;
  if (input.targets) {
    const platforms = input.targets.map((t) => t.platform);
    if (new Set(platforms).size !== platforms.length) throw new AppError('VALIDATION', 'Choose each platform once.');
    const settings = await getSettings();
    const methods = methodOptions(await instagramAccount(db), { instagram: settings.business.instagramHandle, tiktok: settings.business.tiktokHandle });
    newTargets = input.targets.map((t) => ({ ...t, ...checkTarget(t, e.perPlatform.find((p) => p.platform === t.platform), methods[t.platform]) }));
    if (post.mode === 'draft_handoff' && newTargets.some((t) => t.method !== 'manual')) throw new AppError('VALIDATION', 'Prepare for manual posting needs every destination set to "Post it yourself".');
  }
  const backToDraft = Boolean(post.approvedAt) && !scheduleOnly;
  await db.transaction(async (tx) => {
    if (backToDraft) Object.assign(values, { approvedAt: null, approvedBy: null, status: 'draft', statusMessage: 'Draft: changed after approval, approve again' });
    await tx.update(schema.publishPosts).set(values).where(eq(schema.publishPosts.id, post.id));
    if (newTargets) {
      await tx.delete(schema.publishTargets).where(eq(schema.publishTargets.postId, post.id));
      for (const t of newTargets) {
        const id = newId();
        await tx.insert(schema.publishTargets).values({ id, postId: post.id, platform: t.platform, accountId: t.accountId, idempotencyKey: `pt_${id}`, method: t.method, delivery: t.delivery, mediaVariant: t.variant, isVerification: t.isVerification, statusMessage: 'Waiting for approval' });
      }
    } else if (backToDraft || values.coverKey === null) {
      await tx.update(schema.publishTargets).set({ status: 'queued', manualStep: null, statusMessage: backToDraft ? 'Waiting for approval' : 'Queued', updatedAt: now }).where(eq(schema.publishTargets.postId, post.id));
    } else if (input.schedule && post.scheduledFor && values.scheduledFor) {
      // Only the time changed: targets that were due become waiting again.
      await tx
        .update(schema.publishTargets)
        .set({ status: 'queued', manualStep: null, statusMessage: `Scheduled for ${melbourneScheduleLabel(values.scheduledFor)}`, updatedAt: now })
        .where(and(eq(schema.publishTargets.postId, post.id), inArray(schema.publishTargets.status, ['queued', 'manual_step_required'])));
    }
  });
  if (values.coverKey === null && post.coverKey) await getBlobStore().delete(post.coverKey).catch(() => undefined);
  await writeAudit({ userId: user.id, action: backToDraft ? 'publish.changed_back_to_draft' : 'publish.rescheduled', entityType: 'publish_post', entityId: post.id, data: { fields: Object.keys(input) } });
  if (post.approvedAt && !backToDraft) {
    await refreshPostStatus(db, post.id);
    await createTrackedJob({ type: 'publish.prepare', payload: { postId: post.id, projectId: post.projectId }, projectId: post.projectId, singletonKey: `publish-prepare:${post.id}` });
  }
  return getPublishPost(post.id, user);
}

/** POST /api/publish-posts/[id]/cancel (owner): every destination not yet sent is cancelled; published ones stay. */
export async function cancelPublishPost(postId: string, user: SessionUser): Promise<PublishPostDto> {
  requireOwner(user);
  const db = getDb();
  const post = await getAccessiblePost(postId, user);
  if (!post.approvedAt) throw new AppError('CONFLICT', 'This post is still a draft, so nothing will be sent. Delete the draft instead.');
  const cancelled = await db
    .update(schema.publishTargets)
    .set({ status: 'cancelled', manualStep: null, statusMessage: 'Cancelled before posting', updatedAt: new Date() })
    .where(and(eq(schema.publishTargets.postId, post.id), isNull(schema.publishTargets.submittedAt), inArray(schema.publishTargets.status, ['queued', 'manual_step_required', 'failed'])))
    .returning({ id: schema.publishTargets.id });
  await refreshPostStatus(db, post.id);
  await writeAudit({ userId: user.id, action: 'publish.cancelled', entityType: 'publish_post', entityId: post.id, data: { targets: cancelled.length } });
  return getPublishPost(post.id, user);
}

/** DELETE /api/publish-posts/[id]: drafts only (409 otherwise); removes the cover too. */
export async function deleteDraftPost(postId: string, user: SessionUser): Promise<void> {
  const db = getDb();
  const post = await getAccessiblePost(postId, user);
  if (post.approvedAt || post.status !== 'draft') throw new AppError('CONFLICT', 'Only drafts can be deleted. Cancel an approved post instead.');
  await db.delete(schema.publishPosts).where(and(eq(schema.publishPosts.id, post.id), isNull(schema.publishPosts.approvedAt)));
  await getBlobStore().deletePrefix(`publishing/${post.id}/`).catch(() => 0);
  await writeAudit({ userId: user.id, action: 'publish.draft_deleted', entityType: 'publish_post', entityId: post.id });
}

// ---------------------------------------------------------------------------------------------
// Reading posts
// ---------------------------------------------------------------------------------------------

async function toDtos(posts: PostRow[]): Promise<PublishPostDto[]> {
  if (posts.length === 0) return [];
  const db = getDb();
  const postIds = posts.map((p) => p.id);
  const targets = await db.query.publishTargets.findMany({ where: inArray(schema.publishTargets.postId, postIds) });
  const versions = await db
    .select({ id: schema.editVersions.id, versionNo: schema.editVersions.versionNo, previewKey: schema.editVersions.previewKey, styleId: schema.edits.styleId, projectTitle: schema.projects.title })
    .from(schema.editVersions)
    .innerJoin(schema.edits, eq(schema.editVersions.editId, schema.edits.id))
    .innerJoin(schema.projects, eq(schema.edits.projectId, schema.projects.id))
    .where(inArray(schema.editVersions.id, [...new Set(posts.map((p) => p.editVersionId))]));
  const accountIds = [...new Set(targets.map((t) => t.accountId).filter((x): x is string => Boolean(x)))];
  const accounts = accountIds.length ? await db.query.socialAccounts.findMany({ where: inArray(schema.socialAccounts.id, accountIds) }) : [];
  const confirmerIds = [...new Set(targets.map((t) => t.confirmedBy).filter((x): x is string => Boolean(x)))];
  const confirmers = confirmerIds.length ? await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(inArray(schema.users.id, confirmerIds)) : [];
  const settings = await getSettings();
  const out: PublishPostDto[] = [];
  for (const p of posts) {
    const v = versions.find((x) => x.id === p.editVersionId);
    out.push({
      id: p.id,
      versionId: p.editVersionId,
      projectId: p.projectId,
      projectTitle: v?.projectTitle ?? 'Deleted project',
      styleName: v ? styleName(v.styleId) : 'Deleted edit',
      versionNo: v?.versionNo ?? null,
      previewThumbUrl: await maybeSignedUrl(v?.previewKey ?? null),
      caption: p.caption,
      coverUrl: await maybeSignedUrl(p.coverKey),
      coverTimeSec: p.coverTimeSec,
      mode: p.mode,
      scheduledFor: iso(p.scheduledFor),
      scheduledForLabel: p.scheduledFor ? melbourneScheduleLabel(p.scheduledFor) : null,
      status: p.status,
      statusMessage: p.statusMessage,
      approvedAt: iso(p.approvedAt),
      createdAt: p.createdAt.toISOString(),
      targets: targets
        .filter((t) => t.postId === p.id)
        .sort((a, b) => a.platform.localeCompare(b.platform))
        .map((t) => toTargetDto(t, accounts.find((a) => a.id === t.accountId) ?? null, confirmers.find((c) => c.id === t.confirmedBy)?.displayName ?? null, settings.business)),
    });
  }
  return out;
}

function toTargetDto(t: TargetRow, account: AccountRow | null, confirmedByName: string | null, business: { instagramHandle: string; tiktokHandle: string }): TargetDto {
  const handle = account?.username ? `@${account.username}` : handleLabel(t.platform === 'instagram' ? business.instagramHandle : business.tiktokHandle, t.platform);
  const verifiedAt = account?.capabilities['verifiedDirectAt'];
  return {
    id: t.id,
    platform: t.platform,
    method: t.method,
    delivery: t.delivery,
    handle,
    variant: t.mediaVariant,
    status: t.status,
    manualStep: t.manualStep,
    statusMessage: t.statusMessage || (t.manualStep ? manualStepMessage(t.manualStep, t.platform) : ''),
    publishedUrl: t.publishedUrl,
    publishedAt: iso(t.publishedAt),
    confirmedByName,
    attempts: t.attempts,
    isVerification: t.isVerification,
    accountId: t.accountId,
    awaitingVerificationAnswer: t.isVerification && t.status === 'published' && !verifiedAt && t.providerState['verificationAnswer'] === undefined,
    actions: targetActionsFor({
      status: t.status,
      method: t.method,
      manualStep: t.manualStep,
      variant: t.mediaVariant,
      submittedAt: t.submittedAt,
      publishedUrl: t.publishedUrl,
      confirmedAt: t.confirmedAt,
      mediaReady: Boolean(t.mediaKey),
      retryable: t.providerState.retryable !== false,
    }),
  };
}

/** GET /api/publish-posts/[id]. */
export async function getPublishPost(postId: string, user: SessionUser): Promise<PublishPostDto> {
  const post = await getAccessiblePost(postId, user);
  const [dto] = await toDtos([post]);
  if (!dto) throw new AppError('NOT_FOUND', 'That post could not be found.');
  return dto;
}

/** SQL limiting posts to those the user may see. */
function postVisibility(user: SessionUser) {
  if (user.role === 'owner') return undefined;
  return inArray(schema.publishPosts.projectId, getDb().select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.ownerId, user.id)));
}

/**
 * GET /api/publish-posts?view=queue|history: the queue holds drafts, approved and in-progress posts and any post with a
 * destination waiting for the owner; history holds everything else. Newest first.
 */
export async function listPublishPosts(view: 'queue' | 'history', user: SessionUser, cursor: string | null, limit = 30): Promise<PublishPostListDto> {
  const db = getDb();
  const p = schema.publishPosts;
  const waiting = sql`exists (select 1 from ${schema.publishTargets} t where t.post_id = ${p.id} and t.status = 'manual_step_required')`;
  const inQueue = or(inArray(p.status, ['draft', 'approved', 'in_progress']), waiting);
  const where = and(view === 'queue' ? inQueue : sql`not (${inQueue})`, postVisibility(user), cursor ? lt(p.createdAt, new Date(cursor)) : undefined);
  const rows = await db.select().from(p).where(where).orderBy(desc(p.createdAt)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { posts: await toDtos(page), nextCursor: rows.length > limit ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null };
}

/** The post's own history from the audit log (newest first, at most 30). */
export async function postHistory(postId: string, user: SessionUser): Promise<Array<{ at: string; action: string; label: string }>> {
  const post = await getAccessiblePost(postId, user);
  const targets = await getDb().select({ id: schema.publishTargets.id }).from(schema.publishTargets).where(eq(schema.publishTargets.postId, post.id));
  const ids = [post.id, ...targets.map((t) => t.id)];
  const rows = await getDb().select().from(schema.auditLog).where(inArray(schema.auditLog.entityId, ids)).orderBy(desc(schema.auditLog.createdAt)).limit(30);
  const labels: Record<string, string> = {
    'publish.approved': 'Approved',
    'publish.cancelled': 'Cancelled',
    'publish.rescheduled': 'Time changed',
    'publish.changed_back_to_draft': 'Changed after approval',
    'publish.target.submitted': 'Sent to the platform',
    'publish.target.published': 'Published (confirmed by the platform)',
    'publish.target.failed': 'Failed',
    'publish.target.confirmed_manual': 'Marked as posted',
    'publish.target.undo_confirm': 'Posted mark undone',
    'publish.target.retry': 'Retried',
    'publish.target.override_retry': 'Sent again after checking',
    'publish.target.resolve': 'Changed how it is posted',
  };
  return rows.map((r) => ({ at: r.createdAt.toISOString(), action: r.action, label: labels[r.action] ?? r.action }));
}

// ---------------------------------------------------------------------------------------------
// Target actions
// ---------------------------------------------------------------------------------------------

/** GET /api/publish-targets/[id]/media: expiring links to the exact file, the cover (Instagram) and the caption. */
export async function targetMedia(targetId: string, user: SessionUser): Promise<TargetMediaDto> {
  const { target, post } = await getAccessibleTarget(targetId, user);
  if (!target.mediaKey) throw new AppError('CONFLICT', 'The video for this destination is still being prepared.');
  const db = getDb();
  const version = await db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, post.editVersionId) });
  const edit = version ? await db.query.edits.findFirst({ where: eq(schema.edits.id, version.editId) }) : null;
  const e = version ? await eligibilityFor(db, version) : null;
  const metaOnly = target.mediaVariant === 'standard' && e?.licenceSnapshot?.destinationLock === 'meta_only';
  const videoFilename = downloadNameFor(['studio', edit ? styleName(edit.styleId) : 'edit', version ? `v${version.versionNo}` : null, target.mediaVariant === 'no_music' ? 'no-music' : null, metaOnly ? META_ONLY_FILE_SUFFIX : null], 'mp4');
  const stat = await getBlobStore().stat(target.mediaKey).catch(() => null);
  return {
    videoUrl: await signedUrlFor(target.mediaKey, { downloadName: videoFilename, contentType: 'video/mp4' }),
    videoFilename,
    byteSize: stat?.size ?? null,
    coverUrl: target.platform === 'instagram' && post.coverKey ? await signedUrlFor(post.coverKey, { downloadName: downloadNameFor(['studio', 'cover'], 'jpg') }) : null,
    caption: post.caption,
    label: metaOnly ? META_ONLY_LABEL : null,
  };
}

/**
 * The effects of a confirmed post, in the caller's transaction: one `publish` feedback event per version and platform
 * (never deleted by an undo) and, for a file with music, one `music_usage` row with the licence as it is now.
 */
async function recordPublishedEffects(tx: Tx, target: TargetRow, post: PostRow, userId: string): Promise<void> {
  const version = await tx.query.editVersions.findFirst({ columns: { id: true, editId: true, plan: true }, where: eq(schema.editVersions.id, post.editVersionId) });
  if (!version) return;
  const edit = await tx.query.edits.findFirst({ columns: { id: true, styleId: true }, where: eq(schema.edits.id, version.editId) });
  const seen = await tx
    .select({ id: schema.feedbackEvents.id })
    .from(schema.feedbackEvents)
    .where(and(eq(schema.feedbackEvents.editVersionId, version.id), eq(schema.feedbackEvents.type, 'publish'), sql`${schema.feedbackEvents.data}->>'platform' = ${target.platform}`))
    .limit(1);
  if (seen.length === 0) {
    await recordFeedback(tx, { type: 'publish', userId, projectId: post.projectId, editId: edit?.id ?? version.editId, editVersionId: version.id, styleId: edit?.styleId ?? null, plan: version.plan, data: { platform: target.platform, method: target.method, variant: target.mediaVariant, postId: post.id } });
  }
  const music = version.plan?.audio.music;
  if (target.mediaVariant === 'standard' && music) {
    const track = await tx.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, music.trackId) });
    if (track) {
      await tx
        .insert(schema.musicUsage)
        .values({ id: newId(), trackId: track.id, editVersionId: version.id, purpose: 'publish', platform: target.platform, licenceSnapshot: normaliseLicence(track.licence), clearance: musicClearanceFor(track.deletedAt ? null : track.licence), createdBy: userId })
        .onConflictDoNothing();
    }
  }
}

/**
 * POST /api/publish-targets/[id]/confirm-posted: the owner (or staff on their own project) says a destination was
 * posted by hand, optionally with the post's link (only a real Instagram or TikTok post link is stored). Also adds a
 * link to a post published without one. Idempotent.
 */
export async function confirmPosted(targetId: string, rawUrl: string | undefined, user: SessionUser): Promise<PublishPostDto> {
  const db = getDb();
  const { target, post } = await getAccessibleTarget(targetId, user);
  const url = rawUrl?.trim() ? validatePostLink(target.platform, rawUrl) : null;
  if (rawUrl?.trim() && !url) {
    throw new AppError('VALIDATION', target.platform === 'instagram' ? 'Paste the link to the reel, like https://www.instagram.com/reel/…' : 'Paste the link to the TikTok, like https://www.tiktok.com/@you/video/…');
  }
  const confirmable = target.status === 'manual_step_required' && (target.manualStep === 'post_in_app' || target.manualStep === 'finish_in_tiktok_app' || target.manualStep === 'check_before_retry');
  if (target.status === 'published') {
    if (target.publishedUrl || !url) return getPublishPost(post.id, user);
    await db.update(schema.publishTargets).set({ publishedUrl: url, updatedAt: new Date() }).where(and(eq(schema.publishTargets.id, target.id), isNull(schema.publishTargets.publishedUrl)));
    await writeAudit({ userId: user.id, action: 'publish.target.link_added', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform } });
    return getPublishPost(post.id, user);
  }
  if (!confirmable) throw new AppError('CONFLICT', 'This destination is not waiting for you to post it.');
  if (target.manualStep === 'check_before_retry') requireOwner(user);
  const now = new Date();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.publishTargets)
      .set({
        status: 'published',
        manualStep: null,
        confirmedBy: user.id,
        confirmedAt: now,
        publishedAt: target.publishedAt ?? now,
        publishedUrl: url,
        statusMessage: 'Posted (you confirmed)',
        providerState: sql`${schema.publishTargets.providerState} || ${JSON.stringify({ confirmedFrom: target.manualStep })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(schema.publishTargets.id, target.id), eq(schema.publishTargets.status, 'manual_step_required')))
      .returning();
    if (updated[0]) await recordPublishedEffects(tx, updated[0], post, user.id);
    await refreshPostStatus(tx, post.id);
  });
  await writeAudit({ userId: user.id, action: 'publish.target.confirmed_manual', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform, withLink: Boolean(url), from: target.manualStep } });
  return getPublishPost(post.id, user);
}

/** POST /api/publish-targets/[id]/undo-confirm: only a manual confirmation can be undone (back to "your turn"). */
export async function undoConfirm(targetId: string, user: SessionUser): Promise<PublishPostDto> {
  const db = getDb();
  const { target, post } = await getAccessibleTarget(targetId, user);
  if (target.status !== 'published' || !target.confirmedAt) throw new AppError('CONFLICT', 'Only a post you marked as posted yourself can be undone.');
  const from = target.providerState['confirmedFrom'];
  const step = from === 'finish_in_tiktok_app' || from === 'check_before_retry' ? from : 'post_in_app';
  await db
    .update(schema.publishTargets)
    .set({ status: 'manual_step_required', manualStep: step, confirmedBy: null, confirmedAt: null, publishedUrl: null, publishedAt: target.externalPostId ? target.publishedAt : null, statusMessage: manualStepMessage(step, target.platform), updatedAt: new Date() })
    .where(and(eq(schema.publishTargets.id, target.id), eq(schema.publishTargets.status, 'published'), isNotNull(schema.publishTargets.confirmedAt)));
  await refreshPostStatus(db, post.id);
  await writeAudit({ userId: user.id, action: 'publish.target.undo_confirm', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform } });
  return getPublishPost(post.id, user);
}

async function queueTargetWork(target: TargetRow, post: PostRow): Promise<void> {
  if (target.method !== 'manual' && target.mediaKey) {
    await createTrackedJob({ type: 'publish.target', payload: { targetId: target.id, postId: post.id, projectId: post.projectId }, projectId: post.projectId, singletonKey: `publish-target:${target.id}` });
  } else {
    await createTrackedJob({ type: 'publish.prepare', payload: { postId: post.id, projectId: post.projectId }, projectId: post.projectId, singletonKey: `publish-prepare:${post.id}` });
  }
}

/** POST /api/publish-targets/[id]/retry (owner): a retryable failed destination goes back to the queue with the same idempotency key. */
export async function retryTarget(targetId: string, user: SessionUser): Promise<PublishPostDto> {
  requireOwner(user);
  const db = getDb();
  const { target, post } = await getAccessibleTarget(targetId, user);
  if (target.status !== 'failed') throw new AppError('CONFLICT', 'Only a failed destination can be retried.');
  if (target.providerState.retryable === false) throw new AppError('CONFLICT', 'The platform refused this post for good. Post it yourself instead.');
  const updated = await db
    .update(schema.publishTargets)
    .set({ status: 'queued', error: null, statusMessage: 'Queued to try again', updatedAt: new Date() })
    .where(and(eq(schema.publishTargets.id, target.id), eq(schema.publishTargets.status, 'failed')))
    .returning();
  if (!updated[0]) return getPublishPost(post.id, user);
  await refreshPostStatus(db, post.id);
  await writeAudit({ userId: user.id, action: 'publish.target.retry', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform, method: target.method } });
  await queueTargetWork(updated[0], post);
  return getPublishPost(post.id, user);
}

/**
 * POST /api/publish-targets/[id]/resolve (owner): the owner's choice for a destination waiting on them:
 * post without music (copyright match or licence change), post it yourself, send again after checking the platform
 * (`check_before_retry` only, audited as an override), or mark it posted.
 */
export async function resolveTarget(targetId: string, action: ResolveAction, user: SessionUser): Promise<PublishPostDto> {
  requireOwner(user);
  const db = getDb();
  const { target, post } = await getAccessibleTarget(targetId, user);
  const now = new Date();
  if (action === 'mark_posted') return confirmPosted(targetId, undefined, user);
  if (action === 'retry_anyway') {
    if (target.status !== 'manual_step_required' || target.manualStep !== 'check_before_retry') throw new AppError('CONFLICT', 'This destination is not waiting for a check.');
    const updated = await db
      .update(schema.publishTargets)
      .set({ status: 'queued', manualStep: null, submittedAt: null, statusMessage: 'Sending again after your check', updatedAt: now })
      .where(and(eq(schema.publishTargets.id, target.id), eq(schema.publishTargets.manualStep, 'check_before_retry')))
      .returning();
    await writeAudit({ userId: user.id, action: 'publish.target.override_retry', entityType: 'publish_target', entityId: target.id, data: { platform: target.platform } });
    await refreshPostStatus(db, post.id);
    if (updated[0]) await queueTargetWork(updated[0], post);
    return getPublishPost(post.id, user);
  }
  const waiting = target.status === 'manual_step_required' || target.status === 'failed';
  if (!waiting || target.submittedAt) throw new AppError('CONFLICT', 'This destination cannot be changed now.');
  const version = await db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, post.editVersionId) });
  if (!version?.plan) throw new AppError('CONFLICT', 'This edit no longer exists.');
  const e = (await eligibilityFor(db, version)).perPlatform.find((p) => p.platform === target.platform);
  let variant: MediaVariant = target.mediaVariant;
  let method = target.method;
  if (action === 'post_without_music') {
    if (target.manualStep !== 'review_copyright_match' && target.manualStep !== 'music_licence_changed') throw new AppError('CONFLICT', 'Posting without music is offered only after a music problem.');
    variant = 'no_music';
  } else {
    method = 'manual';
    if (e && !e.allowedVariants.includes(variant)) variant = e.allowedVariants[0] ?? 'no_music';
  }
  const updated = await db
    .update(schema.publishTargets)
    .set({
      status: 'queued',
      manualStep: null,
      method,
      accountId: method === 'manual' ? null : target.accountId,
      mediaVariant: variant,
      mediaKey: variant === target.mediaVariant ? target.mediaKey : null,
      externalContainerId: null,
      error: null,
      providerState: {},
      statusMessage: variant === 'no_music' ? 'Preparing the version without music…' : 'Preparing…',
      updatedAt: now,
    })
    .where(and(eq(schema.publishTargets.id, target.id), isNull(schema.publishTargets.submittedAt)))
    .returning();
  await writeAudit({ userId: user.id, action: 'publish.target.resolve', entityType: 'publish_target', entityId: target.id, data: { action, platform: target.platform, variant, method } });
  await refreshPostStatus(db, post.id);
  if (updated[0]) await createTrackedJob({ type: 'publish.prepare', payload: { postId: post.id, projectId: post.projectId }, projectId: post.projectId, singletonKey: `publish-prepare:${post.id}` });
  return getPublishPost(post.id, user);
}

// ---------------------------------------------------------------------------------------------
// Accounts, verification and connections
// ---------------------------------------------------------------------------------------------

/** POST /api/social-accounts/[id]/verification (owner): "Can you see the reel?" after the first verification post. */
export async function recordVerification(accountId: string, input: { result: 'seen' | 'not_seen'; targetId: string }, user: SessionUser): Promise<SocialAccountDto> {
  requireOwner(user);
  const db = getDb();
  const account = await db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, accountId) });
  const target = await db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, input.targetId) });
  if (!account) throw new AppError('NOT_FOUND', 'That account could not be found.');
  if (!target || target.accountId !== account.id || !target.isVerification || target.status !== 'published') {
    throw new AppError('CONFLICT', 'Only a published first verification post can be confirmed.');
  }
  const now = new Date().toISOString();
  if (input.result === 'seen') {
    await db
      .update(schema.socialAccounts)
      .set({ capabilities: sql`${schema.socialAccounts.capabilities} || ${JSON.stringify({ verifiedDirectAt: now, verificationTargetId: target.id })}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.socialAccounts.id, account.id));
  }
  await db
    .update(schema.publishTargets)
    .set({ providerState: sql`${schema.publishTargets.providerState} || ${JSON.stringify({ verificationAnswer: input.result })}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.publishTargets.id, target.id));
  await writeAudit({ userId: user.id, action: 'social_account.verification', entityType: 'social_account', entityId: account.id, data: { result: input.result, targetId: target.id, platform: account.platform } });
  return toAccountDto((await db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, account.id) }))!);
}

/** PATCH /api/social-accounts/[id] (owner): the direct-publishing switch, only after a confirmed verification post. */
export async function setDirectPublishing(accountId: string, enabled: boolean, user: SessionUser): Promise<SocialAccountDto> {
  requireOwner(user);
  const db = getDb();
  const account = await db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, accountId) });
  if (!account) throw new AppError('NOT_FOUND', 'That account could not be found.');
  if (enabled && !account.capabilities['verifiedDirectAt']) throw new AppError('CONFLICT', 'Make a first verification post and confirm you can see it before switching direct publishing on.');
  await db.update(schema.socialAccounts).set({ directPublishEnabled: enabled, updatedAt: new Date() }).where(eq(schema.socialAccounts.id, account.id));
  await writeAudit({ userId: user.id, action: `social_account.direct_publish.${enabled ? 'enabled' : 'disabled'}`, entityType: 'social_account', entityId: account.id, data: { platform: account.platform } });
  return toAccountDto({ ...account, directPublishEnabled: enabled });
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function toAccountDto(a: AccountRow): SocialAccountDto {
  const c = a.capabilities;
  return {
    id: a.id,
    platform: a.platform,
    username: a.username,
    status: a.status,
    verified: Boolean(c['verifiedDirectAt']),
    verifiedAt: typeof c['verifiedDirectAt'] === 'string' ? c['verifiedDirectAt'] : null,
    directPublishEnabled: a.directPublishEnabled,
    quotaUsage: num(c['quotaUsage']),
    quotaTotal: num(c['quotaTotal']),
    quotaCheckedAt: typeof c['quotaCheckedAt'] === 'string' ? c['quotaCheckedAt'] : null,
    lastError: a.lastError,
  };
}

/** GET /api/publishing/connections: Instagram connection facts (never the token), handles and the caption footer. */
export async function getPublishingConnections(user: SessionUser, now: Date = new Date()): Promise<PublishingConnectionsDto> {
  const env = getEnv();
  const db = getDb();
  const settings = await getSettings();
  const conn = await db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
  const accounts = await db.query.socialAccounts.findMany({ where: and(eq(schema.socialAccounts.platform, 'instagram'), eq(schema.socialAccounts.provider, 'meta_graph')) });
  const checked = conn?.config['debugToken'] as { expiresAt?: string | null } | undefined;
  const expires = checked ? (checked.expiresAt ?? null) : undefined;
  const missing = META_ENV.filter((k) => !env[k]?.trim());
  return {
    canManage: user.role === 'owner',
    instagram: {
      configured: missing.length === 0,
      missingEnv: [...missing],
      connectionStatus: conn ? conn.status : 'none',
      lastError: conn?.lastError ?? null,
      lastCheckedAt: iso(conn?.lastSyncAt),
      tokenExpiresAt: expires,
      tokenExpiringSoon: Boolean(expires && new Date(expires).getTime() - now.getTime() < TOKEN_WARNING_DAYS * 86_400_000),
      graphVersion: env.META_GRAPH_VERSION,
      discoveryEmpty: conn?.capabilities['discoveryEmpty'] === true,
      accounts: accounts.filter((a) => a.status !== 'disconnected').map(toAccountDto),
    },
    handles: { instagram: settings.business.instagramHandle, tiktok: settings.business.tiktokHandle },
    captionFooter: settings.publishing.captionFooter,
  };
}

/** PUT /api/publishing/settings (owner): the default caption ending, written with jsonb_set so other sections are never overwritten. */
export async function savePublishingSettings(captionFooter: string, user: SessionUser): Promise<{ captionFooter: string }> {
  requireOwner(user);
  await getSettings();
  const value = JSON.stringify({ captionFooter });
  await getDb()
    .update(schema.settings)
    .set({ data: sql`jsonb_set(${schema.settings.data}, '{publishing}', ${value}::jsonb, true)`, updatedAt: new Date() })
    .where(eq(schema.settings.id, 'default'));
  await writeAudit({ userId: user.id, action: 'settings.updated', entityType: 'settings', entityId: 'default', data: { sections: ['publishing'] } });
  return { captionFooter };
}

/** Badges for Studio and Library cards: the latest state per version and platform of approved posts. */
export async function publishBadgesFor(versionIds: string[], user: SessionUser): Promise<PublishBadgeDto[]> {
  const ids = [...new Set(versionIds)].slice(0, 100);
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({ versionId: schema.publishPosts.editVersionId, platform: schema.publishTargets.platform, status: schema.publishTargets.status, scheduledFor: schema.publishPosts.scheduledFor, updatedAt: schema.publishTargets.updatedAt })
    .from(schema.publishTargets)
    .innerJoin(schema.publishPosts, eq(schema.publishTargets.postId, schema.publishPosts.id))
    .where(and(inArray(schema.publishPosts.editVersionId, ids), isNotNull(schema.publishPosts.approvedAt), postVisibility(user)))
    .orderBy(desc(schema.publishTargets.updatedAt));
  const seen = new Set<string>();
  const out: PublishBadgeDto[] = [];
  for (const r of rows) {
    const key = `${r.versionId}:${r.platform}`;
    if (seen.has(key) || r.status === 'cancelled') continue;
    seen.add(key);
    const name = TARGET_PLATFORM_NAMES[r.platform];
    const label =
      r.status === 'published'
        ? `${name} · Posted`
        : r.status === 'manual_step_required'
          ? `${name} · Your turn`
          : r.status === 'failed'
            ? `${name} · Failed`
            : r.scheduledFor && r.scheduledFor.getTime() > Date.now()
              ? `${name} · Scheduled ${melbourneScheduleLabel(r.scheduledFor).replace(/,.*$/, '')}`
              : `${name} · In progress`;
    out.push({ versionId: r.versionId, platform: r.platform, status: r.status, label });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Instagram (Meta Unified Login) connect, account ID, check and disconnect
// ---------------------------------------------------------------------------------------------

/** Meta's login dialog with `config_id` and no `scope` (memo §4). */
export function buildMetaAuthUrl(input: { version: string; appId: string; configId: string; redirectUri: string; state: string }): string {
  const u = new URL(`https://www.facebook.com/${input.version}/dialog/oauth`);
  u.searchParams.set('client_id', input.appId);
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('config_id', input.configId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('override_default_response_type', 'true');
  u.searchParams.set('state', input.state);
  return u.toString();
}

/** The fixed redirect address (from APP_URL). */
export function metaRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}${META_OAUTH_PATH}/callback`;
}

/** A refused or failed code exchange, with a plain reason. */
export class MetaExchangeError extends Error {
  constructor(
    readonly reason: 'timeout' | 'unreachable' | 'rejected',
    message: string,
  ) {
    super(message);
    this.name = 'MetaExchangeError';
  }
}

/** The single, inline code exchange (10 s, no retry): `GET /{v}/oauth/access_token`. Returns the token only. */
export async function exchangeMetaCode(input: { code: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<string> {
  const env = getEnv();
  const base = testOnlyBaseUrl(env, env.META_GRAPH_BASE_URL) ?? 'https://graph.facebook.com';
  const u = new URL(`${base}/${env.META_GRAPH_VERSION}/oauth/access_token`);
  u.searchParams.set('client_id', env.META_APP_ID ?? '');
  u.searchParams.set('client_secret', env.META_APP_SECRET ?? '');
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('code', input.code);
  let res: Response;
  try {
    res = await (input.fetchImpl ?? globalThis.fetch)(u.toString(), { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(META_EXCHANGE_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new MetaExchangeError(timedOut ? 'timeout' : 'unreachable', timedOut ? 'Meta did not answer in time. Please press Connect again.' : 'Meta could not be reached. Please press Connect again.');
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; error?: { message?: unknown } } | null;
  if (!res.ok || typeof body?.access_token !== 'string' || !body.access_token) {
    const why = typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 200)}` : '';
    throw new MetaExchangeError('rejected', `Meta refused the sign-in (HTTP ${res.status}${why}).`);
  }
  return body.access_token;
}

/** Stores the system-user token encrypted on the one `meta` connection row and returns its id. */
export async function storeMetaConnection(token: string): Promise<string> {
  const db = getDb();
  const encrypted = encryptToken(token);
  const existing = await db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
  if (existing) {
    await db
      .update(schema.integrationConnections)
      .set({ status: 'connected', accessTokenEncrypted: encrypted, lastError: null, config: sql`${schema.integrationConnections.config} - 'pendingIgUserId'`, updatedAt: new Date() })
      .where(eq(schema.integrationConnections.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await db.insert(schema.integrationConnections).values({ id, provider: 'meta', status: 'connected', accessTokenEncrypted: encrypted });
  return id;
}

/** Queues the read-only `social.check` for the Meta connection. */
export async function queueSocialCheck(reason: 'connect' | 'manual', connectionId: string | null): Promise<string> {
  const job = await createTrackedJob({ type: 'social.check', payload: { connectionId, reason }, projectId: null, singletonKey: `social-check:${connectionId ?? 'all'}` });
  return job.id;
}

/** POST /api/integrations/instagram/account (owner): the account ID the owner typed, checked by the read-only job. */
export async function setInstagramAccountId(igUserId: string, user: SessionUser): Promise<{ jobId: string }> {
  requireOwner(user);
  const db = getDb();
  const conn = await db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
  if (!conn || conn.status === 'disconnected' || !conn.accessTokenEncrypted) throw new AppError('CONFLICT', 'Connect Instagram first.');
  await db
    .update(schema.integrationConnections)
    .set({ config: sql`${schema.integrationConnections.config} || ${JSON.stringify({ pendingIgUserId: igUserId })}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.integrationConnections.id, conn.id));
  await writeAudit({ userId: user.id, action: 'integration.meta.account_id_entered', entityType: 'integration_connection', entityId: conn.id });
  return { jobId: await queueSocialCheck('manual', conn.id) };
}

/** POST /api/integrations/[provider]/check (owner): the read-only check. Never posts. */
export async function checkPublishingConnection(provider: string, user: SessionUser): Promise<{ jobId: string }> {
  requireOwner(user);
  if (provider !== 'meta' && provider !== 'instagram') throw new AppError('NOT_FOUND', 'There is no connection check for that service here.');
  const conn = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
  if (!conn || conn.status === 'disconnected' || !conn.accessTokenEncrypted) throw new AppError('CONFLICT', 'Connect Instagram first.');
  return { jobId: await queueSocialCheck('manual', conn.id) };
}

/**
 * DELETE /api/integrations/meta (owner): forgets the token, marks the accounts disconnected with direct publishing
 * off, and moves unsent automated Instagram destinations to "reconnect". Published posts stay on Instagram.
 */
export async function disconnectMeta(user: SessionUser): Promise<{ disconnected: boolean; targetsMoved: number }> {
  requireOwner(user);
  const db = getDb();
  const conn = await db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
  if (!conn) return { disconnected: false, targetsMoved: 0 };
  const moved = await db.transaction(async (tx) => {
    await tx.update(schema.integrationConnections).set({ status: 'disconnected', accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null, lastError: null, updatedAt: new Date() }).where(eq(schema.integrationConnections.id, conn.id));
    await tx.update(schema.socialAccounts).set({ status: 'disconnected', directPublishEnabled: false, updatedAt: new Date() }).where(eq(schema.socialAccounts.connectionId, conn.id));
    const rows = await tx
      .update(schema.publishTargets)
      .set({ status: 'manual_step_required', manualStep: 'reconnect_account', statusMessage: manualStepMessage('reconnect_account', 'instagram'), updatedAt: new Date() })
      .where(and(eq(schema.publishTargets.method, 'instagram_api'), eq(schema.publishTargets.status, 'queued'), isNull(schema.publishTargets.submittedAt)))
      .returning({ postId: schema.publishTargets.postId });
    for (const postId of new Set(rows.map((r) => r.postId))) await refreshPostStatus(tx, postId);
    return rows.length;
  });
  await writeAudit({ userId: user.id, action: 'integration.meta.disconnected', entityType: 'integration_connection', entityId: conn.id, data: { targetsMoved: moved } });
  return { disconnected: true, targetsMoved: moved };
}

// ---------------------------------------------------------------------------------------------
// Project deletion
// ---------------------------------------------------------------------------------------------

/**
 * Before a project is deleted: cancels its unsent destinations (anything without `submitted_at`) and deletes the
 * covers stored under `publishing/{postId}/` (they live outside the project's storage prefix). Returns files removed.
 */
export async function cleanUpProjectPosts(projectId: string): Promise<number> {
  const db = getDb();
  const posts = await db.select({ id: schema.publishPosts.id }).from(schema.publishPosts).where(eq(schema.publishPosts.projectId, projectId));
  if (posts.length === 0) return 0;
  const ids = posts.map((p) => p.id);
  await db
    .update(schema.publishTargets)
    .set({ status: 'cancelled', manualStep: null, statusMessage: 'Cancelled: the project was deleted', updatedAt: new Date() })
    .where(and(inArray(schema.publishTargets.postId, ids), isNull(schema.publishTargets.submittedAt), inArray(schema.publishTargets.status, ['queued', 'manual_step_required', 'failed'])));
  for (const id of ids) await refreshPostStatus(db, id);
  let removed = 0;
  const store = getBlobStore();
  for (const id of ids) {
    try {
      removed += await store.deletePrefix(`publishing/${id}/`);
    } catch (err) {
      getLogger().warn({ err, postId: id }, 'could not remove a publishing cover');
      throw err;
    }
  }
  return removed;
}
