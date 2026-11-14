import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  DEFAULT_SETTINGS,
  EMPTY_LEARNED,
  EditPlanSchema,
  LEARNABLE_FIELDS,
  LEARNABLE_FIELD_LABELS,
  LEARNED_VALUE_SCHEMAS,
  LearnableFieldSchema,
  STYLES,
  StyleIdSchema,
  completeStyleOrder,
  effectivePreferences,
  formatTrendDateTime,
  learnedValue,
  preferenceSource,
  type AppSettings,
  type EditingPreferences,
  type FeedbackEventType,
  type LearnableField,
  type LearnedPreferences,
  type LearningState,
  type Pin,
  type PreferenceSource,
} from '@studio/core';
import { schema } from '@studio/db';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { recordFeedback, scheduleRecompute } from './feedback.js';
import { getSettings, updateSettingsLocked } from './settings.js';
import { mergeSettings, normaliseStoredSettings, type SettingsPatch } from './settings-merge.js';
import { getAccessibleEdit } from './studio-access.js';

const SETTINGS_ID = 'default';

/** POST /api/preferences/pin */
export const PinPreferenceSchema = z.object({ field: LearnableFieldSchema, pinned: z.boolean(), value: z.unknown().optional() }).strict();
/** POST /api/preferences/learning */
export const LearningToggleSchema = z.object({ enabled: z.boolean() }).strict();
/** POST /api/preferences/reset */
export const ResetLearningSchema = z.object({ confirm: z.literal(true, { error: 'Confirm the reset to continue.' }) }).strict();
/** POST /api/edits/[id]/dismiss */
export const DismissSchema = z.object({ value: z.boolean() }).strict();

/**
 * PUT /api/settings: merges the patch (learnable fields it changes are pinned to the owner) under the row lock,
 * writes an audit entry and, when a learnable field changed, queues a recompute so suggestions refresh.
 */
export async function updateSettingsFromPatch(patch: SettingsPatch, userId: string | null): Promise<AppSettings> {
  let pinnedNow: LearnableField[] = [];
  const next = await updateSettingsLocked((current) => {
    const merged = mergeSettings(current, patch);
    pinnedNow = LEARNABLE_FIELDS.filter((f) => merged.preferences.learning.pinned[f] && !current.preferences.learning.pinned[f]);
    return merged;
  });
  await writeAudit({ userId, action: 'settings.updated', entityType: 'settings', entityId: SETTINGS_ID, data: { sections: Object.keys(patch), ...(pinnedNow.length ? { pinned: pinnedNow } : {}) } });
  if (patch.brand && 'logoPlacement' in patch.brand) {
    await writeAudit({ userId, action: 'settings.logo_placement_changed', entityType: 'settings', entityId: SETTINGS_ID, data: { placement: next.brand.logoPlacement } });
  }
  return next;
}

/** One learnable field as Settings → Editing preferences shows it. */
export interface PreferenceFieldView {
  field: LearnableField;
  label: string;
  /** The value in use. */
  value: unknown;
  source: PreferenceSource;
  /** Evidence sentence for a learned value (or for the suggestion on a pinned field). */
  explanation: string;
  /** For pinned fields: what learning would suggest, when it differs from the value in use. */
  suggestion: { value: unknown; explanation: string } | null;
  pin: Pin | null;
  /** True when there is not enough evidence to learn this field yet. */
  notEnoughEvidence: boolean;
}

/** One recent feedback event in plain words. */
export interface FeedbackSummary {
  id: string;
  type: FeedbackEventType;
  text: string;
  /** Melbourne time, "12 Nov 2026, 3:14 pm". */
  when: string;
  at: string;
}

/** Response of GET /api/preferences. */
export interface PreferencesView {
  declared: EditingPreferences;
  effective: ReturnType<typeof effectivePreferences>;
  learned: LearnedPreferences;
  learning: LearningState;
  fields: PreferenceFieldView[];
  recent: FeedbackSummary[];
  canEdit: boolean;
}

const VERB: Record<FeedbackEventType, string> = {
  favourite: 'Favourited',
  unfavourite: 'Removed the favourite from',
  download: 'Downloaded',
  revise: 'Revised',
  regenerate: 'Asked for a fresh take of',
  publish: 'Published',
  dismiss: 'Hid',
};

