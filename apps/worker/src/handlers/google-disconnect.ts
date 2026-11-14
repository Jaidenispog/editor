import { and, eq } from 'drizzle-orm';
import { errorMessage } from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import { revokeGoogleToken } from '../lib/google/oauth.js';
import type { TrackedRun } from '../lib/job-tracker.js';

/** Shown when Google could not confirm the sign-out after every retry. */
export const GOOGLE_REVOKE_FAILED_MESSAGE =
  'Disconnected here, but Google did not confirm it. To be sure, remove Studio Assistant at myaccount.google.com/permissions.';

/**
 * `google.disconnect`: revokes a Google connection's token, then wipes the stored tokens. Runs only while the row is
 * still `disconnected`, so an owner who reconnected in the meantime keeps the new sign-in. On the last attempt a
 * failed revocation still wipes the tokens and leaves a plain note for the owner. Safe to run again.
 */
export async function handleGoogleDisconnect(ctx: WorkerContext, run: TrackedRun, payload: { connectionId: string }): Promise<void> {
  const t = schema.integrationConnections;
  const conn = await ctx.db.query.integrationConnections.findFirst({ where: eq(t.id, payload.connectionId) });
  if (!conn) {
    await run.progress(1, 'Nothing to disconnect');
    return;
  }
  if (conn.status !== 'disconnected') {
    await run.progress(1, 'Reconnected since; nothing to revoke');
    return;
  }
  const token = decryptOptionalCredential(ctx.env, conn.refreshTokenEncrypted) ?? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted);
  let lastError: string | null = null;
  let outcome = 'no_token';
  if (token) {
    try {
      outcome = await revokeGoogleToken(ctx, token, run.signal);
    } catch (err) {
      run.checkCancelled();
      if (run.willRetry) throw err;
      ctx.logger.warn({ provider: conn.provider, err: errorMessage(err) }, 'google revoke failed on the last attempt; wiping tokens anyway');
      outcome = 'revoke_failed';
      lastError = GOOGLE_REVOKE_FAILED_MESSAGE;
    }
  }
  const wipedAny = await ctx.db.transaction(async (tx) => {
    // Conditional: if the owner reconnected while Google was being called, the fresh sign-in is left alone.
    const wiped = await tx
      .update(t)
      .set({ accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiresAt: null, lastError, updatedAt: new Date() })
      .where(and(eq(t.id, conn.id), eq(t.status, 'disconnected')))
      .returning({ id: t.id });
    if (!wiped.length) return false;
    await writeWorkerAudit(tx, { userId: null, action: `integration.${conn.provider}.tokens_revoked`, entityType: 'integration_connection', entityId: conn.id, data: { outcome } });
    return true;
  });
  if (!wipedAny) await run.progress(1, 'Reconnected since; the new sign-in was kept');
  else await run.progress(1, outcome === 'revoke_failed' ? 'Disconnected; Google did not confirm' : 'Disconnected from Google');
}
