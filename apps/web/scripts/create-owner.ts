/**
 * Creates (or, with --reset-password, re-keys) the studio owner account from the command line.
 *
 *   OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' OWNER_NAME='Sam' pnpm --filter @studio/web create-owner
 *   OWNER_EMAIL=you@example.com OWNER_PASSWORD='…' pnpm --filter @studio/web create-owner --reset-password
 *
 * Pass the password through OWNER_PASSWORD, not --password: pnpm prints the command line it runs (arguments
 * included), so a --password flag shows up on screen and in logs. --email, --password and --name still work.
 *
 * Reads DATABASE_URL (and the rest of the environment) the same way as the web app, including the
 * repository-root .env in local development. Never prints the password.
 */
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { newId } from '@studio/core';
import { schema } from '@studio/db';
import { writeAudit } from '../src/lib/audit.js';
import { hashPassword, passwordProblem } from '../src/lib/auth-core.js';
import { getDbHandle } from '../src/lib/db.js';
import { getSettings } from '../src/lib/settings.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
      'reset-password': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const email = (values.email ?? process.env.OWNER_EMAIL ?? '').trim();
  const password = values.password ?? process.env.OWNER_PASSWORD ?? '';
  const name = (values.name ?? process.env.OWNER_NAME ?? 'Owner').trim() || 'Owner';

  if (!EMAIL.test(email)) {
    console.error('Give a valid email with OWNER_EMAIL (or --email).');
    return 1;
  }
  const problem = passwordProblem(password);
  if (problem) {
    console.error(`Password not accepted: ${problem} (set it with OWNER_PASSWORD)`);
    return 1;
  }

  const handle = getDbHandle();
  try {
    const db = handle.db;
    await getSettings();
    const existing = await db.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${email.toLowerCase()}` });
    if (!existing) {
      const id = newId();
      await db.insert(schema.users).values({ id, email, displayName: name, passwordHash: await hashPassword(password), role: 'owner' });
      await writeAudit({ userId: id, action: 'auth.owner_created_cli', entityType: 'user', entityId: id });
      console.log(`Owner account created for ${email}. Sign in at /login.`);
      return 0;
    }
    if (!values['reset-password']) {
      console.log(`An account for ${email} already exists; nothing changed. Add --reset-password to set a new password from OWNER_PASSWORD.`);
      return 0;
    }
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password), role: 'owner', disabledAt: null, updatedAt: new Date() })
      .where(eq(schema.users.id, existing.id));
    const signedOut = await db.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id)).returning({ id: schema.sessions.id });
    await writeAudit({ userId: existing.id, action: 'auth.password_reset_cli', entityType: 'user', entityId: existing.id, data: { signedOutSessions: signedOut.length } });
    console.log(`Password reset for ${email}; ${signedOut.length} session(s) signed out.`);
    return 0;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