/** The last 20 feedback events in plain words ("Favourited Cinematic reveal (Jordan, fade) · 12 Nov 2026, 3:14 pm"). */
export async function recentChoices(limit = 20): Promise<FeedbackSummary[]> {
  const db = getDb();
  const rows = await db
    .select({ e: schema.feedbackEvents, title: schema.projects.title, client: schema.projects.clientName })
    .from(schema.feedbackEvents)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.feedbackEvents.projectId))
    .orderBy(desc(schema.feedbackEvents.createdAt), desc(schema.feedbackEvents.id))
    .limit(limit);
  return rows.map(({ e, title, client }) => {
    const style = StyleIdSchema.safeParse(e.styleId);
    const name = style.success ? STYLES[style.data].name : 'an edit';
    const verb = e.type === 'dismiss' && e.data['value'] === false ? 'Showed again' : VERB[e.type];
    const where = [client, title].filter((s): s is string => Boolean(s && s.trim())).join(', ');
    const instruction = e.type === 'revise' && typeof e.data['instruction'] === 'string' ? `: “${String(e.data['instruction']).slice(0, 80)}”` : '';
    return { id: e.id, type: e.type, text: `${verb} ${name}${where ? ` (${where})` : ''}${instruction}`, when: formatTrendDateTime(e.createdAt), at: e.createdAt.toISOString() };
  });
}

/** Builds the per-field view: value in use, source chip, evidence and any suggestion. Pure. */
export function preferenceFields(prefs: EditingPreferences): PreferenceFieldView[] {
  const effective = effectivePreferences(prefs);
  return LEARNABLE_FIELDS.map((field) => {
    const entry = prefs.learned.fields[field];
    const learned = learnedValue(prefs, field);
    const pin = prefs.learning.pinned[field] ?? null;
    const value = (effective as Record<string, unknown>)[field];
    const differs = learned !== null && JSON.stringify(field === 'styleOrder' ? completeStyleOrder(learned as never) : learned) !== JSON.stringify(value);
    return {
      field,
      label: LEARNABLE_FIELD_LABELS[field],
      value,
      source: preferenceSource(prefs, field, DEFAULT_SETTINGS.preferences),
      explanation: entry && learned !== null ? entry.explanation : '',
      suggestion: pin && differs && entry ? { value: field === 'styleOrder' ? completeStyleOrder(learned as never) : learned, explanation: entry.explanation } : null,
      pin,
      notEnoughEvidence: learned === null,
    };
  });
}

/** GET /api/preferences (staff see it read-only). */
export async function getPreferencesView(user: SessionUser): Promise<PreferencesView> {
  const settings = await getSettings();
  const prefs = settings.preferences;
  return {
    declared: prefs,
    effective: effectivePreferences(prefs),
    learned: prefs.learned,
    learning: prefs.learning,
    fields: preferenceFields(prefs),
    recent: await recentChoices(),
    canEdit: user.role === 'owner',
  };
}

/** Validates a value for one learnable field (styleOrder is completed so every style stays available). */
export function parseFieldValue(field: LearnableField, value: unknown): unknown {
  const parsed = LEARNED_VALUE_SCHEMAS[field].safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION', `That is not a valid value for ${LEARNABLE_FIELD_LABELS[field].toLowerCase()}.`, { details: [{ path: 'value', message: 'Invalid value' }] });
  return field === 'styleOrder' ? completeStyleOrder(parsed.data as never) : parsed.data;
}

/**
 * Pins a field (to `value`, or to the value in use when none is given) or lets it learn again. Owner only; audited.
 */
