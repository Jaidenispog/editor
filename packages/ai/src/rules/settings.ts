import {
  RESTRAINED_TRANSITIONS,
  STYLES,
  computeTimeline,
  editLengthForTrack,
  effectivePreferences,
  isDefaultPlanningStyle,
  type BeatsPerCut,
  type EditLengthForTrack,
  type EditingStyle,
  type TransitionPalette,
  type ZoomUse,
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

/**
 * The owner's accepted editing style (design §4.3.1.6) after revision hints: flashy palette types and accents are
 * dropped for "remove the flashy transitions", and "no transitions" leaves only hard cuts.
 */
export interface ResolvedEditingStyle {
  palette: TransitionPalette | null;
  /** The accent to place (null when there is none or a revision tamed the transitions). */
  accent: TransitionPalette['accent'];
  beatSync: 'auto' | 'on' | 'off';
  beatsPerCut: BeatsPerCut | null;
  reveal: 'style' | 'strongest_beat';
  zoom: ZoomUse;
}

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
  /** The editing style accepted from the owner's own videos; null when every value the planners use is the default. */
  styleFromVideos: ResolvedEditingStyle | null;
  /**
   * Set only by the editing-style fallback (`buildWithStyleFallback` in planner.ts): which of its steps this build is.
   * The build adds that step's plan note once it knows whether it kept the earlier version's joins.
   */
  styleFallback: StyleFallbackStep | null;
  notes: string[];
}

/** The steps of the editing-style fallback, each with its own plan note (see `STYLE_FALLBACK_NOTES` in planner.ts). */
export type StyleFallbackStep = 'transitionsOnly' | 'transitionsKeepRest' | 'wholeStyle';

/**
 * Resolves the accepted editing style for this plan; null when every value the planners use is the default (plans are
 * then unchanged). Only the planning fields count: an accepted music fit alone only ranks the owner's tracks.
 */
export function resolveEditingStyle(style: EditingStyle | undefined, transitionsHint: 'none' | 'restrained' | null): ResolvedEditingStyle | null {
  if (!style || isDefaultPlanningStyle(style)) return null;
  let palette = style.transitionPalette;
  let accent = palette?.accent ?? null;
  if (palette && transitionsHint === 'none') {
    palette = { ...palette, hardCutShare: 1, types: [], accent: null };
    accent = null;
  } else if (palette && transitionsHint === 'restrained') {
    palette = { ...palette, types: palette.types.filter((t) => RESTRAINED_TRANSITIONS.includes(t)), accent: null };
    accent = null;
  }
  return { palette, accent, beatSync: style.beatSync, beatsPerCut: style.beatsPerCut, reveal: style.reveal, zoom: style.zoom };
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
  // Learned values apply unless the owner pinned the field (idempotent, so already-resolved input is unchanged).
  const prefs = effectivePreferences(input.preferences);
  const hints = revisionHintsFor(input);
  const revising = Boolean(input.previousPlan && input.previousPlan.styleId === input.styleId && hints);
  const s: EffectiveSettings = {
    style,
    target: resolveTarget(input, hints),
    attempt: Math.max(0, Math.floor(input.attempt)),
    transitions: prefs.transitions === 'restrained' ? 'calm' : 'style',
    pacing: prefs.pacing === 'slow' ? 1.2 : prefs.pacing === 'fast' ? 0.8 : 1,
    // Light text is the style's normal amount; medium asks for more lines (none switches text off).
    text: prefs.textDensity === 'none' ? 'none' : prefs.textDensity === 'medium' ? 'more' : 'normal',
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
    styleFromVideos: null,
    styleFallback: null,
    notes: [],
  };
  let transitionsHint: 'none' | 'restrained' | null = null;
  const noteHint = (h: RevisionHints) => {
    if (h.transitions === 'none') transitionsHint = 'none';
    else if (h.transitions === 'restrained' && transitionsHint !== 'none') transitionsHint = 'restrained';
  };
  if (prefs.standingInstructions.trim()) {
    const h = parseRevisionInstruction(prefs.standingInstructions);
    applyHints(s, h);
    noteHint(h);
  }
  if (input.instructions.trim()) {
    const h = parseRevisionInstruction(input.instructions);
    applyHints(s, h);
    noteHint(h);
  }
  if (hints) {
    applyHints(s, hints);
    noteHint(hints);
  }
  s.styleFromVideos = resolveEditingStyle(prefs.editingStyle, transitionsHint);
  s.pacing = clamp(s.pacing, 0.55, 1.7);
  return s;
}

/**
 * The length this plan aims for once its music is known, by the rule in @studio/core (`editLengthForTrack`): the
 * requested (or revised) length, or a little less when the chosen track is a little shorter and plays from a start the
 * planner picks; a track too short for that is refused with a message for the owner. Without music (none chosen, or
 * switched off by an instruction) the length stays as asked.
 */
export function plannedLength(input: PlannerInput, s: Pick<EffectiveSettings, 'target' | 'musicOn'> = effectiveSettings(input)): EditLengthForTrack {
  if (!input.music || !s.musicOn) return { ok: true, targetSec: s.target, trimmed: false };
  return editLengthForTrack(s.target, input.music.durationSec);
}

/**
 * The length both planners aim for and the worker checks a plan against: {@link plannedLength}, or the requested length
 * when the track is too short (the rules planner then refuses the edit with the rule's message).
 */
export function plannedTargetSec(input: PlannerInput): number {
  const s = effectiveSettings(input);
  const length = plannedLength(input, s);
  return length.ok ? length.targetSec : s.target;
}

/** {@link effectiveSettings} with the target set to {@link plannedTargetSec} (for the AI brief and the AI plan). */
export function plannedSettings(input: PlannerInput): EffectiveSettings {
  const s = effectiveSettings(input);
  const length = plannedLength(input, s);
  if (length.ok) s.target = length.targetSec;
  return s;
}

/**
 * The beat option for this plan (both planners): the Sound panel's choice, else a revision's "cut to the beat" /
 * "ignore the beat", else the owner's accepted editing style, else automatic.
 */
export function beatSyncFor(input: Pick<PlannerInput, 'beatSync'>, s: Pick<EffectiveSettings, 'revisionHints' | 'styleFromVideos'>): 'auto' | 'on' | 'off' {
  if (input.beatSync && input.beatSync !== 'auto') return input.beatSync;
  const hinted = s.revisionHints?.beatSync;
  if (hinted === 'on' || hinted === 'off') return hinted;
  return s.styleFromVideos?.beatSync ?? 'auto';
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
