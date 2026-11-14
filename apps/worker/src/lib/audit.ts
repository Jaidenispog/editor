import { newId } from '@studio/core';
import { schema, type Database } from '@studio/db';
import type { Logger } from 'pino';
import { redact } from './http.js';

/** A database or an open transaction (anything that can insert). */
export type DbExecutor = Pick<Database, 'insert'>;

/** Longest text kept in one audit field. */
export const AUDIT_TEXT_MAX = 200;

/**
 * Makes audit data safe to store: secret fields removed, email addresses hashed, strings trimmed to 200
 * characters and nesting limited. Audit entries hold ids, codes and short text, never secrets or message bodies.
 */
export function sanitiseAuditData(data: Record<string, unknown>): Record<string, unknown> {
  const trim = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > AUDIT_TEXT_MAX ? `${v.slice(0, AUDIT_TEXT_MAX - 1)}…` : v;
    if (Array.isArray(v)) return depth > 3 ? '[list]' : v.slice(0, 20).map((x) => trim(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 3) return '[object]';
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trim(x, depth + 1)]));
    }
    return v;
  };
  return trim(redact(data), 0) as Record<string, unknown>;
}

/** One audit entry written by the worker (the twin of apps/web/src/lib/audit.ts). */
export interface WorkerAuditEntry {
  /** The person the action is attributed to, or null for automatic work. */
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Appends an audit_log entry. Pass a transaction to record it atomically with the change it describes; then a
 * failure rolls back with it. Without a logger, errors propagate; with one, they are logged and swallowed so
 * auditing never blocks the action.
 */
export async function writeWorkerAudit(db: DbExecutor, entry: WorkerAuditEntry, logger?: Logger): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      id: newId(),
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      data: sanitiseAuditData(entry.data ?? {}),
    });
  } catch (err) {
    if (!logger) throw err;
    logger.error({ err, action: entry.action }, 'failed to write audit log entry');
  }
}
