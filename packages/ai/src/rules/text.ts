import { normaliseText, type Caption, type TextOverlay, type TranscriptSegment } from '@studio/core';
import { play, startTimes, type Draft } from './draft.js';
import { round } from './random.js';

/** Longest on-screen text the rules planner writes (the schema allows 60). */
export const MAX_TEXT_CHARS = 40;
const MIN_TEXT_SEC = 0.6;
const MAX_CAPTION_CHARS = 120;

/** A piece of text tied to a moment of the edit rather than to fixed times. */
export interface TextIntent {
  text: string;
  /** 'start' = opening seconds, 'end' = closing seconds, 'during' = while the draft in `slot` plays. */
  at: 'start' | 'end' | 'during';
  /** Structural slot of the draft the text belongs to (the first draft with that slot). */
  slot?: string;
  /** For 'during': keep the text up until the end of the edit instead of the end of that draft. */
  untilEnd?: boolean;
  placement: TextOverlay['placement'];
  style: TextOverlay['style'];
  animation: TextOverlay['animation'];
  emphasis: TextOverlay['emphasis'];
  maxDurSec?: number;
}

/** Returns trimmed text when it is short enough to show, otherwise null. */
export function shortText(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_TEXT_CHARS) return null;
  return t;
}

/**
 * Resolves text intents to timed overlays on the current timeline. Overlays shorter than 0.6 s are dropped, and
 * two overlays in the same position never overlap: the later one moves to the other position or is dropped.
 */
export function resolveText(intents: TextIntent[], drafts: readonly Draft[]): TextOverlay[] {
  const starts = startTimes(drafts);
  const total = drafts.length ? (starts[starts.length - 1] ?? 0) + play(drafts[drafts.length - 1]!) : 0;
  const out: TextOverlay[] = [];
  for (const intent of intents) {
    let s: number;
    let e: number;
    if (intent.at === 'start') {
      s = 0.3;
      e = Math.min(s + (intent.maxDurSec ?? 2.4), total - 0.2);
    } else if (intent.at === 'end') {
      e = total - 0.2;
      s = Math.max(0.2, e - (intent.maxDurSec ?? 2.2));
    } else {
      const idx = drafts.findIndex((d) => d.slot === intent.slot);
      if (idx < 0) continue;
      const d = drafts[idx]!;
      const segStart = starts[idx] ?? 0;
      const tIn = idx > 0 ? (d.transitionIn?.durationSec ?? 0) : 0;
      const next = drafts[idx + 1];
      s = idx === 0 ? 0.3 : segStart + tIn + 0.15;
      e = next && !intent.untilEnd ? segStart + play(d) - (next.transitionIn?.durationSec ?? 0) - 0.1 : total - 0.2;
      if (intent.maxDurSec) e = Math.min(e, s + intent.maxDurSec);
    }
    s = round(Math.max(0, s), 2);
    e = round(Math.min(e, total - 0.05), 2);
    if (e - s < MIN_TEXT_SEC) continue;
    const clash = (placement: TextOverlay['placement']) => out.some((o) => o.placement === placement && s < o.endSec && o.startSec < e);
    let placement = intent.placement;
    if (clash(placement)) {
      const alternative: TextOverlay['placement'] = placement === 'top' ? 'lower' : 'top';
      if (clash(alternative)) continue;
      placement = alternative;
    }
    out.push({
      id: `text-${out.length + 1}`,
      text: intent.text,
      startSec: s,
      endSec: e,
      placement,
      style: intent.style,
      animation: intent.animation,
      emphasis: intent.emphasis,
    });
  }
  return out.slice(0, 12);
}

/** Splits text into word-boundary chunks of at most `max` characters (each chunk stays verbatim). */
function chunkWords(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const w of words) {
    if (w.length > max) return [];
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur = `${cur} ${w}`;
    else {
      chunks.push(cur);
      cur = w;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** True for transcript lines that are only annotations such as "[Music]" or "(laughs)". */
function isAnnotation(text: string): boolean {
  return /^[\s([{].*[)\]}]\s*$/.test(text.trim()) || normaliseText(text).length === 0;
}

/**
 * Captions copied verbatim from the transcript and placed where that speech actually plays in the edit
 * (only speech whose source time falls inside a segment that is on screen). Never paraphrases or invents.
 */
export function buildCaptions(drafts: readonly Draft[], transcripts: Record<string, TranscriptSegment[]>): Caption[] {
  const starts = startTimes(drafts);
  const total = drafts.length ? (starts[starts.length - 1] ?? 0) + play(drafts[drafts.length - 1]!) : 0;
  const captions: Caption[] = [];
  drafts.forEach((d, i) => {
    const speech = transcripts[d.cand.assetId];
    if (!speech) return;
    const segStart = starts[i] ?? 0;
    const tIn = i > 0 ? (d.transitionIn?.durationSec ?? 0) : 0;
    const tOut = drafts[i + 1]?.transitionIn?.durationSec ?? 0;
    const visibleFrom = segStart + tIn;
    const visibleTo = segStart + play(d) - tOut;
    for (const ts of [...speech].sort((a, b) => a.startSec - b.startSec)) {
      const text = ts.text.replace(/\s+/g, ' ').trim();
      if (!text || isAnnotation(text)) continue;
      const overlap = Math.min(d.outSec, ts.endSec) - Math.max(d.inSec, ts.startSec);
      const spoken = ts.endSec - ts.startSec;
      if (overlap <= 0 || overlap < Math.min(1, spoken * 0.6)) continue;
      let os = segStart + (Math.max(d.inSec, ts.startSec) - d.inSec) / d.speed;
      let oe = segStart + (Math.min(d.outSec, ts.endSec) - d.inSec) / d.speed;
      os = Math.max(os, visibleFrom);
      oe = Math.min(oe, visibleTo, total - 0.05);
      const chunks = chunkWords(text, MAX_CAPTION_CHARS);
      if (chunks.length === 0) continue;
      const totalChars = chunks.reduce((n, c) => n + c.length, 0);
      let cursor = os;
      for (const chunk of chunks) {
        const share = (oe - os) * (chunk.length / totalChars);
        const prevEnd = captions[captions.length - 1]?.endSec ?? 0;
        const cs = round(Math.max(cursor, prevEnd), 2);
        const ce = round(Math.min(cursor + share, oe), 2);
        cursor += share;
        if (ce - cs < 0.4) continue;
        captions.push({ text: chunk, startSec: cs, endSec: ce });
      }
    }
  });
  return captions.slice(0, 80);
}
