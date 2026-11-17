import { computeTimeline, formatSeconds, hasBeatGrid, type Segment, type StyleId, type TransitionType } from '@studio/core';
import { extension, freeIntervals, play, startTimes, type Draft } from './draft.js';
import { NO_CLEAR_BEAT_NOTES, cutTime, landRevealOnBeat, nearestBeatIndex, shiftCut, strongestBeat, startBeatsThatFit, type BeatGrid } from './music.js';
import { round } from './random.js';
import { CALM_TRANSITIONS, type EffectiveSettings, type ResolvedEditingStyle } from './settings.js';
import type { BuildContext, Recipe } from './styles.js';
import type { PlannerInput } from '../types.js';

/**
 * The owner's editing style, measured from their own posted videos and accepted in Settings (design §4.3.1.6), applied
 * in the renderer's existing vocabulary only: palette transitions at joins, accents whose brightest or darkest moment
 * lands on the beat, beat-step shot lengths, the reveal on the track's strongest beat and segment zooms. Each style
 * keeps its character, so the five edits stay different. With the default editing style nothing here runs.
 */

/** FFmpeg's fadewhite/fadeblack reach their extreme about 20 % into the transition (measured, design §4.3.1.3a). */
export const ACCENT_PEAK_FRACTION = 0.2;
const ACCENT_TYPES: readonly TransitionType[] = ['fadewhite', 'fadeblack'];

/** Low-discrepancy choice for join i: the hard-cut share holds within one join and each take differs. */
function frac(i: number, attempt: number): number {
  const v = i * 0.618 + attempt * 0.37;
  return v - Math.floor(v);
}

export function isAccent(t: Draft['transitionIn']): boolean {
  return Boolean(t && ACCENT_TYPES.includes(t.type));
}

/** The moment a join is felt: an accent's peak, otherwise the end of the transition (the cut for a hard cut). */
export function feltCutTime(drafts: readonly Draft[], i: number): number {
  const d = drafts[i];
  const t = d?.transitionIn;
  if (!d || !t) return cutTime(drafts, i);
  const start = startTimes(drafts)[i] ?? 0;
  return isAccent(t) ? start + ACCENT_PEAK_FRACTION * t.durationSec : start + t.durationSec;
}

/**
 * The output time of each join of a plan as it plays: from its segments, timed the way the renderer times them
 * (`computeTimeline`), so a millisecond rounded off a segment's source range moves the join too. A join is felt at the
 * end of its transition (the cut for a hard cut), or at an accent's peak when `accentPeaks` (an accent accepted from the
 * owner's videos). Both planners report a plan's beat alignment from these times.
 */
export function feltJoinTimes(segments: readonly Segment[], accentPeaks: boolean): number[] {
  return computeTimeline({ segments: [...segments] })
    .segments.slice(1)
    .map((p) => {
      const t = p.segment.transitionIn;
      return p.startSec + (accentPeaks && isAccent(t) ? ACCENT_PEAK_FRACTION * t!.durationSec : (t?.durationSec ?? 0));
    });
}

/** The draft that shows the finished look (the "reveal") for each style, or -1. */
export function revealIndex(styleId: StyleId, drafts: readonly Draft[]): number {
  if (drafts.length < 2) return -1;
  if (styleId === 'beat_montage') return drafts.length - 1;
  if (styleId === 'before_after') {
    const r = drafts.findIndex((d) => d.slot === 'reveal');
    if (r > 0) return r;
  }
  if (styleId === 'cinematic_reveal') {
    const r = drafts.findIndex((d) => d.slot === 'final');
    if (r > 0) return r;
  }
  return drafts.findIndex((d, i) => i > 0 && d.role === 'result');
}

/**
 * Wraps a style's transition choice with the accepted palette (design §4.3.1.6 table): palette joins where the style
 * allows them, the accent at the style's reveal join, everything else the style's own.
 */
