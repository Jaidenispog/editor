import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase } from './client.js';
import { loadRootEnvFile } from './env-file.js';

/** Applies the SQL migrations in ./drizzle. Safe to run repeatedly (tracked in __drizzle_migrations). */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDatabase(connectionString, { max: 1, applicationName: 'studio-migrate' });
  try {
    const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  loadRootEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log('Migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
