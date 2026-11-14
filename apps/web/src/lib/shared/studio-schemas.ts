import { MusicLicenceSchema, SegmentLabelSchema, type SegmentLabel } from '@studio/core';
import { z } from 'zod';

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
  licence: MusicLicenceSchema.optional(),
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

/** POST /api/edits/[id]/favourite */
export const FavouriteSchema = z.object({ value: z.boolean() });

/** POST /api/edits/[id]/revise */
export const ReviseSchema = z.object({
  instruction: z.string().trim().min(2, 'Tell the editor what to change').max(500, 'Keep the instruction under 500 characters'),
});

/** POST /api/edits/[id]/regenerate — an optional note is kept with the new version. */
export const RegenerateSchema = z.object({ instruction: z.string().trim().max(500).optional().default('') });

/** POST /api/edits/[id]/current-version */
export const CurrentVersionSchema = z.object({ versionId: z.string().min(1).max(100) });

/** Query for GET /api/edit-versions/[id]/download */
export const DownloadKindSchema = z.enum(['export', 'preview']).default('export');

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