export function withPalette(ctx: BuildContext, base: Recipe['transitionFor']): Recipe['transitionFor'] {
  const es = ctx.s.styleFromVideos;
  const palette = es?.palette;
  if (!es || !palette || ctx.input.styleId === 'beat_montage') return base;
  const styleId = ctx.input.styleId;
  return (list, i) => {
    const d = list[i];
    if (!d || i === 0 || ctx.s.transitions === 'none') return base(list, i);
    /** Records who chose the join (the palette, or the style), for the plan note (paletteNoteFor). */
    const by = (videos: boolean, t: Draft['transitionIn']): Draft['transitionIn'] => {
      d.joinFrom = videos ? 'videos' : undefined;
      return t;
    };
    const reveal = i === revealIndex(styleId, list);
    if (reveal && styleId !== 'clean_promo' && es.accent) return by(true, { type: es.accent.type, durationSec: es.accent.durationSec });
    if (reveal && (styleId === 'cinematic_reveal' || styleId === 'before_after')) return by(false, base(list, i));
    if (styleId === 'before_after' && d.slot === 'hold2') return by(false, base(list, i));
    const hard = frac(i, ctx.s.attempt) < palette.hardCutShare;
    if (styleId === 'clean_promo') {
      // Clean promo keeps its calm look: only the straight-cut share and the cross-fade length are taken.
      if (hard) return by(true, null);
      const b = base(list, i);
      if (!b) return by(false, null);
      return palette.types.some((t) => t === 'fade' || t === 'dissolve') ? by(true, { ...b, durationSec: palette.durationSec }) : by(false, b);
    }
    if (hard) return by(true, null);
    let types = palette.types;
    if (styleId === 'cinematic_reveal' || ctx.s.transitions === 'calm') types = types.filter((t) => CALM_TRANSITIONS.includes(t));
    // No palette transition this style may use here (calm transitions only): the style keeps its own.
    if (types.length === 0) return palette.types.length === 0 ? by(true, null) : by(false, base(list, i));
    return by(true, { type: types[i % types.length]!, durationSec: palette.durationSec });
  };
}

/** Adds a transition centred so that `fraction` of it lies before the existing (hard) cut; false when the footage cannot. */
function placeAroundCut(drafts: Draft[], i: number, type: TransitionType, durationSec: number, fraction: number): boolean {
  const prev = drafts[i - 1];
  const cur = drafts[i];
  if (!prev || !cur || cur.transitionIn) return false;
  const after = (1 - fraction) * durationSec;
  const before = fraction * durationSec;
  if (extension(prev, drafts).forward + 1e-6 < after * prev.speed) return false;
  if (extension(cur, drafts).backward + 1e-6 < before * cur.speed) return false;
  const prevIn = i >= 2 ? (prev.transitionIn?.durationSec ?? 0) : 0;
  if (play(prev) + after < durationSec + prevIn + 0.2) return false;
  if (play(cur) + before < durationSec + 0.2) return false;
  prev.outSec += after * prev.speed;
  cur.inSec -= before * cur.speed;
  cur.transitionIn = { type, durationSec: round(durationSec, 2) };
  return true;
}

/**
 * Beat montage: palette joins and accents on the beat grid (design §4.3.1.6). Accents go on joins whose cut falls on
 * beat index ≡ 0 (mod everyBeats) from where the music starts, at most one per 2 s, and at the final shot; each is
 * placed so its peak lands on the beat, and the shots either side are lengthened so the total stays the same.
 */
