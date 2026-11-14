import {
  STYLES,
  computeTimeline,
  parseRevisionInstruction,
  type ColourPreset,
  type EditPlan,
  type RevisionHints,
  type SegmentLabel,
  type StyleDefinition,
  type TransitionType,
} from '@studio/core';
import type { PlannerInput } from '../types.js';
import { clamp } from './random.js';

/** Transitions the rules planner treats as calm (the validator also accepts fadewhite). */
export const CALM_TRANSITIONS: readonly TransitionType[] = ['fade', 'dissolve', 'fadeblack'];

/** Every knob the style builders read, after combining preferences, instructions and revision hints. */
export interface EffectiveSettings {
  style: StyleDefinition;
  target: number;
  attempt: number;
  /** 'calm' limits transitions to fade/dissolve/fadeblack; 'none' means hard cuts only. */
  transitions: 'style' | 'calm' | 'none';
  /** Multiplier on shot lengths (below 1 = faster cutting). */
  pacing: number;
  text: 'normal' | 'less' | 'none' | 'more';
  musicOn: boolean;
  musicVolume: number;
  originalSound: 'auto' | 'on' | 'off';
  opening: SegmentLabel | null;
  emphasise: SegmentLabel[];
  deemphasise: SegmentLabel[];
  colourPreset: ColourPreset;
  /** True when this call revises an earlier plan of the same style. */
  revising: boolean;
  /** Hints from the revision request only (null for a fresh plan). */
  revisionHints: RevisionHints | null;
  /** Mentions of a skin fade in the owner's own words (the only case "Skin fade" text is honest). */
  ownerMentionsSkinFade: boolean;
  notes: string[];
}

/** Hints for this call: explicit hints win, otherwise the revision instruction is parsed. */
export function revisionHintsFor(input: PlannerInput): RevisionHints | null {
  if (input.revisionHints) return input.revisionHints;
  if (input.revisionInstruction && input.revisionInstruction.trim()) return parseRevisionInstruction(input.revisionInstruction);
  return null;
}

/** Rounded total of an earlier plan (same rounding the worker uses for relative length requests). */
export function previousTotal(plan: EditPlan): number {
  return Math.round(computeTimeline(plan).totalDurationSec);
}

/** Resolves the length to aim for: an absolute or relative revision request, else the requested target. */
export function resolveTarget(input: PlannerInput, hints: RevisionHints | null): number {
  let target = input.targetDurationSec;
  const requested = hints?.targetDurationSec ?? null;
  if (requested !== null && requested !== undefined) {
    if (requested > 0) target = requested;
    else if (input.previousPlan) {
      const prev = previousTotal(input.previousPlan) || input.targetDurationSec;
      if (requested === -1) target = Math.max(8, Math.round(prev * 0.75));
      else if (requested === -2) target = Math.min(90, Math.round(prev * 1.3));
    }
  }
  return clamp(target, 5, 90);
}

/** Applies the non-length parts of a hint set on top of the current settings. */
function applyHints(s: EffectiveSettings, h: RevisionHints): void {
  if (h.transitions === 'none') s.transitions = 'none';
  else if (h.transitions === 'restrained' && s.transitions !== 'none') s.transitions = 'calm';
  if (h.pacing === 'faster') s.pacing *= 0.75;
  else if (h.pacing === 'slower') s.pacing *= 1.3;
  if (h.text !== 'keep') s.text = h.text;
  if (h.music === 'none') s.musicOn = false;
  else if (h.music === 'quieter') s.musicVolume = clamp(s.musicVolume * 0.7, 0.1, 1);
  else if (h.music === 'louder') s.musicVolume = clamp(s.musicVolume * 1.25, 0.1, 1);
  if (h.originalSound === 'on') s.originalSound = 'on';
  else if (h.originalSound === 'off') s.originalSound = 'off';
  if (h.opening) s.opening = h.opening;
  for (const l of h.emphasiseLabels) {
    if (!s.emphasise.includes(l)) s.emphasise.push(l);
    s.deemphasise = s.deemphasise.filter((x) => x !== l);
  }
  for (const l of h.deemphasiseLabels) {
    if (!s.deemphasise.includes(l)) s.deemphasise.push(l);
    s.emphasise = s.emphasise.filter((x) => x !== l);
  }
}

/**
 * Combines saved preferences, standing instructions, this generation's instructions and the revision request.
 * Only a revision request can change the length: the duration chosen in the UI is otherwise authoritative.
 */
export function effectiveSettings(input: PlannerInput): EffectiveSettings {
  const style = STYLES[input.styleId];
  const prefs = input.preferences;
  const hints = revisionHintsFor(input);
  const revising = Boolean(input.previousPlan && input.previousPlan.styleId === input.styleId && hints);
  const s: EffectiveSettings = {
    style,
    target: resolveTarget(input, hints),
    attempt: Math.max(0, Math.floor(input.attempt)),
    transitions: prefs.transitions === 'restrained' ? 'calm' : 'style',
    pacing: prefs.pacing === 'slow' ? 1.2 : prefs.pacing === 'fast' ? 0.8 : 1,
    text: prefs.textDensity === 'none' ? 'none' : 'normal',
    musicOn: true,
    musicVolume: clamp(prefs.musicVolume, 0.05, 1),
    originalSound: input.keepOriginalSound === 'never' ? 'off' : input.keepOriginalSound === 'always' ? 'on' : 'auto',
    opening: null,
    emphasise: [],
    deemphasise: [],
    // The owner's colour preference only overrides the style's look when it is not the default.
    colourPreset: prefs.colour !== 'natural' ? prefs.colour : style.colourPreset,
    revising,
    revisionHints: hints,
    ownerMentionsSkinFade: /\bskin[\s-]?fade\b/i.test(`${prefs.standingInstructions} ${input.instructions} ${input.revisionInstruction ?? ''}`),
    notes: [],
  };
  if (prefs.standingInstructions.trim()) applyHints(s, parseRevisionInstruction(prefs.standingInstructions));
  if (input.instructions.trim()) applyHints(s, parseRevisionInstruction(input.instructions));
  if (hints) applyHints(s, hints);
  s.pacing = clamp(s.pacing, 0.55, 1.7);
  return s;
}

/**
 * Picks a transition for this style and take from a preference list, honouring calm/none settings.
 * Returns null for a hard cut.
 */
export function chooseTransition(
  s: EffectiveSettings,
  preferred: readonly TransitionType[],
  durationSec: number,
  variant = 0,
): { type: TransitionType; durationSec: number } | null {
  if (s.transitions === 'none' || preferred.length === 0) return null;
  let options = [...preferred];
  if (s.transitions === 'calm') {
    options = options.filter((t) => CALM_TRANSITIONS.includes(t));
    if (options.length === 0) options = s.style.transitions.filter((t) => CALM_TRANSITIONS.includes(t));
    if (options.length === 0) options = ['dissolve', 'fade'];
  }
  const type = options[((variant % options.length) + options.length) % options.length]!;
  return { type, durationSec: Math.round(clamp(durationSec, 0.15, 1.5) * 100) / 100 };
}

/** Maps a transition onto the allowed set (used when revising a plan that had flashier choices). */
export function tameTransition(
  s: EffectiveSettings,
  t: { type: TransitionType; durationSec: number } | null,
): { type: TransitionType; durationSec: number } | null {
  if (!t) return null;
  if (s.transitions === 'none') return null;
  if (s.transitions === 'calm' && !CALM_TRANSITIONS.includes(t.type)) {
    return { type: 'dissolve', durationSec: Math.min(t.durationSec, 0.5) };
  }
  return t;
}
