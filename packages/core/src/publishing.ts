import { z } from 'zod';
import type { AssetProbe } from './analysis.js';
import type { EditPlan } from './edit-plan.js';
import { ExportVariantSchema, type ExportVariant } from './jobs/music.js';
import { META_ONLY_LABEL, PLATFORM_NAMES, musicClearanceFor, normaliseLicence, type MusicLicence } from './music.js';
import { formatDateTime, melbourneLocalToUtc, melbourneZoneLabel } from './time.js';
import { computeTimeline } from './timeline.js';

/**
 * Publishing contracts (docs/design/publishing.md): who may post what where, Melbourne scheduling, captions, the
 * per-platform file check, post status derivation and the link patterns the owner may paste. Pure functions only,
 * shared by the web app (composer, API) and the worker (pre-publish re-check).
 */

/** Platforms the app posts to. (`facebook`, `youtube` and `website` are licence-coverage words only.) */
export const PUBLISH_TARGET_PLATFORMS = ['instagram', 'tiktok'] as const;
export const TargetPlatformSchema = z.enum(PUBLISH_TARGET_PLATFORMS);
export type TargetPlatform = z.infer<typeof TargetPlatformSchema>;

/** How a target is delivered: by the owner in the platform app, Instagram's Graph API, or Zernio (Stage C, WP10). */
export const PUBLISH_METHODS = ['manual', 'instagram_api', 'zernio'] as const;
export const PublishMethodSchema = z.enum(PUBLISH_METHODS);
export type PublishMethod = z.infer<typeof PublishMethodSchema>;

/** The file a target posts: the version as planned, or its music-free export of the same cuts. */
export type MediaVariant = ExportVariant;
export const MediaVariantSchema = ExportVariantSchema;

export const POST_MODES = ['now', 'scheduled', 'draft_handoff'] as const;
export const PostModeSchema = z.enum(POST_MODES);
export type PostMode = z.infer<typeof PostModeSchema>;