export function applyMontagePalette(ctx: BuildContext, drafts: Draft[], grid: BeatGrid): void {
  const es = ctx.s.styleFromVideos;
  const palette = es?.palette;
  if (!es || !palette || ctx.s.transitions === 'none') return;
  const last = drafts[drafts.length - 1];
  if (last && drafts.length > 1 && last.transitionIn) {
    // The style's own fade into the final shot becomes a hard cut on the same beat.
    last.inSec += last.transitionIn.durationSec * last.speed;
    last.transitionIn = null;
  }
  let lastAccent = Number.NEGATIVE_INFINITY;
  let others = 0;
  for (let j = 1; j < drafts.length; j++) {
    const t = cutTime(drafts, j);
    const idx = nearestBeatIndex(grid, t);
    const final = j === drafts.length - 1;
    const accent = es.accent;
    // Who chose the join, for the plan note (paletteNoteFor): the palette, unless the join already has the montage's own
    // transition or the palette wanted a transition here that the footage has no room for (the montage's own straight
    // cut stays).
    drafts[j]!.joinFrom = drafts[j]!.transitionIn ? undefined : 'videos';
    if (accent && ((accent.everyBeats && idx % accent.everyBeats === 0 && t - lastAccent >= 2 - 1e-6) || final)) {
      if (placeAroundCut(drafts, j, accent.type, accent.durationSec, ACCENT_PEAK_FRACTION)) {
        lastAccent = t;
        continue;
      }
    }
    if (palette.types.length && frac(j, ctx.s.attempt) >= palette.hardCutShare) {
      let types = palette.types;
      if (ctx.s.transitions === 'calm') types = types.filter((x) => CALM_TRANSITIONS.includes(x));
      const type = types[others % Math.max(1, types.length)];
      if (type && placeAroundCut(drafts, j, type, Math.min(palette.durationSec, 0.4), 0.5)) others++;
      else drafts[j]!.joinFrom = undefined;
    }
  }
  // The note describes the joins and accents the finished plan has (see paletteNoteFor), so it is written once the plan
  // is final.
  ctx.notes.push(PALETTE_NOTE_SLOT);
}

/**
 * Where the plan note for the accepted transitions goes among the plan notes. The note is written from the finished
 * plan ({@link paletteNoteFor}) when the plan is composed, since later steps (fitting, the beat, the reveal, repairs) can
 * still move or drop an accent; a plan never says it has a flash it does not have.
 */
export const PALETTE_NOTE_SLOT = '\u0000accepted transitions';

/** Notes for fitted styles once the palette has shaped the joins: written from the finished plan (paletteNoteFor). */
export function notePalette(ctx: BuildContext): void {
  const es = ctx.s.styleFromVideos;
  if (!es?.palette || ctx.input.styleId === 'beat_montage' || ctx.s.transitions === 'none') return;
  ctx.notes.push(PALETTE_NOTE_SLOT);
}

/** The accents of the owner's palette in a finished plan, by where they are (see {@link placedAccents}). */
export interface PlacedAccents {
  type: 'fadewhite' | 'fadeblack';
  /** The beat montage's accents on a beat whose index from where the grid starts is a multiple of `everyBeats`. */
  onBeats: Array<{ beatIndex: number; atSec: number }>;
  everyBeats: number | null;
  /** True when the join into the reveal (the finished look) is an accent. */
  atReveal: boolean;
  /** Any other accent the palette placed (for example a montage accent whose peak is not on such a beat). */
  other: number;
}

/** Who chose each join of a plan, by segment index (see `Draft.joinFrom`; absent: the style). */
export type JoinOrigins = ReadonlyArray<Draft['joinFrom']>;

/**
 * Finds the accents of the owner's palette (the accepted accent type, at joins the palette chose: `joinFrom`) in a
 * finished plan's segments, timed as the renderer plays them: the one into the reveal (`revealAt`, the segment index of
 * the finished look), the beat montage's on every `everyBeats`-th beat of `grid` (peak within 40 ms of a beat whose index
 * is a multiple of it), and the rest. Pure.
 */
export function placedAccents(styleId: StyleId, segments: readonly Segment[], joinFrom: JoinOrigins, revealAt: number, grid: BeatGrid | null, accent: NonNullable<ResolvedEditingStyle['accent']>): PlacedAccents {
  const placed: PlacedAccents = { type: accent.type, onBeats: [], everyBeats: accent.everyBeats, atReveal: false, other: 0 };
  computeTimeline({ segments: [...segments] }).segments.forEach((p, i) => {
    const t = p.segment.transitionIn;
    if (i === 0 || !t || t.type !== accent.type || joinFrom[i] !== 'videos') return;
    if (i === revealAt) return void (placed.atReveal = true);
    const peak = p.startSec + ACCENT_PEAK_FRACTION * t.durationSec;
    if (styleId === 'beat_montage' && grid && accent.everyBeats) {
      const k = nearestBeatIndex(grid, peak);
      const beat = grid.beats[k];
      if (beat !== undefined && k % accent.everyBeats === 0 && Math.abs(beat - peak) <= 0.04 + 1e-9) return void placed.onBeats.push({ beatIndex: k, atSec: peak });
    }
    placed.other++;
  });
  return placed;
}

