import { z } from 'zod';
import type { PlanFacts } from './plan-facts.js';
import { PlanFactsSchema, type FeedbackEventType } from './plan-facts.js';
import type { RevisionHints } from './revision.js';
import type { EditingPreferences } from './settings.js';
import { STYLE_IDS, STYLES, StyleIdSchema, type StyleId } from './styles.js';
import { formatTrendDate } from './trend-label.js';

/**
 * Preference learning without model training (preferences design §6.1): a deterministic weighted summary of the
 * owner's favourites, downloads, publishes, revisions, regenerations and hidden edits. Every learned value is shown in
 * Settings with the evidence behind it, can be overridden by pinning, and can be forgotten with a reset.
 */

/** The editing preferences the editor may learn. */
export const LEARNABLE_FIELDS = ['defaultDurationSec', 'styleOrder', 'pacing', 'textDensity', 'transitions', 'colour', 'musicVolume'] as const;
export const LearnableFieldSchema = z.enum(LEARNABLE_FIELDS);
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

/** Plain names of the learnable fields for Settings. */
export const LEARNABLE_FIELD_LABELS: Record<LearnableField, string> = {
  defaultDurationSec: 'Default length',
  styleOrder: 'Style order',
  pacing: 'Pacing',
  textDensity: 'On-screen text',
  transitions: 'Transitions',
  colour: 'Colour',
  musicVolume: 'Music volume',
};

/** Value schema per learnable field (the same rules as the declared preference). */
export const LEARNED_VALUE_SCHEMAS = {
  defaultDurationSec: z.number().int().min(8).max(90),
  styleOrder: z.array(StyleIdSchema).max(STYLE_IDS.length),
  pacing: z.enum(['slow', 'balanced', 'fast']),
  textDensity: z.enum(['none', 'light', 'medium']),
  transitions: z.enum(['restrained', 'varied']),
  colour: z.enum(['natural', 'clean', 'cinematic', 'punchy']),
  musicVolume: z.number().min(0).max(1),
} as const satisfies Record<LearnableField, z.ZodType>;

export const LearnedCountsSchema = z.object({
  favourites: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  publishes: z.number().int().nonnegative(),
  revisions: z.number().int().nonnegative(),
  regenerations: z.number().int().nonnegative(),
  dismissals: z.number().int().nonnegative(),
});
export type LearnedCounts = z.infer<typeof LearnedCountsSchema>;

export const LearnedFieldSchema = z.object({
  /** Validated per field with {@link LEARNED_VALUE_SCHEMAS}. */
  value: z.unknown(),
  /** Total evidence weight after recency decay. */
  weight: z.number(),
  counts: LearnedCountsSchema,
  /** Plain sentence shown in Settings. */
  explanation: z.string().max(300),
});
export type LearnedField = z.infer<typeof LearnedFieldSchema>;

export const LearnedPreferencesSchema = z.object({
  computedAt: z.string().nullable().default(null),
  eventsConsidered: z.number().int().nonnegative().default(0),
  /** Oldest event used (ISO). */
  since: z.string().nullable().default(null),
  fields: z.partialRecord(LearnableFieldSchema, LearnedFieldSchema).default({}),
  /** Set when the last recompute failed; the previous values stay in use. */
  error: z.string().nullable().default(null),
});
export type LearnedPreferences = z.infer<typeof LearnedPreferencesSchema>;

export const EMPTY_LEARNED: LearnedPreferences = { computedAt: null, eventsConsidered: 0, since: null, fields: {}, error: null };

export const PinSchema = z.object({
  by: z.enum(['owner', 'reference']),
  at: z.string(),
  referenceAssetId: z.string().nullable().default(null),
  referenceName: z.string().max(200).default(''),
});
export type Pin = z.infer<typeof PinSchema>;

