import {
  MAX_VIDEOS_PER_BATCH,
  composeCaption,
  resolveSchedule,
  validateCaption,
  type MediaVariant,
  type PostMode,
  type PublishMethod,
  type ScheduleInput,
  type TargetPlatform,
} from '@studio/core';
import type { EligibilityItemDto, MethodOption } from '@/lib/shared/publishing-dto';

/**
 * Pure state of the publishing composer (no React), so its rules are unit tested: it starts with only the videos the
 * owner chose, every platform switch starts off, at most five videos, the variant follows the music rule, and the
 * request it builds is exactly what the review step shows.
 */

/** One destination as the owner sets it up. */
export interface DestinationDraft {
  enabled: boolean;
  method: PublishMethod;
  variant: MediaVariant;
}

/** One video row. */
export interface VideoDraft {
  versionId: string;
  caption: string;
  coverTimeSec: number;
  mode: PostMode;
  schedule: ScheduleInput;
  destinations: Record<TargetPlatform, DestinationDraft>;
  allowRepeat: boolean;
}

/** The variant to use first for a platform (the recommendation order of the eligibility result). */
export function defaultVariant(item: EligibilityItemDto, platform: TargetPlatform): MediaVariant {
  return item.eligibility.find((e) => e.platform === platform)?.allowedVariants[0] ?? 'no_music';
}

/** The first available method for a platform: direct publishing when switched on, otherwise "Post it yourself". */
export function defaultMethod(item: EligibilityItemDto, platform: TargetPlatform): PublishMethod {
  const options = item.methods[platform];
  return options.find((o) => o.available && o.method !== 'manual' && !o.isVerification)?.method ?? 'manual';
}

/** A Melbourne date and time an hour from now, rounded up to the next quarter hour. */
export function suggestedSchedule(now: Date = new Date()): ScheduleInput {
  const t = new Date(Math.ceil((now.getTime() + 3600_000) / 900_000) * 900_000);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t)) parts[p.type] = p.value;
  return { date: `${parts['year']}-${parts['month']}-${parts['day']}`, time: `${parts['hour']}:${parts['minute']}` };
}

/** A fresh row for a chosen video: caption = the saved caption ending, cover = default, both switches off. */
export function initialDraft(item: EligibilityItemDto, captionFooter: string, now: Date = new Date()): VideoDraft {
  return {
    versionId: item.versionId,
    caption: captionFooter,
    coverTimeSec: item.defaultCoverTimeSec,
    mode: 'now',
    schedule: suggestedSchedule(now),
    destinations: {
      instagram: { enabled: false, method: defaultMethod(item, 'instagram'), variant: defaultVariant(item, 'instagram') },
      tiktok: { enabled: false, method: 'manual', variant: defaultVariant(item, 'tiktok') },
    },
    allowRepeat: false,
  };
}

/** Adds a video unless it is already there or the batch is full (5). */
export function addVideo(list: string[], versionId: string): string[] {
  if (list.includes(versionId) || list.length >= MAX_VIDEOS_PER_BATCH) return list;
  return [...list, versionId];
}

/** The chosen method option, if it exists. */
export function methodOption(item: EligibilityItemDto, platform: TargetPlatform, method: PublishMethod): MethodOption | undefined {
  return item.methods[platform].find((o) => o.method === method);
}

/** Problems that stop a row from going to review (plain sentences). */
export function draftProblems(item: EligibilityItemDto, d: VideoDraft, now: Date = new Date()): string[] {
  const out: string[] = [];
  const enabled = (Object.keys(d.destinations) as TargetPlatform[]).filter((p) => d.destinations[p].enabled);
  if (enabled.length === 0) out.push('Choose at least one place to post this video.');
  const caption = validateCaption(d.caption, item.captionSuffix);
  out.push(...caption.errors);
  for (const p of enabled) {
    const dest = d.destinations[p];
    const option = methodOption(item, p, dest.method);
    if (!option?.available) out.push(option?.reason ?? 'That way of posting is not available.');
    const e = item.eligibility.find((x) => x.platform === p);
    if (e && !e.allowedVariants.includes(dest.variant)) out.push(e.reasons[0] ?? 'That file is not allowed here.');
    const prior = item.priorTargets.find((t) => t.platform === p);
    if (prior && !d.allowRepeat) out.push('This video was already posted there. Tick "Post again" to make a second post.');
  }
  if (d.mode === 'scheduled') {
    const r = resolveSchedule(d.schedule, now);
    if (!r.ok) out.push(r.message);
  }
  if (d.mode === 'draft_handoff' && enabled.some((p) => d.destinations[p].method !== 'manual')) out.push('Prepare for manual posting needs every destination set to "Post it yourself".');
  return out;
}

/** The body of POST /api/publish-posts for the rows. */
export function buildCreateRequest(drafts: VideoDraft[]): { items: Array<Record<string, unknown>>; allowRepeat: boolean } {
  return {
    allowRepeat: drafts.some((d) => d.allowRepeat),
    items: drafts.map((d) => ({
      editVersionId: d.versionId,
      caption: d.caption,
      coverTimeSec: d.coverTimeSec,
      mode: d.mode,
      ...(d.mode === 'scheduled' ? { schedule: d.schedule } : {}),
      targets: (Object.keys(d.destinations) as TargetPlatform[])
        .filter((p) => d.destinations[p].enabled)
        .map((p) => ({ platform: p, method: d.destinations[p].method, delivery: 'publish', variant: d.destinations[p].variant })),
    })),
  };
}

/** The caption as it will be posted (credit line locked at the end). */
export function previewCaption(item: EligibilityItemDto, d: VideoDraft): string {
  return composeCaption(d.caption, item.captionSuffix);
}
