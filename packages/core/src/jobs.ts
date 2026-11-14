import { z } from 'zod';
import { StyleIdSchema } from './styles.js';
import { BUSINESS_PROFILE_JOB_PAYLOAD_SCHEMAS, BUSINESS_PROFILE_JOB_TYPES } from './jobs/business_profile.js';
import { EMAIL_JOB_PAYLOAD_SCHEMAS, EMAIL_JOB_TYPES } from './jobs/email.js';
import { MUSIC_JOB_PAYLOAD_SCHEMAS, MUSIC_JOB_TYPES } from './jobs/music.js';
import { PREFERENCES_JOB_PAYLOAD_SCHEMAS, PREFERENCES_JOB_TYPES } from './jobs/preferences.js';
import { PUBLISHING_JOB_PAYLOAD_SCHEMAS, PUBLISHING_JOB_TYPES } from './jobs/publishing.js';
import { SHARED_JOB_PAYLOAD_SCHEMAS, SHARED_JOB_TYPES } from './jobs/shared.js';
import { SQUARE_JOB_PAYLOAD_SCHEMAS, SQUARE_JOB_TYPES } from './jobs/square.js';
import { STUDIO_JOB_PAYLOAD_SCHEMAS, STUDIO_JOB_TYPES } from './jobs/studio.js';
import { TRENDS_JOB_PAYLOAD_SCHEMAS, TRENDS_JOB_TYPES } from './jobs/trends.js';
import { WEBSITE_JOB_PAYLOAD_SCHEMAS, WEBSITE_JOB_TYPES } from './jobs/website.js';

export * from './jobs/types.js';
export * from './jobs/studio.js';
export * from './jobs/shared.js';

/**
 * Every job type name. Aggregated from one file per module (`./jobs/<module>.ts`), so parallel work packages
 * never edit this file. Module files are spread in a fixed order.
 */
export const JOB_TYPES = {
  ...STUDIO_JOB_TYPES,
  ...SHARED_JOB_TYPES,
  ...MUSIC_JOB_TYPES,
  ...PREFERENCES_JOB_TYPES,
  ...TRENDS_JOB_TYPES,
  ...PUBLISHING_JOB_TYPES,
  ...SQUARE_JOB_TYPES,
  ...EMAIL_JOB_TYPES,
  ...WEBSITE_JOB_TYPES,
  ...BUSINESS_PROFILE_JOB_TYPES,
} as const;

/**
 * Payload schema of every job type. A later module may replace an earlier entry only with a backwards-compatible
 * extension of the same payload (for example the music module adding an optional `variant` to `render.export`).
 */
export const JOB_PAYLOAD_SCHEMAS = {
  ...STUDIO_JOB_PAYLOAD_SCHEMAS,
  ...SHARED_JOB_PAYLOAD_SCHEMAS,
  ...MUSIC_JOB_PAYLOAD_SCHEMAS,
  ...PREFERENCES_JOB_PAYLOAD_SCHEMAS,
  ...TRENDS_JOB_PAYLOAD_SCHEMAS,
  ...PUBLISHING_JOB_PAYLOAD_SCHEMAS,
  ...SQUARE_JOB_PAYLOAD_SCHEMAS,
  ...EMAIL_JOB_PAYLOAD_SCHEMAS,
  ...WEBSITE_JOB_PAYLOAD_SCHEMAS,
  ...BUSINESS_PROFILE_JOB_PAYLOAD_SCHEMAS,
} as const;

/** A registered job type name such as `render.export`. */
export type JobType = keyof typeof JOB_PAYLOAD_SCHEMAS & string;
/** Every registered job type, in registry order. */
export const ALL_JOB_TYPES: JobType[] = Object.keys(JOB_PAYLOAD_SCHEMAS) as JobType[];

/** True when `type` is a registered job type (used before trusting a type read from the database or a request). */
export function isJobType(type: string): type is JobType {
  return Object.prototype.hasOwnProperty.call(JOB_PAYLOAD_SCHEMAS, type);
}

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