export const LearningStateSchema = z.object({
  enabled: z.boolean().default(true),
  /** ISO time; events before it are ignored ("Reset what it learned"). */
  resetAt: z.string().nullable().default(null),
  pinned: z.partialRecord(LearnableFieldSchema, PinSchema).default({}),
});
export type LearningState = z.infer<typeof LearningStateSchema>;

export const DEFAULT_LEARNING_STATE: LearningState = { enabled: true, resetAt: null, pinned: {} };

/** Events older than this are not used at all. */
export const LEARNING_WINDOW_DAYS = 180;
/** Newest events read per recompute. */
export const LEARNING_MAX_EVENTS = 1000;
/** Evidence loses half its weight every this many days. */
export const LEARNING_HALF_LIFE_DAYS = 60;

/** One `feedback_events` row as the learner reads it. */
export interface LearningEvent {
  id: string;
  type: FeedbackEventType;
  createdAt: Date | string;
  editId: string | null;
  editVersionId: string | null;
  styleId: string | null;
  data: Record<string, unknown>;
}

/** The parts of the preferences the learner reads (declared values and the learning switches). */
export type LearningPreferences = Pick<EditingPreferences, 'defaultDurationSec' | 'musicVolume'> & { learning: LearningState };

const DAY_MS = 86_400_000;

function timeOf(e: LearningEvent): number {
  return (typeof e.createdAt === 'string' ? new Date(e.createdAt) : e.createdAt).getTime();
}

function factsOf(data: Record<string, unknown>, key: 'planFacts' | 'parentPlanFacts'): PlanFacts | null {
  const parsed = PlanFactsSchema.safeParse(data[key]);
  return parsed.success ? parsed.data : null;
}

function hintsOf(data: Record<string, unknown>): Partial<RevisionHints> | null {
  const h = data['hints'];
  return h && typeof h === 'object' ? (h as Partial<RevisionHints>) : null;
}