const ACCENT_WORDS: Record<PlacedAccents['type'], { one: string; many: string }> = {
  fadewhite: { one: 'white flash', many: 'white flashes' },
  fadeblack: { one: 'dip to black', many: 'dips to black' },
};

/**
 * The accents a plan has, in plain words, or null when it has none: "a white flash on every 4th beat from 0:04 to 0:12"
 * only for an unbroken run of at least three (every 4th beat between them has one), otherwise how many there are on such
 * beats ("3 white flashes, each on a 4th beat"); then the one at the reveal and any other. Pure.
 */
export function describeAccents(p: PlacedAccents): string | null {
  const w = ACCENT_WORDS[p.type];
  const nth = p.everyBeats === 8 ? '8th' : '4th';
  const aNth = p.everyBeats === 8 ? 'an 8th' : 'a 4th';
  const parts: string[] = [];
  const beats = [...p.onBeats].sort((a, b) => a.beatIndex - b.beatIndex);
  const unbroken = beats.length >= 3 && beats.every((b, i) => i === 0 || b.beatIndex - beats[i - 1]!.beatIndex === p.everyBeats);
  if (unbroken) parts.push(`a ${w.one} on every ${nth} beat from ${formatSeconds(beats[0]!.atSec)} to ${formatSeconds(beats[beats.length - 1]!.atSec)}`);
  else if (beats.length === 1) parts.push(`a ${w.one} on ${aNth} beat`);
  else if (beats.length > 1) parts.push(`${beats.length} ${w.many}, each on ${aNth} beat`);
  if (p.atReveal) parts.push(parts.length ? 'one at the reveal' : `a ${w.one} at the reveal`);
  if (p.other > 0) parts.push(parts.length ? (p.other === 1 ? 'one more' : `${p.other} more`) : p.other === 1 ? `a ${w.one}` : `${p.other} ${w.many}`);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** The kind of a join in plain words (plural). */
function joinKind(t: TransitionType | null): string {
  switch (t) {
    case null:
      return 'straight cuts';
    case 'fade':
    case 'dissolve':
      return 'cross-fades';
    case 'slideup':
    case 'slidedown':
      return 'slides';
    case 'wipeleft':
    case 'wiperight':
      return 'wipes';
    case 'zoomin':
      return 'zoom transitions';
    case 'circleopen':
      return 'iris openings';
    case 'fadeblack':
      return 'dips to black';
    case 'fadewhite':
      return 'white flashes';
  }
}

/** The order join kinds are listed in. */
const JOIN_KIND_ORDER = ['straight cuts', 'cross-fades', 'cross-fade lengths', 'slides', 'wipes', 'zoom transitions', 'iris openings', 'dips to black', 'white flashes'];

/** "a", "a and b", "a, b and c". */
function listOf(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The plan note for the accepted transitions, written from the finished plan (design §4.3.1.6): the joins the plan has,
 * crediting the owner's videos only with those the palette really chose (`joinFrom`) and naming the style's own.
 * - Joins from the palette by kind ("Straight cuts and cross-fades"), then its accents where they are ("with a white
 *   flash at the reveal"; the beat montage's "on every 4th beat from 0:04 to 0:12" only for an unbroken run), ending
 *   ", from your style." Then "Some joins keep the style's own cross-fades." for the joins the style chose (a calm style
 *   keeping its own cross-fades instead of slides from the videos; a montage's straight cuts where the footage had no
 *   room for a cross-fade). A straight cut looks the same whoever chose it, so the style's own are named only when the
 *   palette chose none.
 * - Nothing from the palette: "This style keeps its own cross-fades rather than the transitions from your videos." A
 *   revision that kept joins from the earlier version (some may be from the videos) says "Some joins keep the style's
 *   own cross-fades." instead; the kept joins themselves are neither credited nor described.
 * - Clean promo takes only the straight-cut share and the cross-fade length: "Straight cuts and cross-fade lengths
 *   follow your style.", or, with an accent in the palette and none in the plan, "Clean promo stays calm, so it uses
 *   straight cuts from your style but no white flashes."
 * Null when there is nothing to say. Pure.
 */
export function paletteNoteFor(es: ResolvedEditingStyle, styleId: StyleId, segments: readonly Segment[], joinFrom: JoinOrigins, revealAt: number, grid: BeatGrid | null): string | null {
  const p = es.palette;
  if (!p) return null;
  const accentType = es.accent?.type ?? null;
  const credited = new Set<string>();
  const own = new Set<string>();
  let kept = false;
  let accentInPlan = false;
  segments.forEach((seg, i) => {
    if (i === 0) return;
    const t = seg.transitionIn;
    if (t && t.type === accentType) accentInPlan = true;
    if (joinFrom[i] === 'kept') return void (kept = true);
    if (joinFrom[i] !== 'videos') return void own.add(joinKind(t?.type ?? null));
    if (t && t.type === accentType) return; // described with the accents
    // Clean promo keeps its own calm cross-fades and takes only their length from the palette.
    if (styleId === 'clean_promo' && t) {
      if (Math.abs(t.durationSec - p.durationSec) <= 0.005) credited.add('cross-fade lengths');
      else own.add(joinKind(t.type));
      return;
    }
    credited.add(joinKind(t?.type ?? null));
  });
  if (credited.has('straight cuts')) own.delete('straight cuts');
  const fromVideos = JOIN_KIND_ORDER.filter((k) => credited.has(k));
  const theirOwn = listOf(JOIN_KIND_ORDER.filter((k) => own.has(k)));
  const someOwn = theirOwn ? `Some joins keep the style's own ${theirOwn}.` : '';
  const ownOnly = !theirOwn ? null : kept ? someOwn : `This style keeps its own ${theirOwn} rather than the transitions from your videos.`;
  const withOwn = (text: string) => (someOwn ? `${text} ${someOwn}` : text);
  if (styleId === 'clean_promo') {
    if (es.accent && !accentInPlan) {
      const none = `no ${joinKind(es.accent.type)}`;
      return withOwn(`Clean promo stays calm, so it uses ${fromVideos.length ? `${listOf(fromVideos)} from your style but ${none}` : `${none} from your style`}.`);
    }
    return fromVideos.length ? withOwn(`${capitalised(listOf(fromVideos))} follow your style.`) : ownOnly;
  }
  const accents = es.accent ? describeAccents(placedAccents(styleId, segments, joinFrom, revealAt, grid, es.accent)) : null;
  if (!fromVideos.length && !accents) return ownOnly;
  return withOwn(`${capitalised(`${listOf(fromVideos)}${fromVideos.length && accents ? ' with ' : ''}${accents ?? ''}`)}, from your style.`);
}

/** Moves each accent so its peak lands on the nearest beat (fitted styles with music). */
export function alignAccentsToBeats(drafts: Draft[], grid: BeatGrid): void {
  if (!grid.fromMusic) return;
  for (let i = 1; i < drafts.length; i++) {
    if (!isAccent(drafts[i]?.transitionIn ?? null)) continue;
    const t = feltCutTime(drafts, i);
    const beat = grid.beats[nearestBeatIndex(grid, t)] ?? t;
    const delta = beat - t;
    if (Math.abs(delta) > 0.01 && Math.abs(delta) <= grid.interval / 2 + 1e-3) shiftCut(drafts, i, delta);
  }
}

/**
 * Cut every N beats for fitted styles: each cut moves to the nearest beat that is a whole number of N-beat steps after
 * the previous cut (where the footage and the style's shot range allow), keeping the total length.
 */
export function snapCutsToBeatSteps(drafts: Draft[], grid: BeatGrid, n: number, minShotSec: number): number {
  if (!grid.fromMusic) return 0;
  let moved = 0;
  let prevIdx = 0;
  for (let i = 1; i < drafts.length - 1; i++) {
    const t = cutTime(drafts, i);
    const near = nearestBeatIndex(grid, t);
    const steps = Math.max(1, Math.round((near - prevIdx) / n));
    let target = grid.beats[prevIdx + steps * n];
    const prevCut = i > 1 ? cutTime(drafts, i - 1) : 0;
    if (target !== undefined && target - prevCut < minShotSec * 0.8 && grid.beats[prevIdx + (steps + 1) * n] !== undefined) target = grid.beats[prevIdx + (steps + 1) * n];
    if (target !== undefined) {
      const delta = target - t;
      if (Math.abs(delta) >= 0.02 && Math.abs(delta) <= (n * grid.interval) / 2 + 1e-3 && Math.abs(shiftCut(drafts, i, delta)) > 0.01) moved++;
    }
    prevIdx = nearestBeatIndex(grid, cutTime(drafts, i));
  }
  return moved;
}

/** Moves the reveal's felt moment onto output time `target`; true when it lands within 0.1 s. */
export function landRevealAt(drafts: Draft[], r: number, target: number): boolean {
  if (r < 1) return false;
  for (let pass = 0; pass < 2; pass++) {
    const t = feltCutTime(drafts, r);
    const delta = target - t;
    if (Math.abs(delta) <= 0.01) break;
    if (Math.abs(delta) > 3) return false;
    shiftCut(drafts, r, delta);
  }
  return Math.abs(feltCutTime(drafts, r) - target) <= 0.1;
}

/** Where the reveal should land, when the owner accepted "the finished look on the strongest beat". */
export interface RevealPlan {
  /** Music start to use (seconds into the track), or null to leave it as it was. */
  musicStartSec: number | null;
  /** Output time for the reveal, or null when it falls back to the nearest downbeat. */
  targetOutputSec: number | null;
  note: string | null;
}

/**
 * Plans the reveal on the track's strongest beat (design §4.3.1.6): with the music start on automatic, the start is
 * chosen so the strongest beat falls on the reveal at 45–90 % of the edit (the beat montage reveals on its final shot,
 * up to 95 %); with a fixed start, the reveal moves to the strongest beat when it lies at 35–85 %. No clear drop →
 * nearest downbeat. The biggest lift comes from the track's loudness, so a track with no clear beat (`hasBeatGrid`) can
 * still have one; it has no downbeat to fall back on, and those notes say the reveal stays where the cut works best.
 */
export function planReveal(input: PlannerInput, s: EffectiveSettings, revealSec: number | null, fixedStartSec: number | null, currentStartSec?: number): RevealPlan | null {
  const es = s.styleFromVideos;
  const music = input.music;
  if (!es || es.reveal !== 'strongest_beat' || !music || !s.musicOn) return null;
  const onBeat = hasBeatGrid(music.beatTimesSec, music.durationSec);
  /** The note when the reveal falls back: the nearest downbeat, which a track with no clear beat does not have. */
  const fallback = (downbeat: string) => (onBeat ? downbeat : NO_CLEAR_BEAT_NOTES.reveal);
  const strongest = strongestBeat(music);
  if (!strongest || !strongest.found) return { musicStartSec: null, targetOutputSec: null, note: fallback('No clear drop in this track — the reveal lands on a downbeat.') };
  const title = music.title ? `'${music.title}'` : 'the track';
  const note = `The finished look lands on the biggest lift in ${title} (estimate).`;
  if (fixedStartSec !== null) {
    const out = strongest.atSec - fixedStartSec;
    const share = out / s.target;
    return share >= 0.35 && share <= 0.85
      ? { musicStartSec: null, targetOutputSec: round(out, 3), note }
      : { musicStartSec: null, targetOutputSec: null, note: fallback('The biggest lift in this track is outside the edit with the start you chose, so the reveal lands on a downbeat.') };
  }
  if (revealSec === null) return null;
  // Most styles hold the finished look for the last 15–30 % of the edit, so the reveal sits at up to 90 % (the beat
  // montage reveals on its final shot, up to 95 %).
  const maxShare = input.styleId === 'beat_montage' ? 0.95 : 0.9;
  const beats = startBeatsThatFit(music, s.target);
  const all = music.beatTimesSec;
  const indexOf = (t: number) => all.reduce((best, b, i) => (Math.abs(b - t) < Math.abs((all[best] ?? 0) - t) ? i : best), 0);
  const phase = currentStartSec === undefined ? null : indexOf(currentStartSec) % 4;
  let best: { start: number; out: number; score: number } | null = null;
  for (const b of beats) {
    const out = strongest.atSec - b;
    const share = out / s.target;
    if (share < 0.45 || share > maxShare) continue;
    // Prefer starts on the same beat of the bar as before, so beat-counted accents stay on their beats.
    const score = Math.abs(out - revealSec) + (phase !== null && indexOf(b) % 4 !== phase ? 0.75 : 0);
    if (!best || score < best.score) best = { start: b, out, score };
  }
  return best
    ? { musicStartSec: round(best.start, 3), targetOutputSec: round(best.out, 3), note }
    : { musicStartSec: null, targetOutputSec: null, note: fallback('The biggest lift in this track does not fit this edit, so the reveal lands on a downbeat.') };
}

/** Note for a reveal that could not be moved (or kept) on the strongest beat. */
export const REVEAL_MISSED_NOTE = 'The reveal could not be kept exactly on the biggest lift with this footage, so it lands close to it.';

/**
 * Applies the reveal plan after timing is final; falls back to the nearest downbeat. Returns the output time the
 * reveal landed on when the plan note says it lands on the biggest lift (to be rechecked once the plan is final, see
 * {@link recheckRevealNote}), else null. For a track with no clear beat (a stand-in grid) there is no downbeat: the
 * reveal stays where the cut works best and the note says so.
 */
export function applyReveal(ctx: BuildContext, drafts: Draft[], grid: BeatGrid | null, plan: RevealPlan): { targetSec: number; note: string } | null {
  if (!grid) return null;
  const r = revealIndex(ctx.input.styleId, drafts);
  if (plan.targetOutputSec !== null && r > 0) {
    if (landRevealAt(drafts, r, plan.targetOutputSec)) {
      if (plan.note) ctx.notes.push(plan.note);
      return plan.note ? { targetSec: plan.targetOutputSec, note: plan.note } : null;
    }
  }
  if (!grid.fromMusic) {
    ctx.notes.push(plan.targetOutputSec !== null ? NO_CLEAR_BEAT_NOTES.revealOffLift : (plan.note ?? NO_CLEAR_BEAT_NOTES.reveal));
    return null;
  }
  if (ctx.input.styleId !== 'beat_montage') landRevealOnBeat(drafts, grid);
  ctx.notes.push(plan.targetOutputSec !== null ? 'The reveal could not be moved onto the biggest lift with this footage, so it lands on a downbeat.' : (plan.note ?? 'The reveal lands on a downbeat.'));
  return null;
}

/**
 * Later steps (zooms, fitting repairs) can move the reveal after it was landed: when it is more than 0.1 s from the
 * biggest lift, the "lands on the biggest lift" note is replaced so the plan never claims what it does not do.
 * Returns false once the note has been replaced.
 */
export function recheckRevealNote(ctx: BuildContext, drafts: readonly Draft[], landed: { targetSec: number; note: string }): boolean {
  const r = revealIndex(ctx.input.styleId, drafts);
  if (r > 0 && Math.abs(feltCutTime(drafts, r) - landed.targetSec) <= 0.1) return true;
  const k = ctx.notes.indexOf(landed.note);
  if (k >= 0) ctx.notes[k] = REVEAL_MISSED_NOTE;
  return false;
}

/** Largest zoom that does not soften the picture: min(scale, 1.25, max(1.10, short side ÷ 1080)). */
export function zoomCap(input: PlannerInput, assetId: string, scale: number): number {
  const probe = input.analyses.find((a) => a.assetId === assetId)?.probe.video;
  const short = probe ? Math.min(probe.displayWidth, probe.displayHeight) : 1080;
  return round(Math.min(scale, 1.25, Math.max(1.1, short / 1080)), 3);
}

/**
 * Zooms from the owner's videos (design §4.3.1.6): `none` removes every zoom; `push_in` uses the accepted scale where
 * the style zooms and adds alternating push-ins on process shots of at least 1.5 s; `punch_in` continues the current
 * shot with a static zoom on a share of the hard cuts that land on a beat, instead of cutting away.
 */
export function applyZoomStyle(ctx: BuildContext, drafts: Draft[], grid: BeatGrid | null): void {
  const es = ctx.s.styleFromVideos;
  if (!es || es.zoom.mode === 'style') return;
  const zoom = es.zoom;
  const styleId = ctx.input.styleId;
  if (zoom.mode === 'none') {
    for (const d of drafts) d.zoom = null;
    ctx.notes.push('Shots are left unzoomed, from your style.');
    return;
  }
  if (zoom.mode === 'push_in') {
    let k = 0;
    for (const d of drafts) {
      const scale = zoomCap(ctx.input, d.cand.assetId, zoom.scale);
      if (d.zoom) d.zoom = { from: 1, to: scale };
      else if (['cutting', 'fade_detail', 'styling'].includes(d.role) && play(d) >= 1.5 && d.slot !== 'final') {
        if ((k + ctx.s.attempt) % 2 === 0) d.zoom = { from: 1, to: scale };
        k++;
      }
    }
    ctx.notes.push('Slow push-ins as in your videos.');
    return;
  }
  // punch_in: on cuts that land on a beat. The beat montage has its own steady rhythm without a clear beat (its note says
  // so); the other styles have only the track's beats, so a track with no clear beat gets no punch-ins there.
  if (styleId === 'clean_promo' || !grid || (!grid.fromMusic && styleId !== 'beat_montage')) return;
  const r = revealIndex(styleId, drafts);
  let punched = 0;
  for (let i = 1; i < drafts.length; i++) {
    const d = drafts[i]!;
    const prev = drafts[i - 1]!;
    if (d.transitionIn || ['final', 'reveal', 'hold2', 'before', 'open'].includes(d.slot)) continue;
    if (prev.zoom && prev.zoom.from === prev.zoom.to && prev.zoom.from > 1) continue;
    if (styleId === 'cinematic_reveal' && r > 0 && i >= r) continue;
    if (frac(i, ctx.s.attempt) >= zoom.shareOfCuts) continue;
    const t = cutTime(drafts, i);
    const beat = grid.beats[nearestBeatIndex(grid, t)] ?? Number.POSITIVE_INFINITY;
    if (Math.abs(beat - t) > 0.04) continue;
    const p = play(d);
    const src = p * prev.speed;
    const free = freeIntervals(prev.cand, drafts, d).find(([a, b]) => a <= prev.outSec + 1e-6 && b >= prev.outSec + src - 1e-6);
    if (!free || src < 0.4 || prev.cand.endSec - prev.outSec < Math.max(0.8, src) - 1e-6) continue;
    const scale = zoomCap(ctx.input, prev.cand.assetId, zoom.scale);
    d.cand = prev.cand;
    d.inSec = prev.outSec;
    d.outSec = prev.outSec + src;
    d.speed = prev.speed;
    d.role = prev.role;
    d.zoom = { from: scale, to: scale };
    d.keepOriginalSound = false;
    punched++;
  }
  // "Beat cuts" only for the music's own beats; on the montage's stand-in rhythm they are just cuts.
  if (punched > 0) ctx.notes.push(`Punch-in zooms (up to ${zoom.scale.toFixed(2).replace(/0$/, '')}×) on some ${grid.fromMusic ? 'beat ' : ''}cuts, from your style.`);
}
