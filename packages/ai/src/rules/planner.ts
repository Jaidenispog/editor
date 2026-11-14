import {
  AppError,
  CancelledError,
  EDIT_PLAN_VERSION,
  STYLES,
  VERTICAL_1080,
  computeTimeline,
  validateEditPlan,
  type AudioPlan,
  type EditPlan,
  type PlanIssue,
  type PlanValidationContext,
  type Segment,
  type SegmentLabel,
  type TextOverlay,
} from '@studio/core';
import type { AiCallOptions, EditPlanner, PlannerInput, PlannerResult } from '../types.js';
import { fitDuration, play, startTimes, totalDuration, grow, shrink, type Draft } from './draft.js';
import { collectFootage, type Candidate, type Footage } from './footage.js';
import { alignedCuts, beatGrid, type BeatGrid } from './music.js';
import { clamp, hashString, round, seededRandom } from './random.js';
import { effectiveSettings, tameTransition, type EffectiveSettings } from './settings.js';
import { STYLE_BUILDERS, applyOpening, type BuildContext, type Recipe } from './styles.js';
import { buildCaptions, resolveText } from './text.js';

const ROLE_TEXT: Record<SegmentLabel, string> = {
  before: 'the before shot',
  cutting: 'the clipper work',
  fade_detail: 'the fade detail',
  styling: 'the styling',
  result: 'the finished cut',
  reaction: "the client's reaction",
  environment: 'the shop',
  other: 'a clip',
  unknown: 'a clip',
};

/** Fraction of the target the rules planner aims to land within. */
const TARGET_SLACK = 0.05;

/**
 * Deterministic edit planner with no network access. It is the fallback whenever the AI planner is not
 * configured or fails, so it builds all five styles from real shots only, cuts to the beat grid, fits the
 * requested length, honours revision requests and validates every plan it returns.
 */
export class RulesPlanner implements EditPlanner {
  readonly name = 'rules';
  readonly model = null;

  /** Plans one edit; the result has already passed validateEditPlan. */
  async planEdit(input: PlannerInput, opts: AiCallOptions = {}): Promise<PlannerResult> {
    if (opts.signal?.aborted) throw new CancelledError();
    return { plan: this.plan(input), usage: null, source: 'rules' };
  }

  /** Synchronous core of planEdit (useful in tests and scripts). Throws AppError when the footage cannot support the style. */
  plan(input: PlannerInput): EditPlan {
    if (input.analyses.length === 0 || input.assets.length === 0) {
      throw new AppError('UNSUPPORTED', 'There are no processed clips to edit yet.');
    }
    const base = effectiveSettings(input);
    const footage = collectFootage(input.analyses, input.assets);
    if (footage.candidates.length === 0) {
      throw new AppError('PROCESSING_FAILED', 'None of the clips has a usable shot (they are too short, too dark or too blurry). Add clearer footage and try again.');
    }
    if (footage.relaxed) base.notes.push('Some shots with modest quality scores were used because few clearer shots were available.');
    capTargetToMusic(input, base);

    const previous = input.previousPlan;
    let attempt = base.attempt;
    let plan: EditPlan | null = null;
    for (let take = 0; take < 3; take++) {
      const s: EffectiveSettings = { ...base, attempt, notes: [...base.notes], emphasise: [...base.emphasise], deemphasise: [...base.deemphasise] };
      plan = buildPlan(input, s, footage);
      const isRegenerate = !s.revising && previous && attempt > 0;
      if (!isRegenerate || signature(plan) !== signature(previous)) return plan;
      attempt += 1;
    }
    return plan!;
  }
}

/** Shortens the target to the music when the chosen track is a little shorter than the edit. */
function capTargetToMusic(input: PlannerInput, s: EffectiveSettings): void {
  const music = input.music;
  if (!music || !s.musicOn) return;
  const room = Math.floor((music.durationSec - 0.15) * 10) / 10;
  if (room >= s.target) return;
  if (room < Math.max(5, s.target * 0.88)) {
    throw new AppError(
      'PROCESSING_FAILED',
      `The chosen track is ${Math.round(music.durationSec)} seconds long, which is shorter than the ${Math.round(s.target)}-second edit. Choose a longer track or a shorter length.`,
    );
  }
  s.target = room;
  s.notes.push(`The edit was trimmed to ${room} s so it ends before the music does.`);
}

