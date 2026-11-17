import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  ReferenceStyleProfileSchema,
  SUMMARY_MAX_PROFILES,
  SUMMARY_ROW_STYLE_FIELDS,
  applySummaryDecisions,
  describeStyleSignals,
  isOlderMeasuringVersion,
  readReferenceProfile,
  resetEditingStyle,
  summariseReferenceStyle,
  type EditingPreferences,
  type EditingStyleRowField,
  type ReferenceStyleProfile,
  type ReferenceStyleProfileV2,
  type ReferenceStyleSummary,
  type ReferenceSuggestionField,
  type ReferenceSummaryField,
} from '@studio/core';
import { schema } from '@studio/db';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { maybeSignedUrl } from './media-links.js';
import { parseFieldValue } from './preferences.js';
import { getSettings, updateSettingsLocked } from './settings.js';
import type { ReferenceDto } from './shared/studio-dto.js';
import { shapeReference } from './studio-status-shape.js';
import { createUpload, type UploadSessionDto } from './uploads.js';
import type { CreateUploadInput } from './shared/studio-schemas.js';

/** A reference video with the project it belongs to (Settings → Editing preferences → Reference videos). */
export type ReferenceListItem = ReferenceDto & { projectId: string; projectTitle: string };

/** Starts a reference video upload in a project (style only; the owner's text-estimate tick is stored with it). */
export async function createReferenceUpload(projectId: string, user: SessionUser, input: Omit<CreateUploadInput, 'kind'>, useVision: boolean): Promise<UploadSessionDto> {
  return createUpload(projectId, user, { ...input, kind: 'reference_video' }, { referenceOptions: { useVision } });
}

/** Every reference video in projects that still exist, newest first (owner only). */
export async function listReferences(): Promise<ReferenceListItem[]> {
  const rows = await getDb()
    .select({ asset: schema.mediaAssets, projectTitle: schema.projects.title })
    .from(schema.mediaAssets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.mediaAssets.projectId))
    .where(and(eq(schema.mediaAssets.kind, 'reference_video'), isNull(schema.mediaAssets.deletedAt), isNull(schema.projects.deletedAt)))
    .orderBy(desc(schema.mediaAssets.createdAt));
  const sign = async (key: string) => maybeSignedUrl(key);
  return Promise.all(rows.map(async ({ asset, projectTitle }) => ({ ...(await shapeReference(asset, sign)), projectId: asset.projectId, projectTitle })));
}

/**
 * Applies the owner's decisions on a reference's suggestions. Accepting sets the declared value and pins the field
 * `by: 'reference'` (with the file name) so learning never overrides it; dismissing only records the decision. A video
 * measured with another version of the measuring is refused (409): its suggestions are not offered. Owner only; audited.
 */
