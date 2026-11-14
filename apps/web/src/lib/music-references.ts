import 'server-only';
import { desc, eq } from 'drizzle-orm';
import {
  AppError,
  NOT_A_SPOTIFY_LINK,
  SPOTIFY_REFERENCE_NOTICE,
  newId,
  parseSpotifyLink,
  resolveLegalUrls,
  spotifyEmbedUrl,
  type AppSettings,
} from '@studio/core';
import { schema, type musicReferences } from '@studio/db';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { getSettings, saveSettings } from './settings.js';
import type { MusicReferenceDto, MusicReferencesDto } from './shared/studio-dto.js';

/*
 * Private Spotify references (memo §1). Only the pasted link, its type and id, and the owner's notes are stored;
 * the server never calls Spotify, never fetches oEmbed data, and nothing here may reach the planner, AI prompts,
 * publishing, emails, the website module or any public page. A unit test checks that those modules never import
 * this file.
 */

/** Body for POST /api/music/references. */
export const AddReferenceSchema = z.object({
  url: z.string().trim().min(1, NOT_A_SPOTIFY_LINK).max(500),
  notes: z.string().trim().max(500).default(''),
});

/** Body for PATCH /api/music/references/[id]. */
export const UpdateReferenceSchema = z.object({ notes: z.string().trim().max(500) });

/** Body for PUT /api/music/references/mode. */
export const ReferenceModeSchema = z.object({
  mode: z.enum(['link_only', 'embed']),
  /** The owner ticked "I have read Spotify's Developer Terms and Widget Terms". */
  acknowledgeSpotifyTerms: z.literal(true).optional(),
});

/** Whether the official embed may be shown, and what is still missing, in plain words. */
export function spotifyEmbedState(settings: Pick<AppSettings, 'business' | 'legal' | 'music'>, appUrl: string): { canEmbed: boolean; missing: string[]; mode: 'link_only' | 'embed' } {
  const urls = resolveLegalUrls(settings, appUrl);
  const missing: string[] = [];
  if (!urls.terms) missing.push('A published terms of use page (Settings → Business → Legal pages, or your own Terms of use URL)');
  if (!urls.privacy) missing.push('A published privacy policy page (Settings → Business → Legal pages, or your own Privacy policy URL)');
  if (!settings.music.spotifyTermsAcknowledgedAt) missing.push("Your confirmation that you have read Spotify's Developer Terms and Widget Terms");
  const canEmbed = missing.length === 0;
  return { canEmbed, missing, mode: canEmbed && settings.music.spotifyReferenceMode === 'embed' ? 'embed' : 'link_only' };
}

type ReferenceRow = typeof musicReferences.$inferSelect;

function toDto(row: ReferenceRow, embed: boolean): MusicReferenceDto {
  return {
    id: row.id,
    url: row.url,
    itemType: row.itemType,
    externalId: row.externalId,
    notes: row.notes,
    embedUrl: embed ? spotifyEmbedUrl(row) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every saved reference with the display mode in force. */
export async function listReferences(): Promise<MusicReferencesDto> {
  const [settings, rows] = await Promise.all([getSettings(), getDb().select().from(schema.musicReferences).orderBy(desc(schema.musicReferences.createdAt))]);
  const state = spotifyEmbedState(settings, getEnv().APP_URL);
  return {
    mode: state.mode,
    storedMode: settings.music.spotifyReferenceMode,
    canEmbed: state.canEmbed,
    missing: state.missing,
    termsAcknowledged: Boolean(settings.music.spotifyTermsAcknowledgedAt),
    notice: SPOTIFY_REFERENCE_NOTICE,
    references: rows.map((r) => toDto(r, state.mode === 'embed')),
  };
}

/** Saves a pasted Spotify link (owner only). Refuses anything that is not a Spotify link, and duplicates. */
export async function addReference(user: SessionUser, input: z.infer<typeof AddReferenceSchema>): Promise<MusicReferenceDto> {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can add music references.');
  const link = parseSpotifyLink(input.url);
  if (!link) throw new AppError('VALIDATION', NOT_A_SPOTIFY_LINK, { details: [{ path: 'url', message: NOT_A_SPOTIFY_LINK }] });
  const inserted = await getDb()
    .insert(schema.musicReferences)
    .values({ id: newId(), provider: 'spotify', url: link.url, itemType: link.itemType, externalId: link.externalId, notes: input.notes, createdBy: user.id })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('CONFLICT', 'That Spotify link is already saved.');
  await writeAudit({ userId: user.id, action: 'music.reference_added', entityType: 'music_reference', entityId: row.id, data: { itemType: row.itemType } });
  const state = spotifyEmbedState(await getSettings(), getEnv().APP_URL);
  return toDto(row, state.mode === 'embed');
}

/** Changes a reference's notes (owner only). */
export async function updateReference(id: string, user: SessionUser, input: z.infer<typeof UpdateReferenceSchema>): Promise<MusicReferenceDto> {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can change music references.');
  const updated = await getDb().update(schema.musicReferences).set({ notes: input.notes, updatedAt: new Date() }).where(eq(schema.musicReferences.id, id)).returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That music reference could not be found.');
  const state = spotifyEmbedState(await getSettings(), getEnv().APP_URL);
  return toDto(row, state.mode === 'embed');
}

/** Deletes a reference (owner only). */
export async function deleteReference(id: string, user: SessionUser): Promise<void> {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can remove music references.');
  const deleted = await getDb().delete(schema.musicReferences).where(eq(schema.musicReferences.id, id)).returning({ id: schema.musicReferences.id });
  if (!deleted[0]) throw new AppError('NOT_FOUND', 'That music reference could not be found.');
  await writeAudit({ userId: user.id, action: 'music.reference_removed', entityType: 'music_reference', entityId: id });
}

/**
 * Switches between link-only and the official embed (owner only). The embed is refused (CONFLICT) until the terms
 * and privacy pages exist and the owner has acknowledged Spotify's terms; going back to link-only always works.
 */
export async function setReferenceMode(user: SessionUser, input: z.infer<typeof ReferenceModeSchema>): Promise<MusicReferencesDto> {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can change how music references are shown.');
  const current = await getSettings();
  const music = {
    ...current.music,
    spotifyReferenceMode: input.mode,
    spotifyTermsAcknowledgedAt: input.acknowledgeSpotifyTerms ? (current.music.spotifyTermsAcknowledgedAt ?? new Date().toISOString()) : current.music.spotifyTermsAcknowledgedAt,
  };
  if (input.mode === 'embed') {
    const state = spotifyEmbedState({ ...current, music }, getEnv().APP_URL);
    if (!state.canEmbed) {
      throw new AppError('CONFLICT', `The Spotify player can't be shown yet. Still needed: ${state.missing.join('; ')}.`, { details: { missing: state.missing } });
    }
  }
  await saveSettings({ ...current, music });
  await writeAudit({ userId: user.id, action: 'music.spotify_mode_changed', entityType: 'settings', entityId: 'default', data: { mode: input.mode } });
  return listReferences();
}
