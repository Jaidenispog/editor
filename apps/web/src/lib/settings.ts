import 'server-only';
import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type AppSettings } from '@studio/core';
import { schema } from '@studio/db';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getLogger } from './logger.js';
import { ensureCuratedTrends } from './seed-trends.js';
import { mergeSettings, normaliseStoredSettings, type SettingsPatch } from './settings-merge.js';

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

/** Applies a partial update (validated with AppSettingsSchema) and returns the merged settings. */
export async function updateSettings(patch: SettingsPatch, userId: string | null): Promise<AppSettings> {
  const current = await getSettings();
  const next = mergeSettings(current, patch);
  await saveSettings(next);
  await writeAudit({ userId, action: 'settings.updated', entityType: 'settings', entityId: SETTINGS_ID, data: { sections: Object.keys(patch) } });
  return next;
}

/** Stores a complete, already-validated settings object (used by the logo route). */
export async function saveSettings(next: AppSettings): Promise<void> {
  await getDb()
    .insert(schema.settings)
    .values({ id: SETTINGS_ID, data: next })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: next, updatedAt: new Date() } });
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