export async function decideReference(user: SessionUser, assetId: string, input: { accept: ReferenceSuggestionField[]; dismiss: ReferenceSuggestionField[] }): Promise<{ profile: ReferenceStyleProfile; preferences: EditingPreferences }> {
  const db = getDb();
  const asset = await db.query.mediaAssets.findFirst({ where: and(eq(schema.mediaAssets.id, assetId), isNull(schema.mediaAssets.deletedAt)) });
  if (!asset || asset.kind !== 'reference_video') throw new AppError('NOT_FOUND', 'That reference video could not be found.');
  const parsed = asset.referenceProfile ? ReferenceStyleProfileSchema.safeParse(asset.referenceProfile) : null;
  if (!parsed?.success) throw new AppError('CONFLICT', 'This reference video has not been measured yet.');
  const profile = parsed.data;
  // Its pace, length and colour came from another version of the measuring, like the rest of it (§4.3.1.4).
  const read = readReferenceProfile(profile);
  if (read && isOlderMeasuringVersion(read)) throw new AppError('CONFLICT', 'This video was measured with an older version of the measuring, so its suggestions are not offered. Upload it again to get new ones.');
  const overlap = input.accept.filter((f) => input.dismiss.includes(f));
  if (overlap.length) throw new AppError('VALIDATION', 'A suggestion cannot be both used and dismissed.', { details: [{ path: 'accept', message: overlap.join(', ') }] });
  const suggestions = new Map(profile.suggestions.map((s) => [s.field, s]));
  for (const f of [...input.accept, ...input.dismiss]) {
    if (!suggestions.has(f)) throw new AppError('VALIDATION', 'That suggestion is not part of this reference video.', { details: [{ path: f, message: 'Not suggested' }] });
  }

  const at = new Date().toISOString();
  const next = await updateSettingsLocked((current) => {
    const prefs = current.preferences;
    const pinned = { ...prefs.learning.pinned };
    const declared: Record<string, unknown> = {};
    for (const field of input.accept) {
      declared[field] = parseFieldValue(field, suggestions.get(field)!.value);
      pinned[field] = { by: 'reference', at, referenceAssetId: asset.id, referenceName: asset.originalFilename.slice(0, 200), referenceAssetIds: [] };
    }
    return { ...current, preferences: { ...prefs, ...declared, learning: { ...prefs.learning, pinned } } as EditingPreferences };
  });

  const decisions = { ...profile.decisions };
  for (const f of input.accept) decisions[f] = 'accepted';
  for (const f of input.dismiss) decisions[f] = 'dismissed';
  // The stored version is kept (a v1 profile stays recognisable as an older measurement).
  const updated: ReferenceStyleProfile = { ...profile, decisions };
  await db.update(schema.mediaAssets).set({ referenceProfile: updated, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));
  await writeAudit({ userId: user.id, action: 'reference.suggestions_decided', entityType: 'media_asset', entityId: asset.id, data: { accepted: input.accept, dismissed: input.dismiss } });
  return { profile: updated, preferences: next.preferences };
}

/** One measured video in the "Your style from your videos" list. */
export interface SummaryVideoDto {
  id: string;
  filename: string;
  projectId: string;
  projectTitle: string;
  thumbnailUrl: string | null;
  measuredAt: string;
  /** The per-video line (estimates), or null for an older measurement. */
  line: string | null;
  olderMeasurement: boolean;
  /** Measured with an older version of the measuring: listed, but not combined into "your style". */
  olderVersion: boolean;
}

/** GET /api/references/summary. */
export interface ReferenceSummaryDto {
  summary: ReferenceStyleSummary;
  suggestions: ReferenceStyleSummary['suggestions'];
  videos: { total: number; measured: number; olderMeasurement: number; olderVersion: number; measuring: number; failed: number };
  list: SummaryVideoDto[];
}

async function summaryInputs(): Promise<{ profiles: ReferenceStyleProfileV2[]; list: SummaryVideoDto[]; measuring: number; failed: number; total: number }> {
  const rows = await getDb()
    .select({ asset: schema.mediaAssets, projectTitle: schema.projects.title })
    .from(schema.mediaAssets)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.mediaAssets.projectId))
    .where(and(eq(schema.mediaAssets.kind, 'reference_video'), isNull(schema.mediaAssets.deletedAt), isNull(schema.projects.deletedAt)))
    .orderBy(desc(schema.mediaAssets.createdAt));
  const measured: Array<{ profile: ReferenceStyleProfileV2; row: (typeof rows)[number] }> = [];
  let measuring = 0;
  let failed = 0;
  for (const row of rows) {
    const profile = row.asset.referenceProfile ? readReferenceProfile(row.asset.referenceProfile) : null;
    if (profile && row.asset.status === 'ready') measured.push({ profile, row });
    else if (row.asset.status === 'failed') failed++;
    else measuring++;
  }
  // The latest 12 measured videos, newest measurement first.
  measured.sort((a, b) => b.profile.measuredAt.localeCompare(a.profile.measuredAt));
  const latest = measured.slice(0, SUMMARY_MAX_PROFILES);
  const list = await Promise.all(
    latest.map(async ({ profile, row }) => ({
      id: row.asset.id,
      filename: row.asset.originalFilename,
      projectId: row.asset.projectId,
      projectTitle: row.projectTitle,
      thumbnailUrl: row.asset.thumbnailKey ? await maybeSignedUrl(row.asset.thumbnailKey) : null,
      measuredAt: profile.measuredAt,
      line: profile.style ? describeStyleSignals(profile.style, profile.colourLook) : null,
      olderMeasurement: profile.style === null,
      olderVersion: isOlderMeasuringVersion(profile),
    })),
  );
  return { profiles: latest.map((m) => m.profile), list, measuring, failed, total: rows.length };
}

