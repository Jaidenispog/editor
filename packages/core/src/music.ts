import { z } from 'zod';

export const PUBLISH_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'website'] as const;
export const PublishPlatformSchema = z.enum(PUBLISH_PLATFORMS);
export type PublishPlatform = z.infer<typeof PublishPlatformSchema>;

export const MusicLicenceSchema = z.object({
  kind: z.enum(['owner_upload', 'catalogue', 'commercial_licence', 'cc0', 'cc_by', 'public_domain', 'unknown']),
  /** Who owns the recording / where it came from (e.g. "Uploaded by owner", "Epidemic Sound"). */
  source: z.string().max(120).default(''),
  licenceName: z.string().max(120).default(''),
  proofUrl: z.string().max(500).default(''),
  notes: z.string().max(1000).default(''),
  permitted: z.object({
    promotionalUse: z.boolean().default(false),
    instagram: z.boolean().default(false),
    tiktok: z.boolean().default(false),
    youtube: z.boolean().default(false),
    website: z.boolean().default(false),
  }),
  attributionRequired: z.boolean().default(false),
  attributionText: z.string().max(300).default(''),
  expiresAt: z.string().nullable().default(null),
  /** The owner explicitly confirmed they hold the rights to use this recording as described. */
  confirmedByOwnerAt: z.string().nullable().default(null),
});
export type MusicLicence = z.infer<typeof MusicLicenceSchema>;

export interface CrossPostCheck {
  ok: boolean;
  blockedPlatforms: PublishPlatform[];
  reasons: string[];
}

/** Only allow a soundtrack to travel to a destination when the recorded licence covers it. */
export function checkMusicForPlatforms(licence: MusicLicence | null, platforms: PublishPlatform[]): CrossPostCheck {
  if (!licence) return { ok: true, blockedPlatforms: [], reasons: [] };
  const reasons: string[] = [];
  const blocked: PublishPlatform[] = [];
  if (!licence.confirmedByOwnerAt) reasons.push('The music licence has not been confirmed by the owner.');
  if (!licence.permitted.promotionalUse) reasons.push('The licence does not cover promotional use.');
  if (licence.expiresAt && new Date(licence.expiresAt).getTime() < Date.now()) reasons.push('The music licence has expired.');
  for (const p of platforms) {
    if (!licence.permitted[p]) blocked.push(p);
  }
  if (blocked.length) reasons.push(`The licence does not cover: ${blocked.join(', ')}.`);
  return { ok: reasons.length === 0, blockedPlatforms: blocked, reasons };
}
