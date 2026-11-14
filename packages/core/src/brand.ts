import { z } from 'zod';

export const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like #C8A24A');

/**
 * Fonts that ship with the renderer (`assets/fonts`). The brand schema still accepts the older names for settings
 * saved before this list existed; the renderer draws those with Inter (`resolveRenderFont` in @studio/media) and
 * Settings offers only these.
 */
export const BUNDLED_FONTS = ['Inter', 'Inter Display'] as const;
export type BundledFont = (typeof BUNDLED_FONTS)[number];

/** True when the font ships with the renderer. */
export function isBundledFont(name: string): name is BundledFont {
  return (BUNDLED_FONTS as readonly string[]).includes(name);
}

/** Where the logo appears in rendered videos. */
export const LOGO_PLACEMENTS = ['off', 'end_card', 'corner', 'both'] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];
/** Which top corner the corner mark uses (the lower corners sit under the apps' buttons and captions). */
export const LOGO_CORNERS = ['top_left', 'top_right'] as const;
export type LogoCorner = (typeof LOGO_CORNERS)[number];

export const BrandConfigSchema = z.object({
  appName: z.string().min(1).max(60).default('Studio Assistant'),
  businessName: z.string().min(1).max(80).default('My Barber Studio'),
  tagline: z.string().max(120).default(''),
  accentColour: HexColourSchema.default('#C8A24A'),
  logoStorageKey: z.string().nullable().default(null),
  fontHeadline: z.enum(['Inter', 'Inter Display', 'DejaVu Sans', 'Liberation Sans']).default('Inter Display'),
  fontBody: z.enum(['Inter', 'DejaVu Sans', 'Liberation Sans']).default('Inter'),
  /** Text treatment used inside rendered videos. */
  videoTextStyle: z.enum(['minimal', 'bold', 'editorial']).default('minimal'),
  /** Optional handle shown at the end of videos (never required). */
  socialHandle: z.string().max(40).default(''),
  /** Logo in videos: off (default), an end card, a small corner mark, or both. Needs an uploaded logo. */
  logoPlacement: z.enum(LOGO_PLACEMENTS).default('off'),
  /** Corner used by the corner mark. */
  logoCorner: z.enum(LOGO_CORNERS).default('top_left'),
  /** Opacity of the corner mark (the end card is always fully opaque). */
  logoOpacity: z.number().min(0.6).max(1).default(0.85),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

export const DEFAULT_BRAND: BrandConfig = BrandConfigSchema.parse({});

/**
 * The brand a preview was rendered with, stored on its version (`edit_versions.render_brand`) so the export of that
 * version looks exactly like its preview even if Settings → Branding changes in between. The logo is identified by
 * its storage key and content hash; the worker downloads it again for the export.
 */
export const RenderBrandSnapshotSchema = z.object({
  accentColour: HexColourSchema,
  videoTextStyle: z.enum(['minimal', 'bold', 'editorial']),
  fontHeadline: z.string().min(1).max(60),
  fontBody: z.string().min(1).max(60),
  socialHandle: z.string().max(40).default(''),
  logo: z
    .object({
      storageKey: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      placement: z.enum(['end_card', 'corner', 'both']),
      corner: z.enum(LOGO_CORNERS),
      opacity: z.number().min(0.6).max(1),
    })
    .nullable()
    .default(null),
});
export type RenderBrandSnapshot = z.infer<typeof RenderBrandSnapshotSchema>;

/**
 * The snapshot for the current brand settings. `logoSha256` is the hash of the logo file the worker downloaded, or
 * null when there is no logo to draw (placement off, nothing uploaded, or the file is missing).
 */
export function brandSnapshotFrom(brand: BrandConfig, logoSha256: string | null): RenderBrandSnapshot {
  const placement = brand.logoPlacement;
  return {
    accentColour: brand.accentColour,
    videoTextStyle: brand.videoTextStyle,
    fontHeadline: brand.fontHeadline,
    fontBody: brand.fontBody,
    socialHandle: brand.socialHandle,
    logo:
      placement !== 'off' && brand.logoStorageKey && logoSha256
        ? { storageKey: brand.logoStorageKey, sha256: logoSha256, placement, corner: brand.logoCorner, opacity: brand.logoOpacity }
        : null,
  };
}
