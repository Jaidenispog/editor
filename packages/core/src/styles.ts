import { z } from 'zod';

export const STYLE_IDS = ['beat_montage', 'cinematic_reveal', 'before_after', 'clean_promo', 'process_story'] as const;
export const StyleIdSchema = z.enum(STYLE_IDS);
export type StyleId = z.infer<typeof StyleIdSchema>;

export const SEGMENT_LABELS = [
  'before',
  'cutting',
  'fade_detail',
  'styling',
  'result',
  'reaction',
  'environment',
  'other',
  'unknown',
] as const;
export const SegmentLabelSchema = z.enum(SEGMENT_LABELS);
export type SegmentLabel = z.infer<typeof SegmentLabelSchema>;

export const PROCESS_LABELS: readonly SegmentLabel[] = ['cutting', 'fade_detail', 'styling'];

export const TRANSITION_TYPES = [
  'fade',
  'dissolve',
  'fadeblack',
  'fadewhite',
  'wipeleft',
  'wiperight',
  'slideup',
  'slidedown',
  'circleopen',
  'zoomin',
] as const;
export const TransitionTypeSchema = z.enum(TRANSITION_TYPES);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

/** Transitions considered "restrained"; everything else is treated as flashy. */
export const RESTRAINED_TRANSITIONS: readonly TransitionType[] = ['fade', 'dissolve', 'fadeblack', 'fadewhite'];

export const COLOUR_PRESETS = ['none', 'natural', 'clean', 'cinematic', 'punchy'] as const;
export const ColourPresetSchema = z.enum(COLOUR_PRESETS);
export type ColourPreset = z.infer<typeof ColourPresetSchema>;

export interface StyleRequirement {
  /** Each inner array is an OR-group; every group must be satisfied by at least one labelled shot. */
  labelGroups: SegmentLabel[][];
  minUsableShots: number;
  needsSpeech?: boolean;
}

export interface StyleDefinition {
  id: StyleId;
  name: string;
  shortDescription: string;
  /** Editorial brief handed to the planner (AI or rules-based). */
  brief: string;
  requirement: StyleRequirement;
  pacing: { minShotSec: number; maxShotSec: number; beatSync: boolean; speedRamps: boolean };
  transitions: TransitionType[];
  colourPreset: ColourPreset;
  textDensity: 'none' | 'light' | 'medium';
  musicMoods: string[];
}

export const STYLES: Record<StyleId, StyleDefinition> = {
  beat_montage: {
    id: 'beat_montage',
    name: 'Beat-synced montage',
    shortDescription: 'Fast cuts locked to the music, high energy, detail-heavy.',
    brief:
      'High-energy montage. Cut on beats, 0.4–1.2 s shots, favour sharp close-ups of clipper work and fade detail, finish on the cleanest result shot held for a full bar. Minimal text: one punchy opener only.',
    requirement: { labelGroups: [], minUsableShots: 4 },
    pacing: { minShotSec: 0.4, maxShotSec: 1.4, beatSync: true, speedRamps: true },
    transitions: ['fade'],
    colourPreset: 'punchy',
    textDensity: 'light',
    musicMoods: ['hip hop', 'drill', 'upbeat', 'trap'],
  },
  cinematic_reveal: {
    id: 'cinematic_reveal',
    name: 'Cinematic reveal',
    shortDescription: 'Slow build through the cut, then a held reveal of the finished look.',
    brief:
      'Slow, deliberate build: 1.5–3 s shots of the process with subtle push-ins, a dip-to-black or dissolve before the reveal, then the finished result held 3–5 s at the end. Restrained text, one line at most.',
    requirement: { labelGroups: [['result']], minUsableShots: 3 },
    pacing: { minShotSec: 1.2, maxShotSec: 3.5, beatSync: false, speedRamps: true },
    transitions: ['dissolve', 'fadeblack'],
    colourPreset: 'cinematic',
    textDensity: 'light',
    musicMoods: ['cinematic', 'ambient', 'r&b', 'soul'],
  },
  before_after: {
    id: 'before_after',
    name: 'Before and after',
    shortDescription: 'Opens on the before, builds briefly, lands on the transformation.',
    brief:
      'Transformation edit. Open on a clear BEFORE shot (2–3 s), a short process bridge, then the AFTER/result held and matched to a beat if music is present. Text labels "Before" and "After" placed in the safe zone.',
    requirement: { labelGroups: [['before'], ['result']], minUsableShots: 3 },
    pacing: { minShotSec: 0.8, maxShotSec: 3.0, beatSync: true, speedRamps: false },
    transitions: ['fade', 'wipeleft', 'slideup'],
    colourPreset: 'natural',
    textDensity: 'medium',
    musicMoods: ['upbeat', 'pop', 'hip hop'],
  },
  clean_promo: {
    id: 'clean_promo',
    name: 'Clean promo',
    shortDescription: 'Polished, steady shots with the business name and a soft call to action.',
    brief:
      'Promotional edit. Steady, well-exposed shots only, 1.2–2.5 s each, gentle dissolves, business name text at the start and a soft call-to-action/handle at the end. Calm pacing, clean colour, no speed ramps.',
    requirement: { labelGroups: [['result', 'cutting', 'fade_detail', 'styling']], minUsableShots: 3 },
    pacing: { minShotSec: 1.2, maxShotSec: 2.5, beatSync: false, speedRamps: false },
    transitions: ['dissolve', 'fade'],
    colourPreset: 'clean',
    textDensity: 'medium',
    musicMoods: ['lo-fi', 'chill', 'jazz', 'acoustic'],
  },
  process_story: {
    id: 'process_story',
    name: 'Process story',
    shortDescription: 'A short narrative: start, the work, the finished result.',
    brief:
      'Short story in three acts: setup (before or first cut), the work (2–4 process shots in order), the result. Natural pacing 1–2.5 s, keep original sound where there is speech, captions only from the real transcript. Simple fades.',
    requirement: { labelGroups: [['cutting', 'fade_detail', 'styling'], ['result']], minUsableShots: 3 },
    pacing: { minShotSec: 1.0, maxShotSec: 2.5, beatSync: false, speedRamps: false },
    transitions: ['fade'],
    colourPreset: 'natural',
    textDensity: 'light',
    musicMoods: ['chill', 'acoustic', 'r&b'],
  },
};

export function getStyle(id: StyleId): StyleDefinition {
  return STYLES[id];
}
