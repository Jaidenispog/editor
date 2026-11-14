import { AudioPatchSchema, ExportVariantSchema, MusicLicenceInputSchema, SegmentLabelSchema, type SegmentLabel } from '@studio/core';
import { z } from 'zod';
import { latestMusicStart, type EnergyCurve } from './music-curve.js';

/**
 * Request bodies for the Video Studio API routes. Isomorphic (no server imports) so the browser can use the
 * same limits and the routes can be unit tested.
 */

/** POST /api/projects/[id]/uploads */
export const CreateUploadSchema = z.object({
  filename: z.string().trim().min(1, 'The file needs a name').max(255, 'The file name is too long'),
  size: z.number().int('The file size must be a whole number of bytes').positive('This file is empty'),
  mimeType: z.string().trim().max(120).default(''),
  kind: z.enum(['video', 'audio']),
});
export type CreateUploadInput = z.infer<typeof CreateUploadSchema>;

/** POST /api/uploads/[id]/complete — music uploads must carry the licence and the owner's confirmation. */
export const CompleteUploadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  artist: z.string().trim().max(160).optional(),
  moods: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  genres: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  /** The licence passport; CC BY-NC is refused and Meta Sound Collection tracks are locked to Meta destinations. */
  licence: MusicLicenceInputSchema.optional(),
  confirmLicence: z.boolean().optional(),
});
export type CompleteUploadInput = z.infer<typeof CompleteUploadSchema>;

