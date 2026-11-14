import type { z } from 'zod';

/**
 * A module's job registry: job type name → Zod schema of its payload. The aggregator in `../jobs.ts` spreads every
 * module's map in a fixed order; a later module may replace an earlier payload schema only with a backwards-compatible
 * extension (new optional fields or new enum values with defaults), because queued jobs keep their old payloads.
 */
export type JobPayloadSchemaMap = Record<string, z.ZodType>;
