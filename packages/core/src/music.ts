import { z } from 'zod';

/**
 * Places a track's licence can cover. `facebook` is a licence-coverage platform only (memo §2: "Add a `facebook`
 * platform"); publishing targets stay Instagram and TikTok.
 */
export const PUBLISH_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'website', 'facebook'] as const;
export const PublishPlatformSchema = z.enum(PUBLISH_PLATFORMS);
export type PublishPlatform = z.infer<typeof PublishPlatformSchema>;

/** Plain names of the licence platforms, for owner-facing sentences. */
export const PLATFORM_NAMES: Record<PublishPlatform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  website: 'the website',
};

/**
 * Where a track came from (the licence passport's first question, memo §2). `cc_by_nc` exists so the form can name
 * the choice, but such tracks are always refused: a non-commercial licence never covers promoting a business.
 */
export const MUSIC_LICENCE_KINDS = ['owner_upload', 'catalogue', 'commercial_licence', 'meta_sound_collection', 'cc0', 'cc_by', 'cc_by_nc', 'public_domain', 'unknown'] as const;
export const MusicLicenceKindSchema = z.enum(MUSIC_LICENCE_KINDS);
export type MusicLicenceKind = z.infer<typeof MusicLicenceKindSchema>;

/**
 * The licence passport stored with every track (`music_tracks.licence`). Every field added after Stage A has a
 * default, so rows saved before parse unchanged.
 */
export const MusicLicenceSchema = z.object({
  kind: MusicLicenceKindSchema,
  /** Who owns the recording / where it came from (e.g. "Uploaded by owner", "Epidemic Sound"). */
  source: z.string().max(120).default(''),
  licenceName: z.string().max(120).default(''),
  proofUrl: z.string().max(500).default(''),
  notes: z.string().max(1000).default(''),
  /** Name on the library account (should be the business name). */
  accountHolder: z.string().max(120).default(''),
  /** The library plan the track was downloaded under, e.g. "Business". */
  planName: z.string().max(120).default(''),
  /** Track link or id at the library. */
  providerTrackRef: z.string().max(300).default(''),
  downloadedAt: z.string().nullable().default(null),
  /** Meta Sound Collection: when the owner accepted Meta's terms. */
  termsAcceptedAt: z.string().nullable().default(null),
  permitted: z.object({
    promotionalUse: z.boolean().default(false),
    instagram: z.boolean().default(false),
    tiktok: z.boolean().default(false),
    youtube: z.boolean().default(false),
    website: z.boolean().default(false),
    facebook: z.boolean().default(false),
    paidAds: z.boolean().default(false),
  }),
  attributionRequired: z.boolean().default(false),
  attributionText: z.string().max(300).default(''),
  expiresAt: z.string().nullable().default(null),
  /** `meta_only`: renders with this track may only go to Instagram and Facebook (Meta Sound Collection). */
  destinationLock: z.enum(['meta_only']).nullable().default(null),
  /** The owner explicitly confirmed they hold the rights to use this recording as described. */
  confirmedByOwnerAt: z.string().nullable().default(null),
});
export type MusicLicence = z.infer<typeof MusicLicenceSchema>;

/** Every field's default (the passport fields added after Stage A included). */
const LICENCE_DEFAULTS: MusicLicence = MusicLicenceSchema.parse({ kind: 'unknown', permitted: {} });

/** Shown (and returned by the API) when a non-commercial Creative Commons track is offered. */
export const CC_BY_NC_REFUSAL = "Non-commercial licences don't cover promoting a business, so this track can't be added.";
/** Shown when a CC BY track has no credit line. */
export const CC_BY_CREDIT_REQUIRED = 'Add the credit line the CC BY licence asks for. It is added to your post captions.';
/** Label for files whose music may only be uploaded to Meta's apps. */
export const META_ONLY_LABEL = 'For Instagram/Facebook upload only';
/** File name suffix for `meta_only` standard exports. */
export const META_ONLY_FILE_SUFFIX = 'instagram-facebook-only';

/** Library plan names known not to cover business promotion (memo §2: "Personal, Social and Creator tiers do not qualify"). */
const LIMITED_PLAN_PATTERN = /\b(personal|social|creator)\b/i;

/** The amber, non-blocking note for a plan name that suggests a personal tier, or null. */
export function planNameWarning(planName: string): string | null {
  return LIMITED_PLAN_PATTERN.test(planName)
    ? "Personal, Social and Creator plans don't cover business promotion. Check your plan before using this track for the shop."
    : null;
}

