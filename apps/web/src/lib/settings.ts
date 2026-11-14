import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type AppSettings } from '@studio/core';
import { schema } from '@studio/db';
import { getDb } from './db.js';
import { getLogger } from './logger.js';
import { ensureCuratedTrends } from './seed-trends.js';
import { normaliseStoredSettings } from './settings-merge.js';

const SETTINGS_ID = 'default';
const globalForSettings = globalThis as unknown as { __studioTrendsChecked?: boolean };

/**
 * Returns the app settings from the single 'default' row, creating it from DEFAULT_SETTINGS when missing.
 * The first call in each process also seeds the curated trend references (once ever).
 */
export async function getSettings(): Promise<AppSettings> {
  const db = getDb();
  let row = await db.query.settings.findFirst({ where: eq(schema.settings.id, SETTINGS_ID) });
  if (!row) {
    await db.insert(schema.settings).values({ id: SETTINGS_ID, data: DEFAULT_SETTINGS }).onConflictDoNothing();
    row = await db.query.settings.findFirst({ where: eq(schema.settings.id, SETTINGS_ID) });
  }
  if (!globalForSettings.__studioTrendsChecked) {
    globalForSettings.__studioTrendsChecked = true;
    try {
      await ensureCuratedTrends();
    } catch (err) {
      globalForSettings.__studioTrendsChecked = false;
      getLogger().warn({ err }, 'could not seed curated trend references');
    }
  }
  return normaliseStoredSettings(row?.data ?? DEFAULT_SETTINGS);
}

/**
 * The only way the web app writes the settings row. Reads it under a row lock, applies `change` and stores the
 * result, keeping the server-owned preference subtrees (`learned`, `styleAffinity`) exactly as the database has them.
 * The worker's preferences.recompute job writes those subtrees with jsonb_set in a single UPDATE, which waits for
 * this lock (and this read waits for its UPDATE), so no save here can put back a stale copy of what it learned.
 * There is deliberately no "store this whole object" helper: a read outside the lock followed by a write is exactly
 * the race this prevents. `change` may throw (for example an AppError) to abandon the write; keep it short, because
 * the lock is held while it runs.
 */
export async function updateSettingsLocked(change: (current: AppSettings) => AppSettings | Promise<AppSettings>): Promise<AppSettings> {
  await getSettings(); // creates the row on first use
  return getDb().transaction(async (tx) => {
    const rows = await tx.execute<{ data: unknown }>(sql`select data from ${schema.settings} where ${schema.settings.id} = ${SETTINGS_ID} for update`);
    const current = normaliseStoredSettings(rows.rows[0]?.data ?? DEFAULT_SETTINGS);
    const next = await change(current);
    const kept: AppSettings = {
      ...next,
      preferences: { ...next.preferences, learned: current.preferences.learned, styleAffinity: current.preferences.styleAffinity },
    };
    await tx.update(schema.settings).set({ data: kept, updatedAt: new Date() }).where(eq(schema.settings.id, SETTINGS_ID));
    return kept;
  });
}

/** Settings for the root layout: never throws, so the sign-in page still renders when the database is down. */
export async function getSettingsOrDefaults(): Promise<AppSettings> {
  try {
    return await getSettings();
  } catch (err) {
    getLogger().warn({ err }, 'settings unavailable; using defaults');
    return DEFAULT_SETTINGS;
  }
}
