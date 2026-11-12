import { z } from 'zod';

export const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour like #C8A24A');

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
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

export const DEFAULT_BRAND: BrandConfig = BrandConfigSchema.parse({});