export const POST_STATUSES = ['draft', 'approved', 'in_progress', 'complete', 'partial', 'failed', 'cancelled'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const TARGET_STATUSES = ['queued', 'processing', 'published', 'failed', 'manual_step_required', 'cancelled'] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** What the owner has to do for a target in `manual_step_required`. */
export const MANUAL_STEPS = [
  'post_in_app',
  'finish_in_tiktok_app',
  'review_copyright_match',
  'check_before_retry',
  'music_licence_changed',
  'reconnect_account',
  'file_too_large_for_upload',
] as const;
export const ManualStepSchema = z.enum(MANUAL_STEPS);
export type ManualStep = z.infer<typeof ManualStepSchema>;

/** Plain names of the target platforms. */
export const TARGET_PLATFORM_NAMES: Record<TargetPlatform, string> = { instagram: 'Instagram', tiktok: 'TikTok' };

/** Instagram and TikTok caption limit, counted in graphemes (what a person sees as one character). */
export const CAPTION_MAX_GRAPHEMES = 2200;
/** A soft warning above this many hashtags (common Instagram guidance; never a block). */
export const CAPTION_HASHTAG_WARNING = 30;
/** Most videos in one compose action. */
export const MAX_VIDEOS_PER_BATCH = 5;
/** Earliest and latest schedule, relative to now. */
export const SCHEDULE_MIN_LEAD_MINUTES = 10;
export const SCHEDULE_MAX_DAYS_AHEAD = 90;
/** The resumable upload limit assumed until a larger file is proven (memo §4: 100 MB vs 300 MB unresolved). */
export const DEFAULT_RESUMABLE_MAX_BYTES = 104_857_600;

// ---------------------------------------------------------------------------------------------
// Eligibility (music rule, design §3.2)
// ---------------------------------------------------------------------------------------------

/** What may be posted to one platform. */
export interface PlatformEligibility {
  platform: TargetPlatform;
  /** Variants that may be posted to this platform. Order = recommendation. */
  allowedVariants: MediaVariant[];
  /** Whether an automated method (instagram_api / zernio) may post the standard file. */
  automationAllowedForStandard: boolean;
  /** Plain language, shown verbatim. */
  reasons: string[];
  /** e.g. "Add a Commercial Sound in the TikTok app if you want music." */
  manualStepHint: string | null;
  /** "For Instagram/Facebook upload only" for meta_only standard files. */
  downloadLabel: string | null;
}

/** Inputs of {@link checkPublishEligibility}. */
export interface PublishEligibilityInput {
  hasMusic: boolean;
  /** null when hasMusic is false, or the track was deleted (treated as unknown). */
  licence: MusicLicence | null;
  originalSoundEnabled: boolean;
  platforms: TargetPlatform[];
  now?: Date;
}

/** Result of {@link checkPublishEligibility}. */
export interface PublishEligibility {
  perPlatform: PlatformEligibility[];
  /** Credit line every caption must end with (CC BY), or null. */
  captionSuffix: string | null;
  /** The licence as checked (usage-ledger snapshot), or null without music. */
  licenceSnapshot: MusicLicence | null;
  /** Non-blocking notes (e.g. the original-sound copyright note). */
  notes: string[];
}

export const REMOVED_TRACK_REASON = "The music track was removed, so its licence can't be checked.";
export const META_ONLY_TIKTOK_REASON = "This track is from Meta's Sound Collection, which is licensed for Instagram and Facebook only.";
export const ORIGINAL_SOUND_NOTE = "The video keeps the sound recorded in the shop. If music was playing while you filmed, Instagram's copyright check may flag it.";
export const MANUAL_MUSIC_HINTS: Record<TargetPlatform, string> = {
  tiktok: 'Add a Commercial Sound in the TikTok app if you want music.',
  instagram: 'Add music in the Instagram app if you want it. Reels published by Studio Assistant can only carry the sound already in the video.',
};

/**
 * Decides, per platform, which file may be posted and whether an automated method may post the standard file.
 * Built on `musicClearanceFor` (the licence passport): an unconfirmed, non-promotional, expired or unknown licence
 * blocks every platform; a platform the licence does not tick gets only the music-free file; Meta Sound Collection
 * music never goes to TikTok, and its Instagram standard file is labelled.
 */
export function checkPublishEligibility(input: PublishEligibilityInput): PublishEligibility {
  const notes = input.originalSoundEnabled ? [ORIGINAL_SOUND_NOTE] : [];
  if (!input.hasMusic) {
    return {
      perPlatform: input.platforms.map((platform) => ({ platform, allowedVariants: ['standard'], automationAllowedForStandard: true, reasons: [], manualStepHint: null, downloadLabel: null })),
      captionSuffix: null,
      licenceSnapshot: null,
      notes,
    };
  }
  const onlyNoMusic = (platform: TargetPlatform, reasons: string[]): PlatformEligibility => ({
    platform,
    allowedVariants: ['no_music'],
    automationAllowedForStandard: false,
    reasons,
    manualStepHint: MANUAL_MUSIC_HINTS[platform],
    downloadLabel: null,
  });
  if (!input.licence) {
    return { perPlatform: input.platforms.map((p) => onlyNoMusic(p, [REMOVED_TRACK_REASON])), captionSuffix: null, licenceSnapshot: null, notes };
  }
  const licence = normaliseLicence(input.licence);
  const clearance = musicClearanceFor(licence, input.now);
  const metaOnly = licence.destinationLock === 'meta_only';
  const perPlatform = input.platforms.map((platform): PlatformEligibility => {
    if (clearance.state === 'blocked') return onlyNoMusic(platform, clearance.reasons);
    if (metaOnly && platform === 'tiktok') return onlyNoMusic(platform, [META_ONLY_TIKTOK_REASON]);
    if (!clearance.platforms.includes(platform)) return onlyNoMusic(platform, [`The music licence doesn't cover ${PLATFORM_NAMES[platform]}.`]);
    return {
      platform,
      allowedVariants: ['standard', 'no_music'],
      automationAllowedForStandard: true,
      reasons: [],
      manualStepHint: null,
      downloadLabel: metaOnly ? META_ONLY_LABEL : null,
    };
  });
  return { perPlatform, captionSuffix: clearance.attributionText, licenceSnapshot: licence, notes };
}

/** Why a method/variant pair is not allowed for a platform, or null when it is. */
export function methodVariantRefusal(e: PlatformEligibility, method: PublishMethod, variant: MediaVariant): string | null {
  if (!e.allowedVariants.includes(variant)) {
    const why = e.reasons[0] ?? "The music licence doesn't cover this.";
    return `${TARGET_PLATFORM_NAMES[e.platform]} can only get the version without music: ${why}`;
  }
  if (method !== 'manual' && variant === 'standard' && !e.automationAllowedForStandard) {
    return `Can't publish automatically: the music licence doesn't cover ${TARGET_PLATFORM_NAMES[e.platform]}. Post without music, or post it yourself.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------------

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/** Number of graphemes (user-perceived characters; one emoji counts once). */
export function graphemeCount(text: string): number {
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Number of hashtags in a caption. */
export function hashtagCount(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** The caption with the locked credit line appended exactly once (on its own paragraph). */
export function composeCaption(caption: string, suffix: string | null): string {
  const body = caption.replace(/\s+$/u, '');
  if (!suffix) return body;
  const s = suffix.trim();
  if (!s) return body;
  if (body.endsWith(s)) return body;
  return body ? `${body}\n\n${s}` : s;
}

/** Result of {@link validateCaption}. */
export interface CaptionCheck {
  ok: boolean;
  /** The caption as it will be posted, credit line included. */
  finalCaption: string;
  length: number;
  hashtags: number;
  /** Blocking problems. */
  errors: string[];
  /** Warnings only. */
  warnings: string[];
}

/** Checks a caption (with its credit line) against the 2,200-character limit and the hashtag guidance. */
export function validateCaption(caption: string, suffix: string | null): CaptionCheck {
  const finalCaption = composeCaption(caption, suffix);
  const length = graphemeCount(finalCaption);
  const hashtags = hashtagCount(finalCaption);
  const errors = length > CAPTION_MAX_GRAPHEMES ? [`The caption is ${length.toLocaleString('en-AU')} characters; Instagram and TikTok allow ${CAPTION_MAX_GRAPHEMES.toLocaleString('en-AU')}.`] : [];
  const warnings = hashtags > CAPTION_HASHTAG_WARNING ? [`${hashtags} hashtags: Instagram may hide posts with more than ${CAPTION_HASHTAG_WARNING}.`] : [];
  return { ok: errors.length === 0, finalCaption, length, hashtags, errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// Scheduling (Melbourne time, design §4.3)
// ---------------------------------------------------------------------------------------------

export const ScheduleInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-15'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Use a time like 10:30'),
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/** A resolved schedule, or the plain reason it cannot be used. */
export type ResolvedSchedule = { ok: true; instant: Date; ambiguous: boolean; label: string } | { ok: false; message: string };

/** "Sat 15 Nov 2026, 10:00 am AEDT" (with "(the first …)" for the repeated hour in April). */
export function melbourneScheduleLabel(instant: Date, ambiguous = false): string {
  const text = formatDateTime(instant, { dateStyle: undefined, timeStyle: undefined, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${text} ${melbourneZoneLabel(instant)}${ambiguous ? ' (the first time the clock shows this)' : ''}`;
}

/**
 * Turns the composer's Melbourne date and time into a UTC instant and checks the window (at least 10 minutes and at
 * most 90 days ahead). Runs in the browser for instant feedback and again on the server.
 */
export function resolveSchedule(input: ScheduleInput, now: Date = new Date()): ResolvedSchedule {
  const local = melbourneLocalToUtc(input.date, input.time);
  if (!local.ok) {
    return local.reason === 'nonexistent'
      ? { ok: false, message: "That time doesn't exist in Melbourne: the clocks go forward from 2:00 am to 3:00 am that night. Choose another time." }
      : { ok: false, message: 'Enter a real date and time.' };
  }
  const lead = local.instant.getTime() - now.getTime();
  if (lead < SCHEDULE_MIN_LEAD_MINUTES * 60_000) return { ok: false, message: `Choose a time at least ${SCHEDULE_MIN_LEAD_MINUTES} minutes from now.` };
  if (lead > SCHEDULE_MAX_DAYS_AHEAD * 86_400_000) return { ok: false, message: `Choose a time within the next ${SCHEDULE_MAX_DAYS_AHEAD} days.` };
  return { ok: true, instant: local.instant, ambiguous: local.ambiguous, label: melbourneScheduleLabel(local.instant, local.ambiguous) };
}

// ---------------------------------------------------------------------------------------------
// Request contracts (API)
// ---------------------------------------------------------------------------------------------

export const PublishTargetInputSchema = z.object({
  platform: TargetPlatformSchema,
  method: PublishMethodSchema,
  delivery: z.enum(['publish', 'draft']).default('publish'),
  variant: MediaVariantSchema,
});
export type PublishTargetInput = z.infer<typeof PublishTargetInputSchema>;

export const CreatePublishPostItemSchema = z
  .object({
    editVersionId: z.string().min(1).max(64),
    caption: z.string().max(10_000),
    coverTimeSec: z.number().finite().min(0).max(600),
    mode: PostModeSchema,
    schedule: ScheduleInputSchema.optional(),
    targets: z.array(PublishTargetInputSchema).min(1).max(2),
  })
  .superRefine((item, ctx) => {
    const platforms = item.targets.map((t) => t.platform);
    if (new Set(platforms).size !== platforms.length) ctx.addIssue({ code: 'custom', message: 'Choose each platform once.', path: ['targets'] });
    if (item.mode === 'scheduled' && !item.schedule) ctx.addIssue({ code: 'custom', message: 'Choose a date and time.', path: ['schedule'] });
    if (item.mode === 'draft_handoff' && item.targets.some((t) => t.method !== 'manual')) {
      ctx.addIssue({ code: 'custom', message: 'Prepare for manual posting needs every destination set to "Post it yourself".', path: ['targets'] });
    }
  });
export type CreatePublishPostItem = z.infer<typeof CreatePublishPostItemSchema>;

export const CreatePublishPostsSchema = z.object({
  items: z.array(CreatePublishPostItemSchema).min(1, 'Choose at least one video.').max(MAX_VIDEOS_PER_BATCH, `At most ${MAX_VIDEOS_PER_BATCH} videos at a time.`),
  allowRepeat: z.boolean().default(false),
});
export type CreatePublishPosts = z.infer<typeof CreatePublishPostsSchema>;

export const ApprovePublishPostsSchema = z.object({
  postIds: z.array(z.string().min(1).max(64)).min(1).max(20),
  consent: z.object({ tiktokPublic: z.boolean() }).optional(),
});

export const PatchPublishPostSchema = z
  .object({
    caption: z.string().max(10_000).optional(),
    coverTimeSec: z.number().finite().min(0).max(600).optional(),
    schedule: ScheduleInputSchema.optional(),
    targets: z.array(PublishTargetInputSchema).min(1).max(2).optional(),
  })
  .strict();

export const ConfirmPostedSchema = z.object({ url: z.string().max(500).optional() });

export const RESOLVE_ACTIONS = ['post_without_music', 'post_manually', 'retry_anyway', 'mark_posted'] as const;
export const ResolveTargetSchema = z.object({ action: z.enum(RESOLVE_ACTIONS) });
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

// ---------------------------------------------------------------------------------------------
// File check (design §6.2)
// ---------------------------------------------------------------------------------------------

/** One reason a file may be refused by a platform. */
export interface MediaIssue {
  code: string;
  message: string;
}

/** Result of {@link checkMediaForPlatform}. */
export interface MediaCheck {
  ok: boolean;
  issues: MediaIssue[];
  /** Set when the file only fails the direct-upload size cap (the owner can still post it by hand). */
  manualStep: ManualStep | null;
}

const MB = 1024 * 1024;
const containerIs = (container: string, names: string[]) => container.toLowerCase().split(',').some((c) => names.includes(c.trim()));

/**
 * Checks an export's ffprobe facts against a platform's published limits (memo §3 and §4: Reels MP4/MOV,
 * H.264/HEVC, 23–60 fps, ≤ 1920 columns, ≤ 25 Mbps, AAC ≤ 48 kHz and ≤ 128 kbps, 3 s–15 min, ≤ 300 MB; TikTok
 * MP4/MOV/WebM, H.264/H.265/VP8/VP9, 23–60 fps, 360–4096 px, 3 s–10 min, ≤ 4 GB). For `instagram_api` the size must
 * also fit the resumable upload cap; failing only that gives the manual step `file_too_large_for_upload`. A guard,
 * not a transcode: the Stage A export preset already targets these values.
 */
export function checkMediaForPlatform(
  probe: Pick<AssetProbe, 'container' | 'durationSec' | 'video' | 'audio'>,
  byteSize: number,
  platform: TargetPlatform,
  options: { method?: PublishMethod; resumableMaxBytes?: number } = {},
): MediaCheck {
  const issues: MediaIssue[] = [];
  const name = TARGET_PLATFORM_NAMES[platform];
  const v = probe.video;
  const d = probe.durationSec;
  const add = (code: string, message: string) => issues.push({ code, message: `${name} may reject this file: ${message}` });
  if (!v) add('no_video', 'it has no video stream.');
  if (platform === 'instagram') {
    if (!containerIs(probe.container, ['mp4', 'mov'])) add('container', 'Reels must be MP4 or MOV.');
    if (v && !['h264', 'hevc'].includes(v.codec)) add('codec', `the video is ${v.codec}; Reels need H.264 or HEVC.`);
    if (v && (v.fps < 23 || v.fps > 60)) add('fps', `${Math.round(v.fps)} frames per second is outside 23–60.`);
    if (v && v.displayWidth > 1920) add('width', `${v.displayWidth} px wide is more than 1920.`);
    if (v?.bitrate && v.bitrate > 25_000_000) add('bitrate', `the video bitrate is above 25 Mbps.`);
    if (probe.audio) {
      if (probe.audio.codec !== 'aac') add('audio_codec', `the sound is ${probe.audio.codec}; Reels need AAC.`);
      if (probe.audio.sampleRate > 48_000) add('audio_rate', 'the sound is above 48 kHz.');
      if (probe.audio.bitrate && probe.audio.bitrate > 128_000 * 1.05) add('audio_bitrate', 'the sound bitrate is above 128 kbps.');
    }
    if (d < 3) add('too_short', 'Reels must be at least 3 seconds long.');
    if (d > 900) add('too_long', 'Reels must be at most 15 minutes long.');
    if (byteSize > 300 * MB) add('too_large', 'Reels must be 300 MB or smaller.');
  } else {
    if (!containerIs(probe.container, ['mp4', 'mov', 'webm'])) add('container', 'TikTok takes MP4, MOV or WebM.');
    if (v && !['h264', 'hevc', 'h265', 'vp8', 'vp9'].includes(v.codec)) add('codec', `the video is ${v.codec}; TikTok takes H.264, H.265, VP8 or VP9.`);
    if (v && (v.fps < 23 || v.fps > 60)) add('fps', `${Math.round(v.fps)} frames per second is outside 23–60.`);
    if (v && (Math.min(v.displayWidth, v.displayHeight) < 360 || Math.max(v.displayWidth, v.displayHeight) > 4096)) add('size', 'each side must be 360–4096 px.');
    if (d < 3) add('too_short', 'TikTok videos must be at least 3 seconds long.');
    if (d > 600) add('too_long', 'TikTok videos must be at most 10 minutes long.');
    if (byteSize > 4 * 1024 * MB) add('too_large', 'TikTok videos must be 4 GB or smaller.');
  }
  let manualStep: ManualStep | null = null;
  if (issues.length === 0 && platform === 'instagram' && options.method === 'instagram_api') {
    const cap = options.resumableMaxBytes ?? DEFAULT_RESUMABLE_MAX_BYTES;
    if (byteSize > cap) {
      manualStep = 'file_too_large_for_upload';
      issues.push({ code: 'upload_cap', message: `This file is ${Math.ceil(byteSize / MB)} MB; direct upload to Instagram is limited to ${Math.floor(cap / MB)} MB for now. Post it yourself instead.` });
    }
  }
  return { ok: issues.length === 0, issues, manualStep };
}

// ---------------------------------------------------------------------------------------------
// Status derivation (design §5.1)
// ---------------------------------------------------------------------------------------------

/**
 * The post-level status from its targets. Drafts stay `draft` until approved. A manual target waiting for the owner
 * counts as "waiting on owner", never as failed, and a failed target never undoes a published one.
 */
export function derivePostStatus(approved: boolean, targets: ReadonlyArray<{ status: TargetStatus }>): PostStatus {
  if (!approved) return 'draft';
  const n = targets.length;
  const count = (s: TargetStatus) => targets.filter((t) => t.status === s).length;
  const published = count('published');
  const queued = count('queued');
  if (n === 0) return 'approved';
  if (count('cancelled') === n) return 'cancelled';
  if (published === n) return 'complete';
  if (count('processing') > 0) return 'in_progress';
  if (queued > 0) return queued === n ? 'approved' : 'in_progress';
  if (published > 0) return 'partial';
  if (count('manual_step_required') > 0) return 'in_progress';
  return count('failed') > 0 ? 'failed' : 'cancelled';
}

/** The post's one-line summary for lists. */
export function postStatusMessage(status: PostStatus, targets: ReadonlyArray<{ status: TargetStatus }>): string {
  const published = targets.filter((t) => t.status === 'published').length;
  const waiting = targets.filter((t) => t.status === 'manual_step_required').length;
  switch (status) {
    case 'draft':
      return 'Draft: not approved yet';
    case 'approved':
      return 'Approved';
    case 'complete':
      return 'Posted everywhere';
    case 'partial':
      return `Partly posted (${published} of ${targets.length})`;
    case 'failed':
      return 'Not posted';
    case 'cancelled':
      return 'Cancelled before posting';
    default:
      return waiting > 0 ? (waiting === 1 ? 'Waiting for you on 1 destination' : `Waiting for you on ${waiting} destinations`) : 'In progress';
  }
}

/** The plain message for a manual step. */
export function manualStepMessage(step: ManualStep, platform: TargetPlatform): string {
  const name = TARGET_PLATFORM_NAMES[platform];
  switch (step) {
    case 'post_in_app':
      return `Post this in the ${name} app, then tap "I've posted it".`;
    case 'finish_in_tiktok_app':
      return 'Sent to your TikTok drafts. Open TikTok, add a sound if you like, and post.';
    case 'review_copyright_match':
      return 'Instagram found copyrighted audio. Nothing was posted.';
    case 'check_before_retry':
      return `We can't tell whether ${name} received this. Check your ${name} profile first.`;
    case 'music_licence_changed':
      return `The music licence no longer covers ${name}. Nothing was posted.`;
    case 'reconnect_account':
      return `Reconnect ${name} in Settings to post this, or post it yourself.`;
    case 'file_too_large_for_upload':
      return `This file is too large to upload to ${name} directly. Post it yourself instead.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Target actions (DTO)
// ---------------------------------------------------------------------------------------------

export const TARGET_ACTIONS = ['retry', 'cancel', 'confirm', 'undo', 'post_without_music', 'post_manually', 'retry_anyway', 'download'] as const;
export type TargetAction = (typeof TARGET_ACTIONS)[number];

/** Facts that decide which buttons a target card shows. */
export interface TargetActionFacts {
  status: TargetStatus;
  method: PublishMethod;
  manualStep: ManualStep | null;
  variant: MediaVariant;
  submittedAt: Date | string | null;
  publishedUrl: string | null;
  confirmedAt: Date | string | null;
  mediaReady: boolean;
  /** Failed targets are retryable unless the platform said the failure is permanent. */
  retryable: boolean;
}

/** The actions allowed on a target in its current state (the API enforces the same rules). */
export function targetActionsFor(t: TargetActionFacts): TargetAction[] {
  const out: TargetAction[] = [];
  const unsent = !t.submittedAt;
  if (t.mediaReady && (t.method === 'manual' || t.status === 'manual_step_required' || t.status === 'failed')) out.push('download');
  switch (t.status) {
    case 'queued':
      if (unsent) out.push('cancel');
      break;
    case 'manual_step_required':
      switch (t.manualStep) {
        case 'post_in_app':
        case 'finish_in_tiktok_app':
          out.push('confirm', 'cancel');
          break;
        case 'check_before_retry':
          out.push('confirm', 'retry_anyway');
          break;
        case 'review_copyright_match':
        case 'music_licence_changed':
          if (t.variant === 'standard') out.push('post_without_music');
          out.push('post_manually', 'cancel');
          break;
        default:
          out.push('post_manually', 'cancel');
      }
      break;
    case 'failed':
      if (t.retryable) out.push('retry');
      out.push('post_manually');
      break;
    case 'published':
      if (t.confirmedAt) out.push('undo');
      if (!t.publishedUrl) out.push('confirm');
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Links the owner pastes (design §4.4)
// ---------------------------------------------------------------------------------------------

/**
 * The canonical link for a post the owner pasted, or null when it is not a link to a post on that platform.
 * Only exact platform hosts are accepted (no lookalikes); query strings and fragments are dropped.
 */
export function validatePostLink(platform: TargetPlatform, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  if (platform === 'instagram') {
    if (host !== 'www.instagram.com' && host !== 'instagram.com') return null;
    const m = /^\/(reel|reels|p)\/([A-Za-z0-9_-]{5,64})$/.exec(path);
    return m ? `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/` : null;
  }
  if (host === 'www.tiktok.com' || host === 'tiktok.com') {
    const m = /^\/@([A-Za-z0-9._]{1,40})\/video\/(\d{5,25})$/.exec(path);
    return m ? `https://www.tiktok.com/@${m[1]}/video/${m[2]}` : null;
  }
  if (host === 'vm.tiktok.com') {
    const m = /^\/([A-Za-z0-9]{5,20})$/.exec(path);
    return m ? `https://vm.tiktok.com/${m[1]}/` : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Covers and polling
// ---------------------------------------------------------------------------------------------

/** The default cover frame: the middle of the last segment, usually the finished result (nothing invented). */
export function defaultCoverTimeSec(plan: Pick<EditPlan, 'segments'> | null): number {
  if (!plan || plan.segments.length === 0) return 0;
  const timeline = computeTimeline(plan);
  const last = timeline.segments[timeline.segments.length - 1];
  if (!last) return 0;
  return Math.round(((last.startSec + last.endSec) / 2) * 1000) / 1000;
}

/** Containers expire after 24 hours (memo §4); polling stops then. */
export const INSTAGRAM_CONTAINER_LIFETIME_SEC = 24 * 3600;

/**
 * Seconds until the next Instagram container poll: every 60 s for the first five, then every 5 minutes until the
 * container is 24 hours old (null = stop polling).
 */
export function instagramPollDelaySeconds(pollNo: number, containerAgeSec: number): number | null {
  const delay = pollNo < 5 ? 60 : 300;
  return containerAgeSec + delay > INSTAGRAM_CONTAINER_LIFETIME_SEC ? null : delay;
}

/** Instagram's account-ID form accepts digits only. */
export const InstagramAccountIdSchema = z.object({ igUserId: z.string().regex(/^\d{5,30}$/, 'An Instagram account ID is 5 to 30 digits.') });