/**
 * Applies the passport's fixed rules: a Meta Sound Collection track is locked to Meta destinations (TikTok, YouTube
 * and website are switched off), and a CC BY track always needs its credit line. Pure; returns a new object.
 */
export function normaliseLicence(stored: MusicLicence): MusicLicence {
  // Rows saved before the passport fields existed are read as raw JSON without them: fill the defaults first.
  const licence: MusicLicence = { ...LICENCE_DEFAULTS, ...stored, permitted: { ...LICENCE_DEFAULTS.permitted, ...stored.permitted } };
  const lock = licence.kind === 'meta_sound_collection' ? 'meta_only' : licence.destinationLock;
  const permitted = { ...licence.permitted };
  if (lock === 'meta_only') {
    permitted.tiktok = false;
    permitted.youtube = false;
    permitted.website = false;
  }
  return {
    ...licence,
    permitted,
    destinationLock: lock,
    attributionRequired: licence.kind === 'cc_by' ? true : licence.attributionRequired,
    attributionText: (licence.attributionText ?? '').trim(),
  };
}

/** Why a licence cannot be saved at all (CC BY-NC, or CC BY without its credit line), or null. */
export function licenceRefusal(licence: Pick<MusicLicence, 'kind' | 'attributionText'>): string | null {
  if (licence.kind === 'cc_by_nc') return CC_BY_NC_REFUSAL;
  if (licence.kind === 'cc_by' && !licence.attributionText.trim()) return CC_BY_CREDIT_REQUIRED;
  return null;
}

/**
 * The licence as the API accepts it from the owner: refuses CC BY-NC and a CC BY track without its credit line,
 * then applies {@link normaliseLicence}.
 */
export const MusicLicenceInputSchema = MusicLicenceSchema.superRefine((licence, ctx) => {
  const refusal = licenceRefusal(licence);
  if (refusal) ctx.addIssue({ code: 'custom', message: refusal, path: licence.kind === 'cc_by_nc' ? ['kind'] : ['attributionText'] });
}).transform(normaliseLicence);

/** True when the licence has an end date in the past. */
export function licenceExpired(licence: Pick<MusicLicence, 'expiresAt'>, now: Date = new Date()): boolean {
  if (!licence.expiresAt) return false;
  const t = new Date(licence.expiresAt).getTime();
  return Number.isFinite(t) && t < now.getTime();
}

/** The chip shown on a track: confirmed, not confirmed, expired, or locked to Instagram and Facebook. */
export type LicenceState = 'confirmed' | 'not_confirmed' | 'expired' | 'meta_only';

/** The track's licence chip. Not confirmed wins over expired; the Meta lock is shown only for a usable licence. */
export function licenceStateOf(licence: MusicLicence, now: Date = new Date()): LicenceState {
  if (!licence.confirmedByOwnerAt) return 'not_confirmed';
  if (licenceExpired(licence, now)) return 'expired';
  if (normaliseLicence(licence).destinationLock === 'meta_only') return 'meta_only';
  return 'confirmed';
}

/** Plain labels for {@link LicenceState}. */
export const LICENCE_STATE_LABELS: Record<LicenceState, string> = {
  confirmed: 'Licence confirmed',
  not_confirmed: 'Not confirmed',
  expired: 'Expired',
  meta_only: 'Instagram & Facebook only',
};

/** Result of checking a version's music against its licence (export and publish gates, usage ledger). */
export const MusicClearanceSchema = z.object({
  state: z.enum(['no_music', 'cleared', 'restricted', 'blocked']),
  /** Places the music may go. */
  platforms: z.array(PublishPlatformSchema),
  /** Places it may not go. */
  blockedPlatforms: z.array(PublishPlatformSchema),
  destinationLock: z.enum(['meta_only']).nullable(),
  /** Credit line to add to captions (CC BY), or null. */
  attributionText: z.string().nullable(),
  /** Plain reasons, shown verbatim. */
  reasons: z.array(z.string()),
});
export type MusicClearance = z.infer<typeof MusicClearanceSchema>;

/** Clearance of an edit without music: it can go anywhere. */
export const NO_MUSIC_CLEARANCE: MusicClearance = {
  state: 'no_music',
  platforms: [...PUBLISH_PLATFORMS],
  blockedPlatforms: [],
  destinationLock: null,
  attributionText: null,
  reasons: [],
};

/** Clearance when the plan has music but the track row is gone, so its licence cannot be checked. */
export function missingTrackClearance(): MusicClearance {
  return { ...NO_MUSIC_CLEARANCE, state: 'blocked', platforms: [], blockedPlatforms: [...PUBLISH_PLATFORMS], reasons: ["The music track was removed, so its licence can't be checked."] };
}

