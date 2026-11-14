import type { z } from 'zod';

/**
 * A module's new top-level settings sections: section name → Zod schema. Every schema must parse `undefined` to a
 * complete default (use `.default(...)`), so settings saved before the module existed still load unchanged.
 * Changes to existing sections (brand, business, preferences, legal) are made in `../settings.ts` instead.
 */
export type SettingsSectionMap = Record<string, z.ZodType>;