function patchVolumeOf(data: Record<string, unknown>): number | null {
  const p = data['audioPatch'];
  if (!p || typeof p !== 'object') return null;
  const v = (p as Record<string, unknown>)['volume'];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function styleOf(value: string | null | undefined): StyleId | null {
  const parsed = StyleIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** One version after collapsing its events: what the owner did with it overall. */
interface VersionEvidence {
  key: string;
  styleId: StyleId | null;
  facts: PlanFacts | null;
  favourited: boolean;
  downloaded: boolean;
  published: boolean;
  dismissed: boolean;
  /** Latest contributing event time (ms), for recency. */
  at: number;
  /** Oldest contributing event time (ms), for "since". */
  firstAt: number;
}

/** One revise/regenerate event with its parent's facts. */
interface ChangeEvidence {
  type: 'revise' | 'regenerate';
  versionKey: string;
  styleId: StyleId | null;
  parentFacts: PlanFacts | null;
  hints: Partial<RevisionHints> | null;
  patchVolume: number | null;
  at: number;
}

/** Accumulates the evidence behind one field. */
class FieldAccumulator {
  weight = 0;
  readonly counts: LearnedCounts = { favourites: 0, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 };
  readonly versions = new Set<string>();
  firstAt = Number.POSITIVE_INFINITY;

  addVersion(v: VersionEvidence, w: number): void {
    this.weight += Math.abs(w);
    this.versions.add(v.key);
    if (v.favourited) this.counts.favourites++;
    if (v.downloaded) this.counts.downloads++;
    if (v.published) this.counts.publishes++;
    if (v.dismissed) this.counts.dismissals++;
    this.firstAt = Math.min(this.firstAt, v.firstAt);
  }

  addChange(c: ChangeEvidence, w: number): void {
    this.weight += Math.abs(w);
    this.versions.add(c.versionKey);
    if (c.type === 'revise') this.counts.revisions++;
    else this.counts.regenerations++;
    this.firstAt = Math.min(this.firstAt, c.at);
  }

  events(): number {
    const c = this.counts;
    return c.favourites + c.downloads + c.publishes + c.revisions + c.regenerations + c.dismissals;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "From 4 favourites, 2 downloads and 1 revision since 3 Oct 2026." */
export function explainEvidence(counts: LearnedCounts, since: Date | string | null): string {
  const parts = [
    counts.favourites ? plural(counts.favourites, 'favourite', 'favourites') : null,
    counts.downloads ? plural(counts.downloads, 'download', 'downloads') : null,
    counts.publishes ? plural(counts.publishes, 'published post', 'published posts') : null,
    counts.revisions ? plural(counts.revisions, 'revision', 'revisions') : null,
    counts.regenerations ? plural(counts.regenerations, 'regeneration', 'regenerations') : null,
    counts.dismissals ? plural(counts.dismissals, 'hidden edit', 'hidden edits') : null,
  ].filter((p): p is string => p !== null);
  const list = parts.length <= 1 ? (parts[0] ?? 'no choices') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `From ${list}${since ? ` since ${formatTrendDate(since)}` : ''}.`;
}

function weightedMedian(items: Array<{ value: number; weight: number }>): number {
  const sorted = [...items].filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  let acc = 0;
  for (const item of sorted) {
    acc += item.weight;
    if (acc >= total / 2 - 1e-9) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

function weightedMajority<T extends string>(votes: Map<T, number>, order: readonly T[]): { value: T; share: number } | null {
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: T | null = null;
  let bestWeight = -1;
  for (const value of order) {
    const w = votes.get(value) ?? 0;
    if (w > bestWeight + 1e-9) {
      best = value;
      bestWeight = w;
    }
  }
  return best === null ? null : { value: best, share: bestWeight / total };
}

const round = (n: number, step: number) => Math.round(n / step) * step;
const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function textLevel(textPer10Sec: number): number {
  return textPer10Sec <= 0 ? 0 : textPer10Sec <= 1 ? 1 : 2;
}
const TEXT_LEVELS = ['none', 'light', 'medium'] as const;
const COLOUR_ORDER = ['natural', 'clean', 'cinematic', 'punchy'] as const;
type ColourValue = (typeof COLOUR_ORDER)[number];

function styleBaseline(styleId: StyleId): number {
  const p = STYLES[styleId].pacing;
  return (p.minShotSec + p.maxShotSec) / 2;
}

/**
 * Computes what the editor has learned from feedback events (preferences design §6.1). Pure and deterministic: the
 * same events, preferences and `now` always give the same result. Events before `learning.resetAt` or older than
 * {@link LEARNING_WINDOW_DAYS} are ignored, and only the newest {@link LEARNING_MAX_EVENTS} are read. Events without
 * plan facts (recorded before facts existed) count towards the style order only.
 */
export function computeLearnedPreferences(events: readonly LearningEvent[], prefs: LearningPreferences, now: Date): LearnedPreferences {
  return learn(events, prefs, now).learned;
}

function learn(events: readonly LearningEvent[], prefs: LearningPreferences, now: Date): { learned: LearnedPreferences; styleScores: Map<StyleId, number> } {
  const nowMs = now.getTime();
  const cutoff = Math.max(prefs.learning.resetAt ? new Date(prefs.learning.resetAt).getTime() : Number.NEGATIVE_INFINITY, nowMs - LEARNING_WINDOW_DAYS * DAY_MS);
  const usable = events
    .filter((e) => {
      const t = timeOf(e);
      return Number.isFinite(t) && t > cutoff && t <= nowMs;
    })
    .sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-LEARNING_MAX_EVENTS);

  const decay = (at: number) => Math.pow(0.5, Math.max(0, nowMs - at) / DAY_MS / LEARNING_HALF_LIFE_DAYS);

  // 1. Collapse: favourite and hide states per edit (latest wins), downloads and publishes once per version.
  const versions = new Map<string, VersionEvidence>();
  const versionFor = (e: LearningEvent): VersionEvidence => {
    const key = e.editVersionId ?? `edit:${e.editId ?? e.id}`;
    let v = versions.get(key);
    if (!v) {
      v = { key, styleId: styleOf(e.styleId), facts: null, favourited: false, downloaded: false, published: false, dismissed: false, at: timeOf(e), firstAt: timeOf(e) };
      versions.set(key, v);
    }
    const facts = factsOf(e.data, 'planFacts');
    if (facts) v.facts = facts;
    if (!v.styleId) v.styleId = facts?.styleId ?? styleOf(e.styleId);
    v.at = Math.max(v.at, timeOf(e));
    v.firstAt = Math.min(v.firstAt, timeOf(e));
    return v;
  };
  const latestFavourite = new Map<string, LearningEvent>();
  const latestDismiss = new Map<string, LearningEvent>();
  const changes: ChangeEvidence[] = [];
  for (const e of usable) {
    const editKey = e.editId ?? e.editVersionId ?? e.id;
    switch (e.type) {
      case 'favourite':
      case 'unfavourite':
        latestFavourite.set(editKey, e);
        break;
      case 'dismiss':
        latestDismiss.set(editKey, e);
        break;
      case 'download':
        versionFor(e).downloaded = true;
        break;
      case 'publish':
        versionFor(e).published = true;
        break;
      case 'revise':
      case 'regenerate':
        changes.push({
          type: e.type,
          versionKey: e.editVersionId ?? `edit:${e.editId ?? e.id}`,
          styleId: styleOf(e.styleId) ?? factsOf(e.data, 'parentPlanFacts')?.styleId ?? null,
          parentFacts: factsOf(e.data, 'parentPlanFacts'),
          hints: hintsOf(e.data),
          patchVolume: patchVolumeOf(e.data),
          at: timeOf(e),
        });
        break;
    }
  }
  for (const e of latestFavourite.values()) if (e.type === 'favourite') versionFor(e).favourited = true;
  for (const e of latestDismiss.values()) if (e.data['value'] !== false) versionFor(e).dismissed = true;

  // 2. Signed, decayed weight per version.
  const scored = [...versions.values()]
    .map((v) => {
      const raw = (v.favourited ? 3 : 0) + (v.published ? 3 : 0) + (v.downloaded ? 2 : 0) - (v.dismissed ? 2 : 0);
      return { v, raw, w: raw * decay(v.at) };
    })
    .filter((s) => s.raw !== 0)
    .sort((a, b) => (a.v.key < b.v.key ? -1 : a.v.key > b.v.key ? 1 : 0));
  const positive = scored.filter((s) => s.raw > 0 && s.v.facts);
  const sortedChanges = [...changes].sort((a, b) => a.at - b.at || (a.versionKey < b.versionKey ? -1 : 1));

  const fields: LearnedPreferences['fields'] = {};
  const emit = (field: LearnableField, value: unknown, acc: FieldAccumulator) => {
    const since = Number.isFinite(acc.firstAt) ? new Date(acc.firstAt) : null;
    fields[field] = { value, weight: round3(acc.weight), counts: { ...acc.counts }, explanation: explainEvidence(acc.counts, since) };
  };

  // styleOrder: signed weights per style; regenerate −1 to the parent's style.
  const scores = new Map<StyleId, number>();
  {
    const acc = new FieldAccumulator();
    for (const s of scored) {
      if (!s.v.styleId) continue;
      scores.set(s.v.styleId, (scores.get(s.v.styleId) ?? 0) + s.w);
      acc.addVersion(s.v, s.w);
    }
    for (const c of sortedChanges) {
      if (c.type !== 'regenerate' || !c.styleId) continue;
      const w = -1 * decay(c.at);
      scores.set(c.styleId, (scores.get(c.styleId) ?? 0) + w);
      acc.addChange(c, w);
    }
    if (acc.events() >= 3 && scores.size > 0) {
      const order = [...STYLE_IDS].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || STYLE_IDS.indexOf(a) - STYLE_IDS.indexOf(b));
      emit('styleOrder', order, acc);
    }
  }

  // defaultDurationSec: weighted median of kept lengths and explicit length requests.
  {
    const acc = new FieldAccumulator();
    const items: Array<{ value: number; weight: number }> = [];
    for (const s of positive) {
      items.push({ value: s.v.facts!.durationSec, weight: s.w });
      acc.addVersion(s.v, s.w);
    }
    for (const c of sortedChanges) {
      const target = c.type === 'revise' ? (c.hints?.targetDurationSec ?? null) : null;
      if (target === null || target === undefined) continue;
      let value: number | null = null;
      if (target > 0) value = target;
      else if (c.parentFacts && target === -1) value = c.parentFacts.durationSec * 0.75;
      else if (c.parentFacts && target === -2) value = c.parentFacts.durationSec * 1.3;
      if (value === null) continue;
      const w = 2 * decay(c.at);
      items.push({ value, weight: w });
      acc.addChange(c, w);
    }
    if (acc.weight >= 6 && acc.versions.size >= 3) {
      const value = clampN(round(weightedMedian(items), 5), 8, 90);
      if (Math.abs(value - prefs.defaultDurationSec) >= 3) emit('defaultDurationSec', value, acc);
    }
  }

  // pacing: weighted geometric mean of shot length relative to each style's own baseline.
  {
    const acc = new FieldAccumulator();
    let logSum = 0;
    let wSum = 0;
    for (const s of positive) {
      const f = s.v.facts!;
      if (f.avgShotSec <= 0) continue;
      const r = f.avgShotSec / styleBaseline(f.styleId);
      logSum += s.w * Math.log(r);
      wSum += s.w;
      acc.addVersion(s.v, s.w);
    }
    for (const c of sortedChanges) {
      const p = c.type === 'revise' ? c.hints?.pacing : undefined;
      if (p !== 'faster' && p !== 'slower') continue;
      const w = 2 * decay(c.at);
      logSum += w * Math.log(p === 'faster' ? 0.75 : 1.3);
      wSum += w;
      acc.addChange(c, w);
    }
    if (acc.weight >= 6 && wSum > 0) {
      const r = Math.exp(logSum / wSum);
      emit('pacing', r < 0.88 ? 'fast' : r > 1.14 ? 'slow' : 'balanced', acc);
    }
  }

  // textDensity: weighted mean of text levels (none 0, light 1, medium 2).
  {
    const acc = new FieldAccumulator();
    let sum = 0;
    let wSum = 0;
    for (const s of positive) {
      sum += s.w * textLevel(s.v.facts!.textPer10Sec);
      wSum += s.w;
      acc.addVersion(s.v, s.w);
    }
    for (const c of sortedChanges) {
      const t = c.type === 'revise' ? c.hints?.text : undefined;
      let level: number | null = null;
      let w = 0;
      if (t === 'none') {
        level = 0;
        w = 3;
      } else if ((t === 'less' || t === 'more') && c.parentFacts) {
        level = clampN(textLevel(c.parentFacts.textPer10Sec) + (t === 'less' ? -1 : 1), 0, 2);
        w = 2;
      }
      if (level === null) continue;
      const dw = w * decay(c.at);
      sum += dw * level;
      wSum += dw;
      acc.addChange(c, dw);
    }
    if (acc.weight >= 6 && wSum > 0) emit('textDensity', TEXT_LEVELS[clampN(Math.round(sum / wSum), 0, 2)], acc);
  }

  // transitions: weighted majority of restrained and varied.
  {
    const acc = new FieldAccumulator();
    const votes = new Map<'restrained' | 'varied', number>();
    const vote = (k: 'restrained' | 'varied', w: number) => votes.set(k, (votes.get(k) ?? 0) + w);
    for (const s of positive) {
      if (s.v.facts!.flashyTransitionCount > 0) vote('varied', s.w);
      else vote('restrained', 1 * decay(s.v.at));
      acc.addVersion(s.v, s.v.facts!.flashyTransitionCount > 0 ? s.w : decay(s.v.at));
    }
    for (const c of sortedChanges) {
      const t = c.type === 'revise' ? c.hints?.transitions : undefined;
      if (t !== 'restrained' && t !== 'none') continue;
      const w = 3 * decay(c.at);
      vote('restrained', w);
      acc.addChange(c, w);
    }
    const best = weightedMajority(votes, ['restrained', 'varied'] as const);
    if (acc.weight >= 6 && best) emit('transitions', best.value, acc);
  }

  // colour: a look kept across at least two different styles, plus explicit colour requests.
  {
    const acc = new FieldAccumulator();
    const votes = new Map<ColourValue, number>();
    const stylesByColour = new Map<ColourValue, Set<StyleId>>();
    for (const s of positive) {
      const c = s.v.facts!.colourPreset;
      if (c === 'none') continue;
      const set = stylesByColour.get(c) ?? new Set<StyleId>();
      set.add(s.v.facts!.styleId);
      stylesByColour.set(c, set);
    }
    for (const s of positive) {
      const c = s.v.facts!.colourPreset;
      if (c === 'none' || (stylesByColour.get(c)?.size ?? 0) < 2) continue;
      votes.set(c, (votes.get(c) ?? 0) + s.w);
      acc.addVersion(s.v, s.w);
    }
    for (const ch of sortedChanges) {
      const c = ch.type === 'revise' ? ch.hints?.colour : undefined;
      if (!c || c === 'keep') continue;
      const w = 3 * decay(ch.at);
      votes.set(c, (votes.get(c) ?? 0) + w);
      acc.addChange(ch, w);
    }
    const best = weightedMajority(votes, COLOUR_ORDER);
    if (acc.weight >= 6 && best && best.share >= 0.6) emit('colour', best.value, acc);
  }

  // musicVolume: weighted mean of kept volumes, "quieter/louder" requests and Sound panel volumes.
  {
    const acc = new FieldAccumulator();
    let sum = 0;
    let wSum = 0;
    for (const s of positive) {
      const v = s.v.facts!.musicVolume;
      if (!s.v.facts!.hasMusic || v === null) continue;
      sum += s.w * v;
      wSum += s.w;
      acc.addVersion(s.v, s.w);
    }
    for (const c of sortedChanges) {
      if (c.type !== 'revise') continue;
      let value: number | null = null;
      let w = 0;
      if (c.patchVolume !== null) {
        value = c.patchVolume;
        w = 3;
      } else if ((c.hints?.music === 'quieter' || c.hints?.music === 'louder') && c.parentFacts?.musicVolume != null) {
        value = clampN(c.parentFacts.musicVolume * (c.hints.music === 'quieter' ? 0.7 : 1.25), 0.1, 1);
        w = 2;
      }
      if (value === null) continue;
      const dw = w * decay(c.at);
      sum += dw * value;
      wSum += dw;
      acc.addChange(c, dw);
    }
    if (acc.weight >= 5 && wSum > 0) {
      const value = round3(clampN(round(sum / wSum, 0.05), 0.1, 1));
      if (Math.abs(value - prefs.musicVolume) >= 0.05 - 1e-9) emit('musicVolume', value, acc);
    }
  }

  const first = usable[0];
  return {
    learned: {
      computedAt: now.toISOString(),
      eventsConsidered: usable.length,
      since: first ? new Date(timeOf(first)).toISOString() : null,
      fields,
      error: null,
    },
    styleScores: scores,
  };
}

/**
 * `styleAffinity` for the existing Settings display: the learned style scores (signed, decayed weights), rounded,
 * positive only. Empty until the style order itself has enough evidence.
 */
export function styleAffinityFrom(events: readonly LearningEvent[], prefs: LearningPreferences, now: Date): Record<string, number> {
  const { learned, styleScores } = learn(events, prefs, now);
  if (!learned.fields.styleOrder) return {};
  const out: Record<string, number> = {};
  for (const style of STYLE_IDS) {
    const score = Math.round(styleScores.get(style) ?? 0);
    if (score > 0) out[style] = score;
  }
  return out;
}

/** Where the value in use for a field comes from. */
export type PreferenceSource = 'learned' | 'owner' | 'reference' | 'default';

/** The value of a learnable field as a plain value, read from declared preferences. */
export function declaredValue(prefs: EditingPreferences, field: LearnableField): unknown {
  return field === 'styleOrder' ? (prefs.styleOrder?.length ? prefs.styleOrder : [...STYLE_IDS]) : prefs[field];
}

/** The learned value of a field when it is valid, else null. */
export function learnedValue(prefs: EditingPreferences, field: LearnableField): unknown {
  const entry = prefs.learned?.fields?.[field];
  if (!entry) return null;
  const parsed = LEARNED_VALUE_SCHEMAS[field].safeParse(entry.value);
  return parsed.success ? parsed.data : null;
}

/** Editing preferences with every learnable field resolved, plus the style order to show new generations in. */
export type EffectivePreferences = EditingPreferences & { styleOrder: StyleId[] };

/**
 * Resolves each learnable field (design §3): pinned → declared; else learned (if learning is on and a learned value
 * exists); else declared. Idempotent. Everything that reads preferences (Studio defaults, planner input, rules
 * planner) uses this, so planners keep reading `preferences.pacing` and friends unchanged.
 */
export function effectivePreferences(prefs: EditingPreferences): EffectivePreferences {
  const out = { ...prefs, styleOrder: prefs.styleOrder?.length ? [...prefs.styleOrder] : [...STYLE_IDS] } as EffectivePreferences;
  if (!prefs.learning?.enabled) return out;
  for (const field of LEARNABLE_FIELDS) {
    if (prefs.learning.pinned?.[field]) continue;
    const value = learnedValue(prefs, field);
    if (value === null) continue;
    (out as Record<string, unknown>)[field] = field === 'styleOrder' ? completeStyleOrder(value as StyleId[]) : value;
  }
  return out;
}

/** A style order with every style present exactly once (missing styles appended in the default order). */
export function completeStyleOrder(order: readonly StyleId[]): StyleId[] {
  const seen = new Set<StyleId>();
  const out: StyleId[] = [];
  for (const s of [...order, ...STYLE_IDS]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Where the value in use for a field comes from, for the source chip in Settings. */
export function preferenceSource(prefs: EditingPreferences, field: LearnableField, defaults: EditingPreferences): PreferenceSource {
  const pin = prefs.learning.pinned[field];
  if (pin) return pin.by === 'reference' ? 'reference' : 'owner';
  if (prefs.learning.enabled && learnedValue(prefs, field) !== null) return 'learned';
  return JSON.stringify(declaredValue(prefs, field)) === JSON.stringify(declaredValue(defaults, field)) ? 'default' : 'owner';
}

/**
 * Pins every learnable field whose stored value differs from the default and has no pin yet (`by: 'owner'`). Used
 * for settings saved before learning existed: anything the owner set by hand then stays theirs.
 */
export function pinOwnerSetFields(prefs: EditingPreferences, defaults: EditingPreferences, at: string): EditingPreferences {
  const pinned = { ...prefs.learning.pinned };
  for (const field of LEARNABLE_FIELDS) {
    if (pinned[field]) continue;
    if (JSON.stringify(declaredValue(prefs, field)) !== JSON.stringify(declaredValue(defaults, field))) {
      pinned[field] = { by: 'owner', at, referenceAssetId: null, referenceName: '' };
    }
  }
  return { ...prefs, learning: { ...prefs.learning, pinned } };
}
