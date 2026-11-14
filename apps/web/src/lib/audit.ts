import 'server-only';
import { newId } from '@studio/core';
import { schema } from '@studio/db';
import { getDb } from './db.js';
import { getLogger } from './logger.js';

/**
 * Appends an audit_log entry. Auditing never blocks the action it records: failures are logged and swallowed.
 */
export async function writeAudit(entry: {
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getDb()
      .insert(schema.auditLog)
      .values({
        id: newId(),
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        data: entry.data ?? {},
      });
  } catch (err) {
    getLogger().error({ err, action: entry.action }, 'failed to write audit log entry');
  }
}
