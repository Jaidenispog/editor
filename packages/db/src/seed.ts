import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import { DEFAULT_SETTINGS, newId } from '@studio/core';
import { createDatabase } from './client.js';
import * as schema from './schema.js';

export interface SeedOptions {
  ownerEmail?: string | undefined;
  ownerPassword?: string | undefined;
  ownerName?: string | undefined;
}

/**
 * Idempotent seed: ensures the settings row exists and, when OWNER_EMAIL/OWNER_PASSWORD are given, the owner
 * account. Never overwrites an existing user's password. Safe to run on every deploy.
 */
export async function seed(connectionString: string, options: SeedOptions): Promise<{ createdOwner: boolean }> {
  const handle = createDatabase(connectionString, { max: 1, applicationName: 'studio-seed' });
  try {
    const db = handle.db;
    await db
      .insert(schema.settings)
      .values({ id: 'default', data: DEFAULT_SETTINGS })
      .onConflictDoNothing();
    let createdOwner = false;
    if (options.ownerEmail && options.ownerPassword) {
      if (options.ownerPassword.length < 10) throw new Error('OWNER_PASSWORD must be at least 10 characters');
      const existing = await db.query.users.findFirst({ where: sql`lower(${schema.users.email}) = ${options.ownerEmail.toLowerCase()}` });
      if (!existing) {
        await db.insert(schema.users).values({
          id: newId(),
          email: options.ownerEmail,
          displayName: options.ownerName ?? 'Owner',
          passwordHash: await hash(options.ownerPassword, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
          role: 'owner',
        });
        createdOwner = true;
      } else if (existing.role !== 'owner') {
        await db.update(schema.users).set({ role: 'owner', updatedAt: new Date() }).where(eq(schema.users.id, existing.id));
      }
    }
    return { createdOwner };
  } finally {
    await handle.close();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seed(url, { ownerEmail: process.env.OWNER_EMAIL, ownerPassword: process.env.OWNER_PASSWORD, ownerName: process.env.OWNER_NAME })
    .then((r) => {
      console.log(r.createdOwner ? `Owner account created for ${process.env.OWNER_EMAIL}` : 'Seed complete (settings ensured; owner unchanged or not requested)');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
