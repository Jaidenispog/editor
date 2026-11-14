import { z } from 'zod';
import { AudioPatchSchema } from '../audio-patch.js';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the music controls and licence passport module (it adds none; it extends two Stage A payloads). */
export const MUSIC_JOB_TYPES = {} as const;

/** Export variants of one version: `standard` (as planned) or `no_music` (same cuts, music removed). */
export const EXPORT_VARIANTS = ['standard', 'no_music'] as const;
export const ExportVariantSchema = z.enum(EXPORT_VARIANTS);
export type ExportVariant = z.infer<typeof ExportVariantSchema>;

/**
 * `edits.revise` with the Sound panel: `mode: 'audio'` applies an audio patch to the parent plan without re-cutting;
 * `mode: 'revise'` may carry a patch that needs a re-cut (new track, beat options, new song section). Backwards
 * compatible with queued Stage A payloads.
 */
export const ReviseEditPayloadWithAudioSchema = z.object({
  editId: z.string(),
  projectId: z.string(),
  newVersionId: z.string(),
  mode: z.enum(['revise', 'regenerate', 'audio']),
  audio: AudioPatchSchema.optional(),
});

/** `render.export` with a variant (default `standard`, so queued Stage A payloads still parse). */
export const RenderExportPayloadWithVariantSchema = z.object({
  editVersionId: z.string(),
  projectId: z.string(),
  variant: ExportVariantSchema.default('standard'),
});

/** Payload schemas of the music module: backwards-compatible extensions of `edits.revise` and `render.export`. */
export const MUSIC_JOB_PAYLOAD_SCHEMAS = {
  'edits.revise': ReviseEditPayloadWithAudioSchema,
  'render.export': RenderExportPayloadWithVariantSchema,
} as const satisfies JobPayloadSchemaMap;
