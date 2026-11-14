import { readdir } from 'node:fs/promises';
import { rectsIntersect, type OutputFormat, type SafeRect, type SafeZone } from '@studio/core';
import type { AssTextBox } from './ass.js';
import { formatNumber } from './escape.js';
import type { RenderLogo } from './types.js';

/**
 * Logo end card and corner mark (preferences design §6.5). Both stay inside R_head (x 120–960, y 270–840 at
 * 1080×1920), so they never touch the apps' buttons, captions or the forbidden bands. Geometry is defined at
 * 1080×1920 and scaled with the output width; every rectangle is snapped inwards to even pixels so 4:2:0 chroma
 * never bleeds outside it.
 */

/** Largest corner mark at 1080 px wide (keeps the logo's aspect ratio). */
export const CORNER_MAX_PX = 150;
/** Gap between the corner mark and the edge of R_head at 1080 px wide. */
export const CORNER_INSET_PX = 12;
/** Largest end card at 1080 px wide. */
export const END_CARD_MAX = { width: 420, height: 300 } as const;
/** Top of the end card box at 1920 px high (its bottom stays at or above y 680, well inside R_head). */
export const END_CARD_TOP_PX = 380;
/** End card length: the last min(2 s, 30 % of the edit). */
export const END_CARD_MAX_SEC = 2;
export const END_CARD_SHARE = 0.3;
/** End card fade-in length. */
export const END_CARD_FADE_SEC = 0.3;

/** Where the corner mark goes and when it hides. */
export interface CornerMarkLayout {
  rect: SafeRect;
  width: number;
  height: number;
  opacity: number;
  /** Windows (seconds) in which the mark is hidden: top text, a top handle, text over the mark, or the end card. */
  hiddenWindows: Array<[number, number]>;
}

/** Where the end card goes and when it shows. */
export interface EndCardLayout {
  rect: SafeRect;
  width: number;
  height: number;
  startSec: number;
  fadeSec: number;
}

/** The logo placements for one render (either may be null). */
export interface LogoLayout {
  corner: CornerMarkLayout | null;
  endCard: EndCardLayout | null;
}

const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const evenUp = (n: number) => Math.ceil(n / 2) * 2;

/** Fits `w × h` inside `maxW × maxH` keeping the aspect ratio, with even sizes. */
export function fitInside(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 2, height: 2 };
  const scale = Math.min(maxW / w, maxH / h);
  return { width: evenDown(w * scale), height: evenDown(h * scale) };
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** Merges overlapping windows and sorts them. */
function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const sorted = windows.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

/**
 * Places the logo for one render. `textBoxes` is the text layout of the same render (layoutAssDocument), so the
 * corner mark can step aside while top text, a top handle or any text over it is on screen, and the end card is
 * skipped when top or centre text (or anything over the card) overlaps its window. With `both`, the corner mark also
 * hides while the end card shows; when the end card is skipped the corner mark stays. Pure.
 */
export function layoutLogo(logo: RenderLogo, output: OutputFormat, zone: SafeZone, totalSec: number, textBoxes: readonly AssTextBox[]): LogoLayout {
  const s = output.width / 1080;
  const sy = output.height / 1920;
  const head = zone.head;

  let endCard: EndCardLayout | null = null;
  if (logo.placement === 'end_card' || logo.placement === 'both') {
    const show = Math.min(END_CARD_MAX_SEC, END_CARD_SHARE * totalSec);
    const startSec = Math.max(0, totalSec - show);
    const size = fitInside(logo.width, logo.height, END_CARD_MAX.width * s, END_CARD_MAX.height * sy);
    const left = Math.max(evenUp(head.left), evenDown((output.width - size.width) / 2));
    const top = Math.max(evenUp(head.top), evenUp(END_CARD_TOP_PX * sy));
    const rect: SafeRect = { left, top, right: left + size.width, bottom: top + size.height };
    const blocked = textBoxes.some(
      (b) => overlaps(b.startSec, b.endSec, startSec, totalSec) && (b.anchor === 'top' || b.anchor === 'centre' || rectsIntersect(b.box, rect)),
    );
    if (show > 0 && !blocked) endCard = { rect, width: size.width, height: size.height, startSec, fadeSec: Math.min(END_CARD_FADE_SEC, show) };
  }

  let corner: CornerMarkLayout | null = null;
  if (logo.placement === 'corner' || logo.placement === 'both') {
    const size = fitInside(logo.width, logo.height, CORNER_MAX_PX * s, CORNER_MAX_PX * s);
    const inset = CORNER_INSET_PX * s;
    const top = evenUp(head.top + inset);
    const left = logo.corner === 'top_left' ? evenUp(head.left + inset) : evenDown(head.right - inset - size.width);
    const rect: SafeRect = { left, top, right: left + size.width, bottom: top + size.height };
    const hidden: Array<[number, number]> = textBoxes
      .filter((b) => b.anchor === 'top' || rectsIntersect(b.box, rect))
      .map((b) => [b.startSec, Math.min(b.endSec, totalSec)] as [number, number]);
    if (endCard) hidden.push([endCard.startSec, totalSec]);
    corner = { rect, width: size.width, height: size.height, opacity: Math.min(1, Math.max(0.6, logo.opacity)), hiddenWindows: mergeWindows(hidden) };
  }
  return { corner, endCard };
}

