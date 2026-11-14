import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  ReferenceStyleProfileSchema,
  type EditingPreferences,
  type ReferenceStyleProfile,
  type ReferenceSuggestionField,
} from '@studio/core';
import { schema } from '@studio/db';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { maybeSignedUrl } from './media-links.js';
import { parseFieldValue } from './preferences.js';
import { updateSettingsLocked } from './settings.js';
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
 * `by: 'reference'` (with the file name) so learning never overrides it; dismissing only records the decision.
 * Owner only; audited.
 */
export async function decideReference(user: SessionUser, assetId: string, input: { accept: ReferenceSuggestionField[]; dismiss: ReferenceSuggestionField[] }): Promise<{ profile: ReferenceStyleProfile; preferences: EditingPreferences }> {
  const db = getDb();
  const asset = await db.query.mediaAssets.findFirst({ where: and(eq(schema.mediaAssets.id, assetId), isNull(schema.mediaAssets.deletedAt)) });
  if (!asset || asset.kind !== 'reference_video') throw new AppError('NOT_FOUND', 'That reference video could not be found.');
  const parsed = asset.referenceProfile ? ReferenceStyleProfileSchema.safeParse(asset.referenceProfile) : null;
  if (!parsed?.success) throw new AppError('CONFLICT', 'This reference video has not been measured yet.');
  const profile = parsed.data;
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
      pinned[field] = { by: 'reference', at, referenceAssetId: asset.id, referenceName: asset.originalFilename.slice(0, 200) };
    }
    return { ...current, preferences: { ...prefs, ...declared, learning: { ...prefs.learning, pinned } } as EditingPreferences };
  });

  const decisions = { ...profile.decisions };
  for (const f of input.accept) decisions[f] = 'accepted';
  for (const f of input.dismiss) decisions[f] = 'dismissed';
  const updated: ReferenceStyleProfile = { ...profile, decisions };
  await db.update(schema.mediaAssets).set({ referenceProfile: updated, updatedAt: new Date() }).where(eq(schema.mediaAssets.id, asset.id));
  await writeAudit({ userId: user.id, action: 'reference.suggestions_decided', entityType: 'media_asset', entityId: asset.id, data: { accepted: input.accept, dismissed: input.dismiss } });
  return { profile: updated, preferences: next.preferences };
}