export async function pinPreference(user: SessionUser, input: { field: LearnableField; pinned: boolean; value?: unknown }): Promise<EditingPreferences> {
  const next = await updateSettingsLocked((current) => {
    const prefs = current.preferences;
    const pinned = { ...prefs.learning.pinned };
    let declared: Partial<EditingPreferences> = {};
    if (input.pinned) {
      const value = input.value !== undefined ? parseFieldValue(input.field, input.value) : (effectivePreferences(prefs) as Record<string, unknown>)[input.field];
      declared = { [input.field]: value } as Partial<EditingPreferences>;
      pinned[input.field] = { by: 'owner', at: new Date().toISOString(), referenceAssetId: null, referenceName: '' };
    } else {
      delete pinned[input.field];
    }
    return { ...current, preferences: { ...prefs, ...declared, learning: { ...prefs.learning, pinned } } };
  });
  await writeAudit({ userId: user.id, action: input.pinned ? 'preferences.pinned' : 'preferences.unpinned', entityType: 'settings', entityId: SETTINGS_ID, data: { field: input.field } });
  return next.preferences;
}

/** Turns learning on or off (learned values stay visible but unused while off). Owner only; audited. */
export async function setLearningEnabled(user: SessionUser, enabled: boolean): Promise<EditingPreferences> {
  const next = await updateSettingsLocked((current) => ({ ...current, preferences: { ...current.preferences, learning: { ...current.preferences.learning, enabled } } }));
  await writeAudit({ userId: user.id, action: 'preferences.learning_toggled', entityType: 'settings', entityId: SETTINGS_ID, data: { enabled } });
  return next.preferences;
}

/**
 * "Reset what it learned": events before now are ignored from here on and the learned values are cleared. The
 * owner's own settings and pins stay. Owner only; audited. Clearing `learned` is the one write of that subtree outside
 * the recompute job, done under the same row lock.
 */
export async function resetLearning(user: SessionUser): Promise<EditingPreferences> {
  const resetAt = new Date().toISOString();
  await getSettings();
  const next = await getDb().transaction(async (tx) => {
    const rows = await tx.execute<{ data: unknown }>(sql`select data from ${schema.settings} where ${schema.settings.id} = ${SETTINGS_ID} for update`);
    const current = normaliseStoredSettings(rows.rows[0]?.data ?? DEFAULT_SETTINGS);
    const updated: AppSettings = {
      ...current,
      preferences: { ...current.preferences, styleAffinity: {}, learned: { ...EMPTY_LEARNED, computedAt: resetAt }, learning: { ...current.preferences.learning, resetAt } },
    };
    await tx.update(schema.settings).set({ data: updated, updatedAt: new Date() }).where(eq(schema.settings.id, SETTINGS_ID));
    return updated;
  });
  await writeAudit({ userId: user.id, action: 'preferences.learning_reset', entityType: 'settings', entityId: SETTINGS_ID, data: { resetAt } });
  await scheduleRecompute('reset');
  return next.preferences;
}

/** "Try again" after a failed recompute. Owner only. */
export async function requestRecompute(): Promise<void> {
  await scheduleRecompute('settings');
}

/**
 * "Hide this edit" / "Show again": sets or clears `edits.dismissed_at` and records a `dismiss` feedback event with the
 * current version's plan facts in the same transaction. Nothing is deleted. Staff may hide edits in projects they can
 * open.
 */
export async function setDismissed(editId: string, user: SessionUser, value: boolean): Promise<{ dismissed: boolean }> {
  const { edit } = await getAccessibleEdit(editId, user);
  if ((edit.dismissedAt !== null) === value) return { dismissed: value };
  const db = getDb();
  const version = edit.currentVersionId ? await db.query.editVersions.findFirst({ columns: { plan: true }, where: eq(schema.editVersions.id, edit.currentVersionId) }) : null;
  await db.transaction(async (tx) => {
    await tx.update(schema.edits).set({ dismissedAt: value ? new Date() : null, updatedAt: new Date() }).where(eq(schema.edits.id, editId));
    await recordFeedback(tx, {
      type: 'dismiss',
      userId: user.id,
      projectId: edit.projectId,
      editId,
      editVersionId: edit.currentVersionId,
      styleId: edit.styleId,
      plan: version?.plan && EditPlanSchema.safeParse(version.plan).success ? version.plan : null,
      data: { value },
    });
  });
  await scheduleRecompute();
  return { dismissed: value };
}

/** Projects of the given ids that still exist (used by the references list). */
export async function liveProjectTitles(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: schema.projects.id, title: schema.projects.title })
    .from(schema.projects)
    .where(and(inArray(schema.projects.id, ids), isNull(schema.projects.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.title]));
}
