import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job types shared by several Stage B/C modules (built once by the foundations package). */
export const SHARED_JOB_TYPES = {
  /** Processes one stored webhook delivery by calling the handler its provider's module registered. */
  WEBHOOK_PROCESS: 'webhook.process',
  /** Revokes a Google connection's refresh token and wipes the stored tokens. */
  GOOGLE_DISCONNECT: 'google.disconnect',
} as const;

export const WebhookProcessPayloadSchema = z.object({ webhookEventId: z.string().min(1) });
export const GoogleDisconnectPayloadSchema = z.object({ connectionId: z.string().min(1) });

/** Payload schemas of the shared job types. */
export const SHARED_JOB_PAYLOAD_SCHEMAS = {
  [SHARED_JOB_TYPES.WEBHOOK_PROCESS]: WebhookProcessPayloadSchema,
  [SHARED_JOB_TYPES.GOOGLE_DISCONNECT]: GoogleDisconnectPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