/**
 * "Your style from your videos" (design §4.3.1.4, §4.3.1.9): the latest 12 measured reference videos of every project
 * combined into suggestion rows, each an estimate with how many videos agree. Signed-in users can read it (staff see
 * it read-only); only the owner can decide.
 */
export async function getReferenceSummary(): Promise<ReferenceSummaryDto> {
  const [inputs, settings] = await Promise.all([summaryInputs(), getSettings()]);
  const summary = summariseReferenceStyle(inputs.profiles, settings.preferences);
  return {
    summary,
    suggestions: summary.suggestions,
    videos: { total: inputs.total, measured: summary.measured, olderMeasurement: summary.olderMeasurement, olderVersion: summary.olderVersion, measuring: inputs.measuring, failed: inputs.failed },
    list: inputs.list,
  };
}

/**
 * Accepts or dismisses summary rows (owner only; audited `reference.summary_decided`). Every accepted value is written
 * through `updateSettingsLocked` together with its `alsoChanges`; a valueKey that no longer matches the current summary
 * (the videos changed meanwhile) answers 409 and changes nothing.
 */
export async function decideReferenceSummary(
  user: SessionUser,
  input: { accept: ReferenceSummaryField[]; dismiss: ReferenceSummaryField[]; valueKeys: Partial<Record<ReferenceSummaryField, string>> },
): Promise<{ summary: ReferenceStyleSummary; preferences: EditingPreferences }> {
  const overlap = input.accept.filter((f) => input.dismiss.includes(f));
  if (overlap.length) throw new AppError('VALIDATION', 'A suggestion cannot be both used and dismissed.', { details: [{ path: 'accept', message: overlap.join(', ') }] });
  const { profiles } = await summaryInputs();
  let applied: ReturnType<typeof applySummaryDecisions> | null = null;
  const at = new Date().toISOString();
  const next = await updateSettingsLocked((current) => {
    const summary = summariseReferenceStyle(profiles, current.preferences);
    applied = applySummaryDecisions(current.preferences, summary, input, at);
    if (applied.conflicts.length || applied.invalid.length) return current;
    return { ...current, preferences: applied.preferences };
  });
  const result = applied as ReturnType<typeof applySummaryDecisions> | null;
  if (result?.invalid.length) throw new AppError('VALIDATION', 'There is no suggestion to decide for that row.', { details: result.invalid.map((f) => ({ path: f, message: 'No suggestion' })) });
  if (result?.conflicts.length) throw new AppError('CONFLICT', 'Your style summary changed — check the new suggestion.', { details: result.conflicts.map((f) => ({ path: f, message: 'Changed' })) });
  await writeAudit({ userId: user.id, action: 'reference.summary_decided', entityType: 'settings', entityId: 'default', data: { accepted: input.accept, dismissed: input.dismiss, videos: profiles.length } });
  if (input.accept.length) await writeAudit({ userId: user.id, action: 'preferences.editing_style_changed', entityType: 'settings', entityId: 'default', data: { fields: input.accept, by: 'reference' } });
  return { summary: summariseReferenceStyle(profiles, next.preferences), preferences: next.preferences };
}

/**
 * "Go back to each style's own": the editing style returns to its defaults; length, pace, colour and text stay (owner
 * only). With `row` ("Change: use each style's own" on one row), only the values accepting that row set, all of them
 * ("Cutting to the beat" also the beats per cut), with their sources.
 */
export async function resetReferenceSummary(user: SessionUser, row?: EditingStyleRowField): Promise<{ summary: ReferenceStyleSummary; preferences: EditingPreferences }> {
  const { profiles } = await summaryInputs();
  const next = await updateSettingsLocked((current) => ({ ...current, preferences: resetEditingStyle(current.preferences, row) }));
  await writeAudit({
    userId: user.id,
    action: 'preferences.editing_style_changed',
    entityType: 'settings',
    entityId: 'default',
    data: row ? { reset: true, by: 'owner', row, fields: [...SUMMARY_ROW_STYLE_FIELDS[row]] } : { reset: true, by: 'owner' },
  });
  return { summary: summariseReferenceStyle(profiles, next.preferences), preferences: next.preferences };
}