/** PATCH /api/assets/[id] */
export const UpdateAssetSchema = z
  .object({
    clipLabel: SegmentLabelSchema.nullable(),
    manualLabels: z.record(z.string().min(1).max(100), SegmentLabelSchema),
    sortOrder: z.number().int().min(0).max(100_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateAssetInput = z.infer<typeof UpdateAssetSchema>;

/** POST /api/projects/[id]/assets/order — the clips in their new order (each id once). */
export const ReorderAssetsSchema = z.object({
  assetIds: z
    .array(z.string().min(1).max(100))
    .min(1, 'Send at least one clip')
    .max(500, 'Too many clips')
    .refine((ids) => new Set(ids).size === ids.length, 'Each clip can only appear once'),
});
export type ReorderAssetsInput = z.infer<typeof ReorderAssetsSchema>;

/** POST /api/music/uploads — a library music upload started from Settings (always audio). */
export const CreateLibraryUploadSchema = CreateUploadSchema.omit({ kind: true });
export type CreateLibraryUploadInput = z.infer<typeof CreateLibraryUploadSchema>;

/** POST /api/edits/[id]/favourite */
export const FavouriteSchema = z.object({ value: z.boolean() });

/**
 * POST /api/edits/[id]/revise: an instruction, a Sound panel change, or both. A sound change alone that needs no
 * re-cut keeps the cuts (fast path); anything else goes back to the planner.
 */
export const ReviseSchema = z
  .object({
    instruction: z.string().trim().min(2, 'Tell the editor what to change').max(500, 'Keep the instruction under 500 characters').optional(),
    audio: AudioPatchSchema.optional(),
  })
  .refine((v) => v.instruction !== undefined || v.audio !== undefined, { message: 'Tell the editor what to change', path: ['instruction'] });
export type ReviseInput = z.infer<typeof ReviseSchema>;

/** POST /api/edits/[id]/regenerate — an optional note is kept with the new version. */
export const RegenerateSchema = z.object({ instruction: z.string().trim().max(500).optional().default('') });

/** POST /api/edits/[id]/current-version */
export const CurrentVersionSchema = z.object({ versionId: z.string().min(1).max(100) });

/** Query for GET /api/edit-versions/[id]/download: the export (default), the music-free export or the preview. */
export const DownloadKindSchema = z.enum(['export', 'export_no_music', 'preview']).default('export');

/** Query for POST /api/edit-versions/[id]/export: which file to render (default the standard one). */
export const ExportVariantQuerySchema = ExportVariantSchema.default('standard');

/** The owner-facing "What's in this clip?" choices and the shot label each one stands for. */
export const CLIP_TAG_OPTIONS: ReadonlyArray<{ value: SegmentLabel | ''; label: string }> = [
  { value: '', label: 'Not sure' },
  { value: 'before', label: 'Before' },
  { value: 'cutting', label: 'Cutting' },
  { value: 'fade_detail', label: 'Fade detail' },
  { value: 'styling', label: 'Styling' },
  { value: 'result', label: 'Result' },
  { value: 'reaction', label: 'Reaction' },
  { value: 'environment', label: 'Shop' },
];

/** Friendly name for a shot label (used in clip summaries). */
export function clipTagName(label: string | null | undefined): string {
  if (!label) return 'Not sure';
  return CLIP_TAG_OPTIONS.find((o) => o.value === label)?.label ?? (label === 'other' ? 'Other' : 'Not sure');
}

/** Suggestion chips shown in the Revise dialog. */
export const REVISION_SUGGESTIONS = ['Show more of the fade', 'Make this 15 seconds', 'Remove the flashy transitions', 'Slower pacing', 'Less text'] as const;

// ---------------------------------------------------------------- Sound panel (isomorphic helpers)

/** Values the panel edits, compared with where they started to build the patch. */
export interface SoundState {
  track: string; // track id, or 'none'
  start: number;
  beatSync: boolean;
  reveal: boolean;
  volume: number; // 0–100
  fadeIn: number;
  fadeOut: number;
  duck: boolean;
  original: 'off' | 'under_music' | 'only';
  originalVolume: number; // 0–100
}

/**
 * The "Original sound" choices for a track. With no music, "Under the music" means nothing (it would make a version
 * identical to the current one), so only "Off" (a silent export) and "Original sound only" are offered. A choice
 * that is already selected stays listed so the radio group never loses its checked option.
 */
export function originalSoundChoices(track: string, selected?: SoundState['original']): Array<SoundState['original']> {
  if (track !== 'none' || selected === 'under_music') return ['off', 'under_music', 'only'];
  return ['off', 'only'];
}

/**
 * The panel state after choosing a track ('none' for no music). The song section restarts at 0 for a new track
 * (or returns to the saved one for the current track), and "Under the music" becomes "Original sound only" when the
 * music is taken away, which is what the owner hears in that case. Choosing a track again undoes that automatic
 * change, so "No music" and back never changes the original sound without the owner choosing it.
 */
export function withTrack(state: SoundState, track: string, from: SoundState | null): SoundState {
  const start = from && track === from.track ? from.start : 0;
  let original = state.original;
  if (track === 'none' && state.original === 'under_music') original = 'only';
  else if (track !== 'none' && state.track === 'none' && state.original === 'only' && from?.original === 'under_music') original = 'under_music';
  return { ...state, track, start, original };
}

/** The patch for the changes made in the panel (only the fields that changed). */
export function buildAudioPatch(from: SoundState, to: SoundState, keepCuts: boolean): Partial<z.infer<typeof AudioPatchSchema>> {
  const patch: Partial<z.infer<typeof AudioPatchSchema>> = {};
  const trackChanged = to.track !== from.track;
  if (to.track === 'none') {
    if (from.track !== 'none') patch.music = 'none';
  } else {
    if (trackChanged) patch.trackId = to.track;
    if (trackChanged ? to.start > 0 : Math.abs(to.start - from.start) > 0.05) {
      patch.startSec = Math.round(to.start * 1000) / 1000;
      patch.keepCuts = trackChanged ? false : keepCuts;
    }
    if (to.beatSync !== from.beatSync) patch.beatSync = to.beatSync ? 'on' : 'off';
    if (to.reveal !== from.reveal) patch.revealOnBeat = to.reveal ? 'on' : 'off';
    if (to.volume !== from.volume) patch.volume = to.volume / 100;
    if (Math.abs(to.fadeIn - from.fadeIn) > 0.01) patch.fadeInSec = to.fadeIn;
    if (Math.abs(to.fadeOut - from.fadeOut) > 0.01) patch.fadeOutSec = to.fadeOut;
    if (to.duck !== from.duck) patch.duckUnderOriginal = to.duck;
  }
  if (to.original !== from.original) patch.originalSound = to.original;
  if (to.originalVolume !== from.originalVolume && to.original !== 'off') patch.originalVolume = to.originalVolume / 100;
  return patch;
}

/** The start (seconds) of the loudest window of `windowSec` in the curve, or 0. */
export function strongestWindowStart(energy: EnergyCurve | null, trackSec: number, windowSec: number): number {
  if (!energy || energy.values.length === 0) return 0;
  const steps = Math.max(1, Math.round(windowSec / energy.stepSec));
  let best = 0;
  let bestSum = -1;
  let sum = 0;
  for (let i = 0; i < energy.values.length; i++) {
    sum += energy.values[i] ?? 0;
    if (i >= steps) sum -= energy.values[i - steps] ?? 0;
    const start = (i - steps + 1) * energy.stepSec;
    if (i >= steps - 1 && start + windowSec <= trackSec + 0.01 && sum > bestSum) {
      bestSum = sum;
      best = start;
    }
  }
  return Math.max(0, Math.min(best, latestMusicStart(trackSec, windowSec)));
}

