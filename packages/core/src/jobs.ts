import { z } from 'zod';
import { StyleIdSchema } from './styles.js';

export const JOB_TYPES = {
  INGEST_ASSET: 'ingest.asset',
  GENERATE_EDITS: 'edits.generate',
  REVISE_EDIT: 'edits.revise',
  RENDER_PREVIEW: 'render.preview',
  RENDER_EXPORT: 'render.export',
  ANALYSE_MUSIC: 'music.analyse',
  CLEANUP: 'maintenance.cleanup',
} as const;
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];
export const ALL_JOB_TYPES: JobType[] = Object.values(JOB_TYPES);

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

export const JOB_PAYLOAD_SCHEMAS = {
  [JOB_TYPES.INGEST_ASSET]: IngestAssetPayloadSchema,
  [JOB_TYPES.GENERATE_EDITS]: GenerateEditsPayloadSchema,
  [JOB_TYPES.REVISE_EDIT]: ReviseEditPayloadSchema,
  [JOB_TYPES.RENDER_PREVIEW]: RenderPreviewPayloadSchema,
  [JOB_TYPES.RENDER_EXPORT]: RenderExportPayloadSchema,
  [JOB_TYPES.ANALYSE_MUSIC]: AnalyseMusicPayloadSchema,
  [JOB_TYPES.CLEANUP]: CleanupPayloadSchema,
} as const;

export type JobPayload<T extends JobType> = z.infer<(typeof JOB_PAYLOAD_SCHEMAS)[T]>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Settings the owner chooses before pressing "Generate 5 edits". */
export const GenerationSettingsSchema = z.object({
  durationSec: z.number().int().min(8).max(90).default(25),
  styles: z.array(StyleIdSchema).min(1).max(5),
  musicTrackId: z.string().nullable().default(null),
  keepOriginalSound: z.enum(['auto', 'always', 'never']).default('auto'),
  captions: z.enum(['auto', 'never']).default('auto'),
  instructions: z.string().max(1000).default(''),
  /**
   * Where in the chosen track the music starts, in seconds. Null lets the editor choose (automatic). Only
   * meaningful with a music track; the web app checks it against the track's real length before generating,
   * and planners snap it to the first beat at or after this point.
   */
  musicStartSec: z.number().finite().min(0).max(3600).nullable().default(null),
});
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;
