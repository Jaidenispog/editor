import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the saved preferences, reference video and brand module (WP2). */
export const PREFERENCES_JOB_TYPES = {
  /**
   * Recomputes what the editor learned from feedback events and writes only `preferences.learned` and
   * `preferences.styleAffinity` (jsonb_set), never the whole settings object. Pure, so a duplicate run is harmless.
   */
  PREFERENCES_RECOMPUTE: 'preferences.recompute',
  /**
   * Measures a reference video (shot lengths, look, optional on-screen text estimate), stores the profile and then
   * deletes the original, proxy and frames. Skips when the profile already exists.
   */
  REFERENCE_ANALYSE: 'reference.analyse',
} as const;

/** Debounce for `preferences.recompute` after feedback (seconds). */
export const PREFERENCES_RECOMPUTE_DELAY_SEC = 10;
/** Singleton key shared by every `preferences.recompute` request. */
export const PREFERENCES_RECOMPUTE_KEY = 'preferences:recompute';

/** `preferences.recompute`: why it runs (for the logs). */
export const PreferencesRecomputePayloadSchema = z.object({
  reason: z.enum(['feedback', 'reset', 'settings', 'schedule']).default('feedback'),
});
export type PreferencesRecomputePayload = z.infer<typeof PreferencesRecomputePayloadSchema>;

/** `reference.analyse`: the reference asset; `useVision` only when the owner ticked the text estimate. */
export const ReferenceAnalysePayloadSchema = z.object({
  assetId: z.string().min(1),
  projectId: z.string().min(1),
  useVision: z.boolean().default(false),
});
export type ReferenceAnalysePayload = z.infer<typeof ReferenceAnalysePayloadSchema>;

/** Payload schemas of the saved preferences, reference video and brand module's job types, keyed by job type. */
export const PREFERENCES_JOB_PAYLOAD_SCHEMAS = {
  [PREFERENCES_JOB_TYPES.PREFERENCES_RECOMPUTE]: PreferencesRecomputePayloadSchema,
  [PREFERENCES_JOB_TYPES.REFERENCE_ANALYSE]: ReferenceAnalysePayloadSchema,
} as const satisfies JobPayloadSchemaMap;