/** Every rectangle the logo layout draws in. */
export function logoRects(layout: LogoLayout): SafeRect[] {
  return [layout.corner?.rect, layout.endCard?.rect].filter((r): r is SafeRect => Boolean(r));
}

/** The `enable` expression that hides the corner mark in its windows, or null when it always shows. */
export function cornerEnableExpression(windows: ReadonlyArray<readonly [number, number]>): string | null {
  if (windows.length === 0) return null;
  return `not(${windows.map(([a, b]) => `between(t,${formatNumber(a, 3)},${formatNumber(b, 3)})`).join('+')})`;
}

/**
 * Filter-graph lines that draw the logo over `[inputLabel]` and output `[outputLabel]`. `logoInputIndex` is the
 * looped logo input (`-loop 1 -framerate <fps> -t <total> -i logo`). Returns no lines (and a `null` passthrough)
 * when the layout draws nothing. The chain runs before the `ass` filter, so text stays on top of the logo.
 */
export function buildLogoFilters(layout: LogoLayout, logoInputIndex: number, inputLabel: string, outputLabel: string): string[] {
  const parts: Array<'corner' | 'endCard'> = [];
  if (layout.corner) parts.push('corner');
  if (layout.endCard) parts.push('endCard');
  if (parts.length === 0) return [`[${inputLabel}]null[${outputLabel}]`];
  const filters: string[] = [];
  const sources = parts.length === 2 ? ['lgsrc0', 'lgsrc1'] : ['lgsrc0'];
  filters.push(parts.length === 2 ? `[${logoInputIndex}:v]format=rgba,split=2[lgsrc0][lgsrc1]` : `[${logoInputIndex}:v]format=rgba[lgsrc0]`);
  let current = inputLabel;
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const out = last ? outputLabel : `lgv${i}`;
    if (part === 'corner' && layout.corner) {
      const c = layout.corner;
      filters.push(`[${sources[i]}]scale=${c.width}:${c.height}:flags=lanczos,colorchannelmixer=aa=${formatNumber(c.opacity, 3)}[lgc]`);
      const enable = cornerEnableExpression(c.hiddenWindows);
      filters.push(`[${current}][lgc]overlay=x=${c.rect.left}:y=${c.rect.top}${enable ? `:enable='${enable}'` : ''}:format=auto[${out}]`);
    } else if (part === 'endCard' && layout.endCard) {
      const e = layout.endCard;
      filters.push(`[${sources[i]}]scale=${e.width}:${e.height}:flags=lanczos,fade=t=in:st=${formatNumber(e.startSec, 3)}:d=${formatNumber(e.fadeSec, 3)}:alpha=1[lge]`);
      filters.push(`[${current}][lge]overlay=x=${e.rect.left}:y=${e.rect.top}:enable='gte(t,${formatNumber(e.startSec, 3)})':format=auto[${out}]`);
    }
    current = out;
  });
  return filters;
}

/**
 * True when every logo rectangle lies inside `zone.head` and touches no forbidden area (design §6.5 `checkOverlayRects`).
 */
export function checkOverlayRects(rects: readonly SafeRect[], zone: SafeZone): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const r of rects) {
    const inside = r.left >= zone.head.left && r.top >= zone.head.top && r.right <= zone.head.right && r.bottom <= zone.head.bottom;
    if (!inside) problems.push(`logo rectangle ${r.left},${r.top}–${r.right},${r.bottom} is outside R_head`);
    for (const f of zone.forbidden) if (rectsIntersect(f.rect, r)) problems.push(`logo rectangle touches ${f.name}`);
  }
  return { ok: problems.length === 0, problems };
}

const fontListCache = new Map<string, Promise<Set<string>>>();
const FALLBACK_FONT = 'Inter';

/** Font family names a fonts directory provides, read from the file names (cached per directory). */
async function bundledFamilies(fontsDir: string): Promise<Set<string>> {
  let cached = fontListCache.get(fontsDir);
  if (!cached) {
    cached = readdir(fontsDir)
      .then((files) => {
        const families = new Set<string>();
        for (const f of files) {
          if (!/\.(ttf|otf)$/i.test(f)) continue;
          // "InterDisplay-SemiBold.ttf" → "inter display"; "Inter-Regular.ttf" → "inter".
          const stem = f.replace(/\.(ttf|otf)$/i, '').split('-')[0] ?? '';
          families.add(stem.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
        }
        return families;
      })
      .catch(() => new Set<string>());
    fontListCache.set(fontsDir, cached);
  }
  return cached;
}

/**
 * Returns `name` when a matching font file ships in `fontsDir`, otherwise `'Inter'` (design §4.5): older settings may
 * name DejaVu Sans or Liberation Sans, which are not bundled, and libass would silently pick a random system font.
 * `onFallback` is called with the requested name so the caller can log it.
 */
export async function resolveRenderFont(name: string, fontsDir: string, onFallback?: (requested: string) => void): Promise<string> {
  const families = await bundledFamilies(fontsDir);
  if (families.has(name.toLowerCase())) return name;
  onFallback?.(name);
  return FALLBACK_FONT;
}
