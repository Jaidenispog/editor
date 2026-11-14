import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Stage A (Video Studio) job types. */
export const STUDIO_JOB_TYPES = {
  INGEST_ASSET: 'ingest.asset',
  GENERATE_EDITS: 'edits.generate',
  REVISE_EDIT: 'edits.revise',
  RENDER_PREVIEW: 'render.preview',
  RENDER_EXPORT: 'render.export',
  ANALYSE_MUSIC: 'music.analyse',
  CLEANUP: 'maintenance.cleanup',
} as const;

export const IngestAssetPayloadSchema = z.object({ assetId: z.string(), projectId: z.string() });
export const GenerateEditsPayloadSchema = z.object({ generationId: z.string(), projectId: z.string() });
export const ReviseEditPayloadSchema = z.object({
  editId: z.string(),
  projectId: z.string(),
  newVersionId: z.string(),
  mode: z.enum(['revise', 'regenerate']),
});
export const RenderPreviewPayloadSchema = z.object({ editVersionId: z.string(), projectId: z.string() });
export const RenderExportPayloadSchema = z.object({ editVersionId: z.string(), projectId: z.string() });
export const AnalyseMusicPayloadSchema = z.object({ trackId: z.string() });
export const CleanupPayloadSchema = z.object({ olderThanHours: z.number().positive().default(24) });

/** Payload schemas of the Stage A job types. */
export const STUDIO_JOB_PAYLOAD_SCHEMAS = {
  [STUDIO_JOB_TYPES.INGEST_ASSET]: IngestAssetPayloadSchema,
  [STUDIO_JOB_TYPES.GENERATE_EDITS]: GenerateEditsPayloadSchema,
  [STUDIO_JOB_TYPES.REVISE_EDIT]: ReviseEditPayloadSchema,
  [STUDIO_JOB_TYPES.RENDER_PREVIEW]: RenderPreviewPayloadSchema,
  [STUDIO_JOB_TYPES.RENDER_EXPORT]: RenderExportPayloadSchema,
  [STUDIO_JOB_TYPES.ANALYSE_MUSIC]: AnalyseMusicPayloadSchema,
  [STUDIO_JOB_TYPES.CLEANUP]: CleanupPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