/** Order of source ranges, used to tell whether a regenerated take differs from the previous one. */
function signature(plan: Pick<EditPlan, 'segments'>): string {
  return plan.segments.map((seg) => `${seg.assetId}@${seg.inSec.toFixed(1)}`).join('>');
}

function buildPlan(input: PlannerInput, s: EffectiveSettings, footage: Footage): EditPlan {
  const previous = s.revising ? (input.previousPlan ?? null) : null;
  const taken = new Set(previous?.segments.map((seg) => seg.id) ?? []);
  let counter = 0;
  const nextId = () => {
    let id: string;
    do id = `seg-${++counter}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
  const needsGrid = input.styleId === 'beat_montage' || Boolean(input.music && s.musicOn);
  const preferStart = previous?.audio.music?.startOffsetSec;
  const grid = needsGrid ? beatGrid(s.musicOn ? input.music : null, s.target, s.attempt, preferStart) : null;
  const ctx: BuildContext = {
    input,
    s,
    footage,
    grid,
    rng: seededRandom(hashString(`${input.styleId}|${s.attempt}|${footage.candidates.map((c) => c.shotId).join(',')}`)),
    nextId,
    notes: s.notes,
  };

  const fresh = STYLE_BUILDERS[input.styleId](ctx);
  const recipe = fresh.recipe;
  let drafts = fresh.drafts;
  if (previous && !recipe.exact) {
    const mapped = draftsFromPlan(ctx, previous);
    if (mapped) {
      drafts = mapped;
      applyRevisionHints(ctx, drafts, recipe);
    } else {
      ctx.notes.push('The earlier version no longer matches the clips in this project, so this version was rebuilt from scratch.');
    }
  } else if (previous && recipe.exact) {
    ctx.notes.push('Rebuilt on the beat grid so every cut still lands on a beat at the new settings.');
  }
  if (!previous || recipe.exact) applyOpening(ctx, drafts, recipe);

  const retransition = (list: Draft[]) => {
    list.forEach((d, i) => {
      if (i === 0) d.transitionIn = null;
      else if (d.autoTransition) d.transitionIn = recipe.transitionFor(list, i);
    });
  };
  retransition(drafts);
  const fit = () =>
    fitDuration(drafts, {
      target: s.target,
      tolerance: Math.max(0.12, s.target * 0.015),
      minSegments: recipe.minSegments,
      addFiller: makeFillerAdder(recipe),
      retransition,
      allowSlowdown: recipe.allowSlowdown,
      notes: ctx.notes,
    });
  if (!recipe.exact) fit();
  recipe.finish(drafts);

  const keepPreviousText = Boolean(previous && !recipe.exact && previous.textOverlays.length > 0 && s.text !== 'none');
  const textFor = (list: Draft[]): TextOverlay[] => {
    if (s.text === 'none') return [];
    if (keepPreviousText && previous) {
      let out = retimeOverlays(previous, list);
      if (s.text === 'less') out = out.slice(0, 1);
      if (s.text === 'more') {
        const extra = recipe.extraText(list);
        if (extra) out = mergeOverlays(out, resolveText([extra], list));
      }
      return out;
    }
    let intents = recipe.textIntents(list);
    if (s.text === 'less') intents = intents.slice(0, 1);
    if (s.text === 'more') {
      const extra = recipe.extraText(list);
      if (extra) intents = [...intents, extra];
    }
    return resolveText(intents, list);
  };

  const captionsWanted =
    input.captions !== 'never' &&
    input.preferences.captions !== 'never' &&
    s.text !== 'none' &&
    Object.keys(footage.transcripts).length > 0 &&
    (input.styleId === 'process_story' || (previous?.captions.length ?? 0) > 0);

  const state: ComposeState = {
    bannedText: new Set<string>(),
    captionsOn: captionsWanted,
    musicOn: Boolean(input.music && s.musicOn),
    musicOffset: grid?.fromMusic ? grid.startOffsetSec : 0,
  };
  const vctx: PlanValidationContext = {
    assets: input.assets,
    music: input.music ? { trackId: input.music.trackId, durationSec: input.music.durationSec } : null,
    transcripts: footage.transcripts,
    durationBounds: { min: s.target * (1 - TARGET_SLACK), max: s.target * (1 + TARGET_SLACK) },
    restrainedTransitionsOnly: s.transitions !== 'style',
  };

  let lastErrors: PlanIssue[] = [];
  for (let round = 0; round < 8; round++) {
    const plan = compose(ctx, drafts, textFor, state, previous, grid);
    const res = validateEditPlan(plan, vctx);
    if (res.ok && res.plan) return res.plan;
    lastErrors = res.errors;
    if (!repair(ctx, drafts, plan, res.errors, state, fit, retransition)) break;
  }
  // Last chance: accept a plan that is a little off the ±5 % aim but inside the window the worker allows.
  const plan = compose(ctx, drafts, textFor, state, previous, grid);
  const slack = Math.max(2, s.target * 0.12);
  const loose = validateEditPlan(plan, { ...vctx, durationBounds: { min: s.target - slack, max: s.target + slack } });
  if (loose.ok && loose.plan) return loose.plan;
  const durationOnly = (loose.errors.length ? loose.errors : lastErrors).every((e) => e.code === 'DURATION_OUT_OF_RANGE');
  const name = STYLES[input.styleId].name.toLowerCase();
  throw new AppError(
    'PROCESSING_FAILED',
    durationOnly
      ? `There is not enough usable footage for a ${Math.round(s.target)}-second ${name}. Add more clips or choose a shorter length.`
      : `The ${name} could not be built from this footage.`,
    { details: { errors: loose.errors.length ? loose.errors : lastErrors } },
  );
}

function makeFillerAdder(recipe: Recipe): (drafts: Draft[], allowReuse: boolean) => boolean {
  let pointer = 0;
  return (drafts, allowReuse) => {
    const list = recipe.fillers;
    for (let k = 0; k < list.length; k++) {
      const cand = list[(pointer + k) % list.length]!;
      const d = recipe.makeFiller(cand, drafts, allowReuse);
      if (d) {
        recipe.insert(drafts, d);
        pointer = (pointer + k + 1) % list.length;
        return true;
      }
    }
    return false;
  };
}

// ---------------------------------------------------------------- revisions

/** Maps an earlier plan's segments back onto the current footage so a revision keeps its choices. */
function draftsFromPlan(ctx: BuildContext, prev: EditPlan): Draft[] | null {
  const { footage, s } = ctx;
  const style = s.style;
  const drafts: Draft[] = [];
  prev.segments.forEach((seg: Segment, index) => {
    const asset = footage.assetsById.get(seg.assetId);
    if (!asset) return;
    const inSec = Math.max(0, seg.inSec);
    const outSec = Math.min(seg.outSec, asset.durationSec);
    if (outSec - inSec < 0.2) return;
    const mid = (inSec + outSec) / 2;
    const shot = footage.allShots.find((c) => c.assetId === seg.assetId && c.startSec <= mid && c.endSec >= mid);
    const cand: Candidate = shot
      ? { ...shot, startSec: Math.min(shot.startSec, inSec), endSec: Math.min(asset.durationSec, Math.max(shot.endSec, outSec)) }
      : {
          shotId: `${seg.assetId}-${index}`,
          assetId: seg.assetId,
          assetIndex: footage.allShots.find((c) => c.assetId === seg.assetId)?.assetIndex ?? 0,
          shotIndex: index,
          order: index,
          startSec: inSec,
          endSec: outSec,
          label: seg.role,
          labelSource: 'heuristic',
          score: 0.5,
          motion: 0,
          focus: null,
          hasAudio: asset.hasAudio,
          speech: footage.transcripts[seg.assetId]?.filter((t) => t.endSec > inSec && t.startSec < outSec) ?? [],
        };
    const p = (outSec - inSec) / seg.speed;
    const last = index === prev.segments.length - 1;
    drafts.push({
      id: seg.id,
      cand,
      inSec,
      outSec,
      speed: seg.speed,
      zoom: seg.zoom,
      transitionIn: tameTransition(s, seg.transitionIn),
      role: seg.role,
      keepOriginalSound: seg.keepOriginalSound,
      softMin: Math.min(p, Math.max(0.4, style.pacing.minShotSec)),
      softMax: Math.max(p, style.pacing.maxShotSec, last ? 5 : 0),
      pinned: index === 0 || last,
      weight: index === 0 || last ? 10 : 2,
      keep: seg.role === 'result' ? 'end' : seg.role === 'before' ? 'start' : 'centre',
      slot: 'body',
      autoTransition: false,
    });
  });
  if (drafts.length === 0) return null;
  inferSlots(ctx.input.styleId, drafts);
  for (const d of drafts) {
    if (s.emphasise.includes(d.role)) d.weight = Math.max(d.weight, 8);
    if (s.deemphasise.includes(d.role) && !d.pinned) d.weight = 0;
  }
  return drafts;
}

/** Gives revised drafts the structural slots the style's text and transitions refer to. */
function inferSlots(styleId: PlannerInput['styleId'], drafts: Draft[]): void {
  drafts.forEach((d, i) => (d.slot = i === 0 ? 'open' : i === drafts.length - 1 ? 'final' : 'body'));
  if (styleId !== 'before_after') return;
  const first = drafts[0];
  if (first && first.role === 'before') first.slot = 'before';
  const reveal = drafts.findIndex((d, i) => i > 0 && d.role === 'result');
  if (reveal > 0) {
    drafts.forEach((d, i) => {
      if (i > 0 && i < reveal) d.slot = 'bridge';
      else if (i === reveal) d.slot = 'reveal';
      else if (i > reveal) d.slot = 'hold2';
    });
  }
}

/** Applies a revision request to the mapped drafts before the length is fitted. */
function applyRevisionHints(ctx: BuildContext, drafts: Draft[], recipe: Recipe): void {
  const { s } = ctx;
  const hints = s.revisionHints;
  if (!hints) return;

  if (hints.pacing !== 'keep') {
    const factor = hints.pacing === 'faster' ? 0.75 : 1.3;
    for (const d of drafts) {
      d.softMin *= factor;
      d.softMax *= factor;
      if (d.pinned) continue;
      const target = play(d) * factor;
      if (factor < 1) shrink(d, play(d) - target, Math.max(0.4, d.softMin));
      else grow(d, drafts, target - play(d));
    }
  }

  if (hints.emphasiseLabels.length > 0) {
    const emphasised = drafts.filter((d) => hints.emphasiseLabels.includes(d.role));
    for (const d of emphasised) {
      grow(d, drafts, play(d) * 0.4);
      d.softMin = Math.max(d.softMin, play(d));
      d.softMax = Math.max(d.softMax * 1.4, play(d));
      d.weight = Math.max(d.weight, 8);
    }
    let added = 0;
    const extra = ctx.footage.candidates.filter((c) => hints.emphasiseLabels.includes(c.label));
    for (const cand of extra) {
      if (added >= 2) break;
      const d = recipe.makeFiller(cand, drafts, false);
      if (!d) continue;
      d.weight = 8;
      d.softMin = Math.max(d.softMin, play(d) * 0.9);
      recipe.insert(drafts, d);
      added++;
    }
    if (emphasised.length === 0 && added === 0) {
      ctx.notes.push(`No shots are identified as ${hints.emphasiseLabels.map((l) => ROLE_TEXT[l].replace(/^the /, '')).join(' or ')}, so that part could not be featured more. Tag those clips and revise again.`);
    }
  }

  if (hints.deemphasiseLabels.length > 0) {
    for (const d of drafts) {
      if (!hints.deemphasiseLabels.includes(d.role)) continue;
      d.softMax = d.softMin;
      d.weight = d.pinned ? d.weight : 0;
      shrink(d, play(d) - d.softMin, Math.max(0.4, d.softMin));
    }
  }

  if (hints.opening) {
    const idx = drafts.findIndex((d) => d.role === hints.opening);
    if (idx > 0 && ctx.input.styleId !== 'before_after') {
      const [d] = drafts.splice(idx, 1);
      if (d) {
        drafts.unshift(d);
        d.pinned = true;
        d.weight = 10;
      }
      inferSlots(ctx.input.styleId, drafts);
    } else if (idx < 0) {
      const cand = ctx.footage.candidates.find((c) => c.label === hints.opening);
      const d = cand ? recipe.makeFiller(cand, drafts, false) : null;
      if (d) {
        drafts.unshift(d);
        d.pinned = true;
        d.weight = 10;
        inferSlots(ctx.input.styleId, drafts);
      } else {
        ctx.notes.push('No shot matches the requested opening, so the opening was kept.');
      }
    }
  }
  if (hints.transitions !== 'keep') ctx.notes.push(hints.transitions === 'none' ? 'Transitions were replaced with straight cuts.' : 'Flashy transitions were replaced with simple dissolves.');
}

/** Re-times an earlier plan's text so each line stays with the shot it belonged to. */
function retimeOverlays(prev: EditPlan, drafts: readonly Draft[]): TextOverlay[] {
  const prevTimeline = computeTimeline(prev);
  const prevTotal = prevTimeline.totalDurationSec;
  const starts = startTimes(drafts);
  const total = totalDuration(drafts);
  const byId = new Map(drafts.map((d, i) => [d.id, i]));
  const out: TextOverlay[] = [];
  for (const o of prev.textOverlays) {
    const anchor = [...prevTimeline.segments].reverse().find((p) => p.startSec <= o.startSec + 1e-6) ?? prevTimeline.segments[0];
    if (!anchor) continue;
    const i = byId.get(anchor.segment.id);
    const d = i === undefined ? undefined : drafts[i];
    if (i === undefined || !d) continue;
    const offset = Math.min(o.startSec - anchor.startSec, play(d) * 0.6);
    const untilEnd = o.endSec >= prevTotal - 0.35;
    const start = (starts[i] ?? 0) + Math.max(0, offset);
    const end = Math.min(untilEnd ? total - 0.2 : start + (o.endSec - o.startSec), total - 0.05);
    if (end - start < 0.6) continue;
    const candidate = { ...o, startSec: round(start, 2), endSec: round(end, 2) };
    if (out.some((x) => x.placement === candidate.placement && candidate.startSec < x.endSec && x.startSec < candidate.endSec)) continue;
    out.push(candidate);
  }
  return out;
}

/** Adds overlays that do not clash with existing ones in the same position. */
function mergeOverlays(base: TextOverlay[], extra: TextOverlay[]): TextOverlay[] {
  const out = [...base];
  for (const e of extra) {
    if (out.some((x) => x.placement === e.placement && e.startSec < x.endSec && x.startSec < e.endSec)) continue;
    out.push({ ...e, id: `text-${out.length + 1}` });
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------- composition and repair

interface ComposeState {
  bannedText: Set<string>;
  captionsOn: boolean;
  musicOn: boolean;
  musicOffset: number;
}

function overlapsSpeech(d: Draft, transcripts: Footage['transcripts']): boolean {
  const speech = transcripts[d.cand.assetId];
  if (!speech) return false;
  return speech.some((t) => Math.min(d.outSec, t.endSec) - Math.max(d.inSec, t.startSec) >= 0.3);
}

function compose(
  ctx: BuildContext,
  drafts: Draft[],
  textFor: (list: Draft[]) => TextOverlay[],
  state: ComposeState,
  previous: EditPlan | null,
  grid: BeatGrid | null,
): EditPlan {
  const { input, s, footage } = ctx;
  const style = s.style;
  const total = totalDuration(drafts);
  const starts = startTimes(drafts);

  const anyAudio = drafts.some((d) => d.cand.hasAudio);
  const music = input.music && state.musicOn ? input.music : null;
  let originalEnabled = false;
  const keep = drafts.map(() => false);
  if (s.originalSound === 'on') originalEnabled = anyAudio;
  else if (s.originalSound === 'auto') {
    if (!music) originalEnabled = anyAudio;
    else if (input.styleId === 'process_story') drafts.forEach((d, i) => (keep[i] = d.cand.hasAudio && overlapsSpeech(d, footage.transcripts)));
  }

  const segments: Segment[] = drafts.map((d, i) => ({
    id: d.id,
    assetId: d.cand.assetId,
    inSec: round(d.inSec, 3),
    outSec: round(d.outSec, 3),
    speed: round(d.speed, 3),
    framing: d.cand.focus
      ? { mode: 'focus' as const, focusX: round(clamp(d.cand.focus.x, 0, 1), 3), focusY: round(clamp(d.cand.focus.y, 0, 1), 3) }
      : { mode: 'centre' as const, focusX: 0.5, focusY: 0.5 },
    zoom: d.zoom,
    transitionIn: i === 0 ? null : d.transitionIn,
    role: d.role,
    keepOriginalSound: keep[i] ?? false,
  }));

  let musicPlan: AudioPlan['music'] = null;
  if (music) {
    const prevMusic = previous?.audio.music;
    const change = s.revisionHints?.music === 'quieter' ? 0.7 : s.revisionHints?.music === 'louder' ? 1.25 : 1;
    const volume = prevMusic ? prevMusic.volume * change : s.musicVolume;
    const offset = clamp(state.musicOffset, 0, Math.max(0, music.durationSec - total - 0.1));
    musicPlan = {
      trackId: music.trackId,
      startOffsetSec: round(offset, 3),
      volume: round(clamp(volume, 0, 1), 3),
      fadeInSec: 0.3,
      fadeOutSec: round(Math.min(1.2, total / 4), 2),
      duckUnderOriginal: true,
    };
  }
  const cutTimes = starts.slice(1).map((t, i) => t + (drafts[i + 1]?.transitionIn?.durationSec ?? 0));
  const beatAlignment =
    musicPlan && grid?.fromMusic ? { bpm: grid.bpm && grid.bpm > 0 ? round(grid.bpm, 1) : null, alignedCutTimesSec: alignedCuts(grid, cutTimes) } : null;

  const overlays = textFor(drafts).filter((o) => !state.bannedText.has(o.text));
  const captions = state.captionsOn ? buildCaptions(drafts, footage.transcripts) : [];
  if (!music && !originalEnabled && !keep.some(Boolean)) ctx.notes.push('This edit has no sound: there is no music and the original sound is switched off.');

  const title = previous?.title ?? `${style.name}${s.attempt > 0 ? ` · take ${s.attempt + 1}` : ''}`;
  return {
    version: EDIT_PLAN_VERSION,
    styleId: input.styleId,
    title: title.slice(0, 80),
    description: describe(ctx, drafts, total, music?.title ?? null, originalEnabled || keep.some(Boolean)),
    rationale: [...new Set(ctx.notes)].join(' ').slice(0, 2000),
    output: VERTICAL_1080,
    targetDurationSec: round(clamp(s.target, 5, 90), 2),
    segments,
    textOverlays: overlays,
    captions,
    audio: {
      music: musicPlan,
      originalSound: { enabled: originalEnabled, volume: 1 },
      beatAlignment,
      loudnessTargetLufs: -14,
    },
    colourPreset: previous?.colourPreset ?? s.colourPreset,
  };
}

/** A factual one-paragraph description of the edit that was actually built (max 280 characters). */
function describe(ctx: BuildContext, drafts: Draft[], total: number, musicTitle: string | null, originalSound: boolean): string {
  const first = drafts[0];
  const last = drafts[drafts.length - 1];
  const types = new Set(drafts.slice(1).map((d) => d.transitionIn?.type ?? 'cut'));
  const linking =
    types.size === 1 && types.has('cut')
      ? 'straight cuts'
      : [...types]
          .filter((t) => t !== 'cut')
          .map((t) => ({ fade: 'fades', dissolve: 'dissolves', fadeblack: 'a dip to black', fadewhite: 'a flash to white', wipeleft: 'a wipe', wiperight: 'a wipe', slideup: 'a slide', slidedown: 'a slide', circleopen: 'an iris', zoomin: 'a zoom' })[t] ?? t)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .join(' and ');
  const sound = musicTitle ? `cut to "${musicTitle}"` : originalSound ? 'with the original sound' : 'without sound';
  const parts = [
    `${Math.round(total)}-second ${ctx.s.style.name.toLowerCase()} from ${drafts.length} shot${drafts.length === 1 ? '' : 's'}`,
    `opens on ${ROLE_TEXT[first?.role ?? 'unknown']} and ends on ${ROLE_TEXT[last?.role ?? 'unknown']}`,
    `linked with ${linking}`,
    sound,
  ];
  let text = `${parts.join(', ')}.`;
  if (text.length > 280) text = `${text.slice(0, 277).replace(/\s+\S*$/, '')}…`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Applies fixes for validation errors; returns false when nothing could be changed. */
function repair(
  ctx: BuildContext,
  drafts: Draft[],
  plan: EditPlan,
  errors: PlanIssue[],
  state: ComposeState,
  fit: () => void,
  retransition: (list: Draft[]) => void,
): boolean {
  let changed = false;
  let refit = false;
  const indexOf = (e: PlanIssue) => {
    const m = e.path?.match(/^(segments|textOverlays|captions)\.(\d+)/);
    return m ? Number(m[2]) : -1;
  };
  const removals = new Set<number>();
  for (const e of errors) {
    const i = indexOf(e);
    const d = i >= 0 ? drafts[i] : undefined;
    switch (e.code) {
      case 'TRANSITION_TOO_LONG':
        if (d?.transitionIn) {
          const t = d.transitionIn.durationSec * 0.6;
          d.transitionIn = t >= 0.2 ? { ...d.transitionIn, durationSec: round(t, 2) } : null;
          d.autoTransition = false;
          changed = true;
          refit = true;
        }
        break;
      case 'FLASHY_TRANSITION':
        if (d) {
          d.transitionIn = tameTransition({ ...ctx.s, transitions: 'calm' }, d.transitionIn);
          d.autoTransition = false;
          changed = true;
        }
        break;
      case 'FIRST_TRANSITION':
        if (drafts[0]) drafts[0].transitionIn = null;
        changed = true;
        break;
      case 'SEGMENT_TOO_SHORT':
      case 'EMPTY_RANGE':
        if (i >= 0 && drafts.length > 1) removals.add(i);
        break;
      case 'OUT_OF_BOUNDS':
        if (d) {
          const asset = ctx.footage.assetsById.get(d.cand.assetId);
          if (asset) {
            d.outSec = Math.min(d.outSec, asset.durationSec);
            changed = true;
            refit = true;
          }
        }
        break;
      case 'DURATION_OUT_OF_RANGE':
        refit = true;
        changed = true;
        break;
      case 'MUSIC_TOO_SHORT': {
        const music = ctx.input.music;
        if (music) {
          const total = totalDuration(drafts);
          const next = Math.max(0, music.durationSec - total - 0.1);
          if (next < state.musicOffset) {
            state.musicOffset = next;
            changed = true;
          } else {
            refit = true;
          }
        }
        break;
      }
      case 'UNKNOWN_TRACK':
        state.musicOn = false;
        changed = true;
        break;
      default:
        if (e.code.startsWith('TEXT_')) {
          const o = plan.textOverlays[i];
          if (o) {
            state.bannedText.add(o.text);
            changed = true;
          }
        } else if (e.code.startsWith('CAPTION_')) {
          if (state.captionsOn) {
            state.captionsOn = false;
            changed = true;
          }
        }
    }
  }
  if (removals.size > 0) {
    for (const i of [...removals].sort((a, b) => b - a)) drafts.splice(i, 1);
    retransition(drafts);
    changed = true;
    refit = true;
  }
  if (refit) fit();
  return changed;
}
