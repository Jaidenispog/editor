import { and, desc, eq, gt, sql } from 'drizzle-orm';
import {
  CancelledError,
  DEFAULT_SETTINGS,
  LEARNING_MAX_EVENTS,
  LEARNING_WINDOW_DAYS,
  computeLearnedPreferences,
  parseStoredSettings,
  styleAffinityFrom,
  type EditingPreferences,
  type LearnedPreferences,
  type LearningEvent,
  type PreferencesRecomputePayload,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';

const SETTINGS_ID = 'default';

/** Reads the stored preferences, applying the "pin what the owner set by hand" rule for settings that predate learning. */
async function loadPreferences(ctx: WorkerContext): Promise<{ prefs: EditingPreferences; exists: boolean }> {
  const row = await ctx.db.query.settings.findFirst({ where: eq(schema.settings.id, SETTINGS_ID) });
  if (!row) return { prefs: DEFAULT_SETTINGS.preferences, exists: false };
  const parsed = parseStoredSettings(row.data);
  return { prefs: parsed?.preferences ?? DEFAULT_SETTINGS.preferences, exists: true };
}

/** The newest feedback events the learner may use (after the reset point, inside the window). */
async function loadEvents(ctx: WorkerContext, prefs: EditingPreferences, now: Date): Promise<LearningEvent[]> {
  const windowStart = new Date(now.getTime() - LEARNING_WINDOW_DAYS * 86_400_000);
  const resetAt = prefs.learning.resetAt ? new Date(prefs.learning.resetAt) : null;
  const after = resetAt && resetAt > windowStart ? resetAt : windowStart;
  const rows = await ctx.db
    .select()
    .from(schema.feedbackEvents)
    .where(gt(schema.feedbackEvents.createdAt, after))
    .orderBy(desc(schema.feedbackEvents.createdAt), desc(schema.feedbackEvents.id))
    .limit(LEARNING_MAX_EVENTS);
  return rows.map((r) => ({ id: r.id, type: r.type, createdAt: r.createdAt, editId: r.editId, editVersionId: r.editVersionId, styleId: r.styleId, data: r.data }));
}

/**
 * Writes only `preferences.learned` and `preferences.styleAffinity` (and `preferences.learning` when the stored
 * settings predate it) with jsonb_set in one UPDATE, so an owner's settings change saved meanwhile is never lost.
 * The update only applies while the reset point is the one the events were read for. Returns false when it was not.
 */
async function writeLearned(ctx: WorkerContext, learned: LearnedPreferences, affinity: Record<string, number> | null, prefs: EditingPreferences): Promise<boolean> {
  const learnedJson = JSON.stringify(learned);
  const learningJson = JSON.stringify(prefs.learning);
  let data = sql`case when (${schema.settings.data} -> 'preferences') ? 'learning' then ${schema.settings.data} else jsonb_set(${schema.settings.data}, '{preferences}', coalesce(${schema.settings.data} -> 'preferences', '{}'::jsonb) || jsonb_build_object('learning', ${learningJson}::jsonb), true) end`;
  data = sql`jsonb_set(${data}, '{preferences,learned}', ${learnedJson}::jsonb, true)`;
  if (affinity) data = sql`jsonb_set(${data}, '{preferences,styleAffinity}', ${JSON.stringify(affinity)}::jsonb, true)`;
  const resetAt = prefs.learning.resetAt;
  const rows = await ctx.db
    .update(schema.settings)
    .set({ data: data as unknown as typeof schema.settings.$inferInsert.data, updatedAt: new Date() })
    .where(and(eq(schema.settings.id, SETTINGS_ID), sql`(${schema.settings.data} #>> '{preferences,learning,resetAt}') is not distinct from ${resetAt}`))
    .returning({ id: schema.settings.id });
  return rows.length > 0;
}

/**
 * `preferences.recompute`: recomputes what the editor learned from feedback (deterministic, no model training) and
 * stores it. A duplicate run is harmless. On failure `learned.error` is set so Settings can say so, and the previous
 * learned values stay in use.
 */
export async function handlePreferencesRecompute(ctx: WorkerContext, run: TrackedRun, payload: PreferencesRecomputePayload, now: () => Date = () => new Date()): Promise<void> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      run.checkCancelled();
      const { prefs, exists } = await loadPreferences(ctx);
      if (!exists) {
        await ctx.db.insert(schema.settings).values({ id: SETTINGS_ID, data: DEFAULT_SETTINGS }).onConflictDoNothing();
        continue;
      }
      const at = now();
      await run.progress(0.2, 'Reading your recent choices');
      const events = await loadEvents(ctx, prefs, at);
      const learned = computeLearnedPreferences(events, prefs, at);
      const affinity = learned.fields.styleOrder ? styleAffinityFrom(events, prefs, at) : {};
      run.checkCancelled();
      if (await writeLearned(ctx, learned, affinity, prefs)) {
        ctx.logger.info({ reason: payload.reason, events: events.length, fields: Object.keys(learned.fields) }, 'learned preferences updated');
        await run.progress(1, events.length ? `Learned from ${events.length} choice${events.length === 1 ? '' : 's'}` : 'Nothing to learn from yet');
        return;
      }
      // The owner reset learning while this ran: read again from the new reset point.
    }
    throw new Error('the preferences kept changing while they were being updated');
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    const message = 'Could not update what was learned.';
    await ctx.db
      .update(schema.settings)
      .set({ data: sql`jsonb_set(${schema.settings.data}, '{preferences,learned,error}', ${JSON.stringify(message)}::jsonb, true)` as unknown as typeof schema.settings.$inferInsert.data, updatedAt: new Date() })
      .where(and(eq(schema.settings.id, SETTINGS_ID), sql`${schema.settings.data} #> '{preferences,learned}' is not null`))
      .catch((e: unknown) => ctx.logger.warn({ err: e }, 'could not record the learning error'));
    throw err;
  }
}