/**
 * Checks music against its licence passport (memo §2). `null` means the edit has no music. Blocked when the licence is
 * unconfirmed, expired, of unknown origin, non-commercial, without promotional use, or covers no platform at all;
 * `restricted` when it is locked to Meta destinations; otherwise `cleared`. Platforms the licence does not tick are
 * listed in `blockedPlatforms` either way.
 */
export function musicClearanceFor(licence: MusicLicence | null | undefined, now: Date = new Date()): MusicClearance {
  if (!licence) return { ...NO_MUSIC_CLEARANCE, platforms: [...NO_MUSIC_CLEARANCE.platforms] };
  const l = normaliseLicence(licence);
  const reasons: string[] = [];
  if (l.kind === 'cc_by_nc') reasons.push("Non-commercial licences don't cover promoting a business.");
  if (l.kind === 'unknown') reasons.push("Where this track came from hasn't been recorded. Choose the licence type in Settings → Music.");
  if (!l.confirmedByOwnerAt) reasons.push('The licence has not been confirmed by the owner.');
  if (licenceExpired(l, now)) reasons.push('The music licence has expired.');
  if (!l.permitted.promotionalUse) reasons.push("The licence doesn't cover promoting the business.");
  const attributionText = l.attributionRequired && l.attributionText ? l.attributionText : null;
  if (reasons.length) {
    return { state: 'blocked', platforms: [], blockedPlatforms: [...PUBLISH_PLATFORMS], destinationLock: l.destinationLock, attributionText, reasons };
  }
  const platforms = PUBLISH_PLATFORMS.filter((p) => l.permitted[p]);
  const blockedPlatforms = PUBLISH_PLATFORMS.filter((p) => !l.permitted[p]);
  if (platforms.length === 0) {
    return { state: 'blocked', platforms: [], blockedPlatforms, destinationLock: l.destinationLock, attributionText, reasons: ["The licence doesn't cover any place you can post the video."] };
  }
  const notes = blockedPlatforms.length ? [`The licence doesn't cover ${plainList(blockedPlatforms.map((p) => PLATFORM_NAMES[p]))}.`] : [];
  if (l.destinationLock === 'meta_only') {
    notes.unshift("This track is from Meta's Sound Collection, which is licensed for Instagram and Facebook only.");
    return { state: 'restricted', platforms, blockedPlatforms, destinationLock: 'meta_only', attributionText, reasons: notes };
  }
  return { state: 'cleared', platforms, blockedPlatforms, destinationLock: null, attributionText, reasons: notes };
}

/** True when a standard (with-music) export may be made. */
export function exportAllowed(clearance: MusicClearance): boolean {
  return clearance.state !== 'blocked';
}

/** "A", "A and B", "A, B and C". */
export function plainList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One sentence for the download dialog, e.g. "Music cleared for: Instagram and TikTok." */
export function clearanceSummary(clearance: MusicClearance): string {
  switch (clearance.state) {
    case 'no_music':
      return 'No music in this version.';
    case 'blocked':
      return `This version's music isn't cleared for business use: ${clearance.reasons[0] ?? 'the licence could not be checked.'}`;
    default: {
      const names = clearance.platforms.map((p) => PLATFORM_NAMES[p]);
      const base = `Music cleared for: ${plainList(names)}.`;
      return clearance.state === 'restricted' ? `${base} ${META_ONLY_LABEL}.` : base;
    }
  }
}

export interface CrossPostCheck {
  ok: boolean;
  blockedPlatforms: PublishPlatform[];
  reasons: string[];
}

/** Only allow a soundtrack to travel to a destination when the recorded licence covers it. */
export function checkMusicForPlatforms(licence: MusicLicence | null, platforms: PublishPlatform[]): CrossPostCheck {
  if (!licence) return { ok: true, blockedPlatforms: [], reasons: [] };
  const l = normaliseLicence(licence);
  const reasons: string[] = [];
  const blocked: PublishPlatform[] = [];
  if (!l.confirmedByOwnerAt) reasons.push('The music licence has not been confirmed by the owner.');
  if (!l.permitted.promotionalUse) reasons.push('The licence does not cover promotional use.');
  if (licenceExpired(l)) reasons.push('The music licence has expired.');
  if (l.kind === 'cc_by_nc' || l.kind === 'unknown') reasons.push("The track's licence type doesn't allow business use.");
  for (const p of platforms) {
    if (!l.permitted[p]) blocked.push(p);
  }
  if (blocked.length) reasons.push(`The licence does not cover: ${blocked.join(', ')}.`);
  return { ok: reasons.length === 0, blockedPlatforms: blocked, reasons };
}
