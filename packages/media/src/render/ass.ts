import {
  AppError,
  rectContains,
  rectWidth,
  type EditPlan,
  type OutputFormat,
  type SafeRect,
  type SafeZone,
  type TextOverlay,
  type Timeline,
} from '@studio/core';
import { colourToAss, escapeAssText, formatAssTime } from './escape.js';
import { lineWidthUnits, textMetricsFor, type TextMetrics } from './text-metrics.js';
import type { RenderBrand } from './types.js';

/** Font family names used by the ASS styles. */
export interface AssFonts {
  headline: string;
  body: string;
}

/** The brand facts the ASS builder needs (a RenderBrand satisfies this). */
export type AssBrand = Pick<RenderBrand, 'accentColour' | 'videoTextStyle' | 'socialHandle'>;

/** Captions prefer at most this many lines; only text that cannot fit at the minimum size gets more. */
export const CAPTION_MAX_LINES = 2;
/** Text overlays never run past this many lines (the type shrinks first). */
export const OVERLAY_MAX_LINES = 3;

/** How long the brand handle shows at the end of a video, at most. */
export const HANDLE_SHOW_SEC = 2.5;

/** The `pop` animation grows text to this scale before settling back to 100%. */
export const POP_SCALE = 1.08;

/** Measured widths are multiplied by this before layout, to absorb hinting and rounding in libass. */
export const WIDTH_SAFETY = 1.03;

/**
 * Clear pixels kept between text and the edge of its region, at every output size. H.264 codes the
 * picture in 8x8 blocks and its deblocking filter touches up to 3 pixels across block edges, so a
 * sharp text edge leaves faint ringing nearby; 12 pixels keeps that ringing inside the allowed area.
 */
export const CODEC_GUARD_PX = 12;

/** Overlays may shrink to this fraction of their style size before the text is refused. */
const MIN_OVERLAY_SCALE = 0.45;

interface Treatment {
  headlineWeight: number;
  headlineScale: number;
  /** Letter spacing as a fraction of the output height. */
  headlineSpacing: number;
  subtitleWeight: number;
  labelWeight: number;
  labelSpacing: number;
  outlineScale: number;
}

const TREATMENTS: Record<RenderBrand['videoTextStyle'], Treatment> = {
  minimal: { headlineWeight: 700, headlineScale: 1, headlineSpacing: 0, subtitleWeight: 600, labelWeight: 700, labelSpacing: 0.0035, outlineScale: 1 },
  bold: { headlineWeight: 800, headlineScale: 1.15, headlineSpacing: 0, subtitleWeight: 700, labelWeight: 800, labelSpacing: 0.0035, outlineScale: 1.2 },
  editorial: { headlineWeight: 500, headlineScale: 0.95, headlineSpacing: 0.002, subtitleWeight: 500, labelWeight: 600, labelSpacing: 0.006, outlineScale: 0.85 },
};

const STYLE_FOR_OVERLAY: Record<TextOverlay['style'], string> = {
  headline: 'Headline',
  subtitle: 'Subtitle',
  label: 'Label',
};

const ALIGNMENT_FOR_PLACEMENT: Record<TextOverlay['placement'], 2 | 5 | 8> = {
  top: 8,
  centre: 5,
  lower: 2,
};

interface StyleSpec {
  name: string;
  font: string;
  size: number;
  colour: string;
  weight: number;
  spacing: number;
  outline: number;
  shadow: number;
}

/** Which safe-zone region a piece of text was laid out in. */
export type AssRegionName = 'head' | 'strict' | 'subtitle';

/** Where one line of burnt-in text ends up, for checks and debugging. */
export interface AssTextBox {
  kind: 'overlay' | 'caption' | 'handle';
  /** The overlay id, `caption-<index>` or `handle`. */
  ref: string;
  region: AssRegionName;
  /**
   * Every pixel the text (outline, shadow and any rise or pop included) can touch at any frame of
   * its animation, plus CODEC_GUARD_PX on each side, rounded outwards. Always inside the region.
   */
  box: SafeRect;
  /** The ASS font size used (`\fs`). */
  fontSize: number;
  lines: string[];
}

/** The ASS document plus the layout it encodes. */
export interface AssLayout {
  document: string;
  boxes: AssTextBox[];
}

/** Measures one line in pixels at a given ASS font size. */
export type LineMeasure = (line: string) => number;

/**
 * Wraps text to `maxWidth` pixels. Explicit line breaks are kept; each paragraph is wrapped greedily
 * and then re-balanced (the narrowest width that keeps the same number of lines), so a two-line
 * caption splits evenly rather than leaving one word behind. Returns null when a single word is
 * wider than `maxWidth` (the caller shrinks the type first), unless `breakWords` is set, in which
 * case such a word is split between characters as a last resort.
 */
export function wrapTextToWidth(text: string, maxWidth: number, measure: LineMeasure, breakWords = false): string[] | null {
  const out: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (breakWords && words.some((w) => measure(w) > maxWidth)) {
      const lines = greedyWrapBreaking(words, maxWidth, measure);
      if (!lines) return null;
      out.push(...lines);
      continue;
    }
    const lines = greedyWrap(words, maxWidth, measure);
    if (!lines) return null;
    if (lines.length === 1) {
      out.push(...lines);
      continue;
    }
    // Binary search on whole pixels for the narrowest width with the same line count.
    // Invariant: `hi` gives that line count; `lo` is below the widest word (or known to need more lines).
    let lo = Math.ceil(Math.max(...words.map(measure))) - 1;
    let hi = maxWidth;
    let best = lines;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid <= lo || mid >= hi) break;
      const attempt = greedyWrap(words, mid, measure);
      if (attempt && attempt.length === lines.length) {
        best = attempt;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    out.push(...best);
  }
  return out;
}

/** Splits one word into the fewest pieces that each fit `width`; null if a single character does not fit. */
function splitWord(word: string, width: number, measure: LineMeasure): string[] | null {
  if (measure(word) <= width) return [word];
  const pieces: string[] = [];
  let current = '';
  for (const ch of word) {
    if (measure(ch) > width) return null;
    if (current.length > 0 && measure(current + ch) > width) {
      pieces.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Greedy wrap where an over-wide word is split between characters and its pieces take their own lines. */
function greedyWrapBreaking(words: string[], width: number, measure: LineMeasure): string[] | null {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (measure(word) > width) {
      const pieces = splitWord(word, width, measure);
      if (!pieces) return null;
      if (current.length > 0) lines.push(current);
      lines.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? '';
    } else if (current.length === 0) {
      current = word;
    } else if (measure(`${current} ${word}`) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function greedyWrap(words: string[], width: number, measure: LineMeasure): string[] | null {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (measure(word) > width) return null;
    if (current.length === 0) {
      current = word;
    } else if (measure(`${current} ${word}`) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

interface Motion {
  /** Largest scale the animation reaches. */
  scaleMax: number;
  /** How far below its resting place a rising line starts, in pixels. */
  riseOffset: number;
}

interface FitRequest {
  text: string;
  metrics: TextMetrics;
  baseSize: number;
  minSize: number;
  /** Letter spacing in pixels (the style's Spacing). */
  spacing: number;
  outline: number;
  shadow: number;
  alignment: 2 | 5 | 8;
  motion: Motion;
  /** The rectangle every pixel must stay inside. */
  limit: SafeRect;
  /** Vertical placement inside `limit`. */
  vertical: 'top' | 'centre' | 'bottom';
  maxLines: number;
  /** Accept more than maxLines at the minimum size rather than refusing (captions). */
  allowMoreLines: boolean;
  /** Output width relative to 1080 (0.5 for 540-wide previews), for anti-aliasing slack. */
  unit: number;
  /** Extra clear pixels on every side for the video codec (see CODEC_GUARD_PX). */
  guard: number;
}

interface Placement {
  lines: string[];
  size: number;
  x: number;
  y: number;
  box: SafeRect;
}

/**
 * Finds the largest type size (from baseSize down to minSize) at which the wrapped text, with its
 * outline, shadow and full animation travel, fits inside `limit`, and where to anchor it.
 */
function fitText(req: FitRequest): Placement | null {
  const attempt = (size: number, maxLines: number, breakWords = false): Placement | null => {
    const s = req.motion.scaleMax;
    // Outline and shadow grow with the pop scale; 4% of the size covers glyph overhang past the advance.
    const padX = req.outline + req.shadow + 0.04 * size + 2 * req.unit;
    const padY = req.outline + req.shadow + 2 * req.unit;
    const measure: LineMeasure = (line) => (lineWidthUnits(req.metrics, line) * size + req.spacing * [...line].length) * WIDTH_SAFETY;
    const wrapWidth = (rectWidth(req.limit) - 2 - 2 * req.guard) / s - 2 * padX;
    if (wrapWidth <= 0) return null;
    const lines = wrapTextToWidth(req.text, wrapWidth, measure, breakWords);
    if (!lines || lines.length === 0 || lines.length > maxLines) return null;
    const w = Math.max(...lines.map(measure)) * s;
    const h = lines.length * size * s;
    const top0 = req.alignment === 8 ? 0 : req.alignment === 5 ? -h / 2 : -h;
    const dLeft = -(w / 2 + padX * s) - req.guard;
    const dRight = w / 2 + padX * s + req.guard;
    const dTop = top0 - padY * s - req.guard;
    const dBottom = top0 + h + padY * s + req.motion.riseOffset + req.guard;
    const x = Math.round((req.limit.left + req.limit.right) / 2);
    let y: number;
    if (req.vertical === 'top') y = Math.ceil(req.limit.top - dTop);
    else if (req.vertical === 'bottom') y = Math.floor(req.limit.bottom - dBottom);
    else y = Math.round((req.limit.top + req.limit.bottom) / 2 - (dTop + dBottom) / 2);
    const box: SafeRect = {
      left: Math.floor(x + dLeft),
      top: Math.floor(y + dTop),
      right: Math.ceil(x + dRight),
      bottom: Math.ceil(y + dBottom),
    };
    return rectContains(req.limit, box) ? { lines, size, x, y, box } : null;
  };

  const sizes: number[] = [];
  for (let size = req.baseSize; size >= req.minSize; size -= Math.max(1, Math.round(size * 0.04))) sizes.push(size);
  if (sizes.at(-1) !== req.minSize && req.minSize <= req.baseSize) sizes.push(req.minSize);
  // 1. Whole words within the line limit, largest size first.
  for (const size of sizes) {
    const placed = attempt(size, req.maxLines);
    if (placed) return placed;
  }
  // 2. Captions keep their minimum size and take more lines instead.
  if (req.allowMoreLines) {
    for (const size of sizes) {
      const placed = attempt(size, Number.POSITIVE_INFINITY);
      if (placed) return placed;
    }
  }
  // 3. Last resort for a word too long for the line even at the smallest size: split it.
  return attempt(req.minSize, Number.POSITIVE_INFINITY, true);
}

function tooLong(text: string): AppError {
  return new AppError('VALIDATION', `The on-screen text "${text}" is too long to fit in the part of the video that Instagram and TikTok leave clear. Shorten it and try again.`, {
    details: { text },
  });
}

/**
 * Builds the ASS (SubStation Alpha v4+) document that libass burns into the video, together with
 * the box each line occupies.
 *
 * Placement follows the researched safe zone (packages/core safe-zones.ts), scaled to the output:
 * - `top` overlays use the wide R_head region when the whole box, rise included, ends above the
 *   action column (y ≤ 840 at 1080x1920); otherwise R_strict.
 * - `centre` and `lower` overlays, and the end-of-video brand handle, use R_strict. A lower overlay
 *   that shares its time with a caption sits above the caption.
 * - Captions follow the subtitle rules: centred on x = 540, at most 480 px wide, bottom ≤ 1248,
 *   type at least 56 px (em) at 1080 wide, wrapped to that width.
 *
 * Text is wrapped here (with explicit `\N` and WrapStyle 2) using conservative glyph widths from
 * the real fonts, and the type shrinks until the text, its outline, shadow and the whole rise or
 * pop animation fit, so nothing ever reaches a forbidden area. Text that cannot fit even at the
 * smallest size is refused with AppError('VALIDATION').
 */
export function layoutAssDocument(plan: EditPlan, timeline: Timeline, output: OutputFormat, safeZone: SafeZone, brand: AssBrand, fonts: AssFonts): AssLayout {
  const W = output.width;
  const H = output.height;
  const scale = H / 1920;
  const unit = Math.max(0.5, W / 1080);
  const treatment = TREATMENTS[brand.videoTextStyle];
  const strict = safeZone.strict;
  const total = timeline.totalDurationSec;
  const margin = Math.round(H * 0.012);
  const risePx = Math.round(40 * scale);

  const white = colourToAss('#FFFFFF');
  const black = colourToAss('#000000');
  const shadowColour = colourToAss('#000000', 0x80);
  const accent = colourToAss(brand.accentColour);

  const headlineMetrics = textMetricsFor(fonts.headline);
  const bodyMetrics = textMetricsFor(fonts.body);
  const captionMinSize = Math.ceil(safeZone.subtitle.minTypePx / bodyMetrics.emPerSize);

  const sizes = {
    headline: Math.round(H * 0.052 * treatment.headlineScale),
    subtitle: Math.round(H * 0.034),
    label: Math.round(H * 0.03),
    caption: Math.max(Math.round(H * 0.036), captionMinSize),
    handle: Math.round(H * 0.028),
  };
  const px = (fraction: number) => round2(H * fraction);

  const baseStyles: StyleSpec[] = [
    { name: 'Headline', font: fonts.headline, size: sizes.headline, colour: white, weight: treatment.headlineWeight, spacing: px(treatment.headlineSpacing), outline: round2(3 * scale * treatment.outlineScale), shadow: round2(1 * scale) },
    { name: 'Subtitle', font: fonts.body, size: sizes.subtitle, colour: white, weight: treatment.subtitleWeight, spacing: px(treatment.headlineSpacing / 2), outline: round2(2.5 * scale * treatment.outlineScale), shadow: round2(0.5 * scale) },
    { name: 'Label', font: fonts.body, size: sizes.label, colour: white, weight: treatment.labelWeight, spacing: px(treatment.labelSpacing), outline: round2(2 * scale), shadow: round2(0.5 * scale) },
  ];
  const styles: StyleSpec[] = [];
  for (const style of baseStyles) {
    styles.push(style, { ...style, name: `${style.name}Accent`, colour: accent });
  }
  styles.push({ name: 'Caption', font: fonts.body, size: sizes.caption, colour: white, weight: 600, spacing: 0, outline: round2(2 * scale), shadow: 0 });
  styles.push({ name: 'Handle', font: fonts.body, size: sizes.handle, colour: white, weight: 600, spacing: px(0.004), outline: round2(2 * scale), shadow: 0 });
  const styleByName = new Map(styles.map((s) => [s.name, s]));
  const metricsFor = (style: StyleSpec) => (style.font === fonts.headline ? headlineMetrics : bodyMetrics);

  const styleLines = styles.map((s) =>
    [
      'Style: ' + s.name,
      s.font,
      s.size,
      s.colour,
      s.colour,
      black,
      shadowColour,
      s.weight,
      0,
      0,
      0,
      100,
      100,
      s.spacing,
      0,
      1,
      s.outline,
      s.shadow,
      2,
      strict.left,
      W - strict.right,
      H - strict.bottom,
      1,
    ].join(','),
  );

  const motionFor = (animation: TextOverlay['animation']): Motion => ({
    scaleMax: animation === 'pop' ? POP_SCALE : 1,
    riseOffset: animation === 'rise' ? risePx : 0,
  });

  const fitStyled = (
    text: string,
    style: StyleSpec,
    alignment: 2 | 5 | 8,
    animation: TextOverlay['animation'],
    limit: SafeRect,
    vertical: FitRequest['vertical'],
    options: { minSize?: number; maxLines?: number; allowMoreLines?: boolean } = {},
  ): Placement | null =>
    fitText({
      text,
      metrics: metricsFor(style),
      baseSize: style.size,
      minSize: options.minSize ?? Math.max(1, Math.floor(style.size * MIN_OVERLAY_SCALE)),
      spacing: style.spacing,
      outline: style.outline,
      shadow: style.shadow,
      alignment,
      motion: motionFor(animation),
      limit,
      vertical,
      maxLines: options.maxLines ?? OVERLAY_MAX_LINES,
      allowMoreLines: options.allowMoreLines ?? false,
      unit,
      guard: CODEC_GUARD_PX,
    });

  const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
  const events: string[] = [];
  const boxes: AssTextBox[] = [];

  // Captions first: lower overlays need to know where the caption block starts.
  const captionStyle = styleByName.get('Caption')!;
  const half = Math.floor(safeZone.subtitle.maxWidth / 2);
  const captionLimit: SafeRect = {
    left: Math.max(strict.left, safeZone.subtitle.centreX - half),
    right: Math.min(strict.right, safeZone.subtitle.centreX + half),
    top: strict.top,
    bottom: Math.min(strict.bottom, safeZone.subtitle.maxBottom),
  };
  const captionPlacements: Array<{ start: number; end: number; placed: Placement }> = [];
  const captionEvents: string[] = [];
  plan.captions.forEach((caption, index) => {
    const start = caption.startSec;
    const end = Math.min(caption.endSec, total);
    if (end <= start || caption.text.trim().length === 0) return;
    const placed = fitStyled(caption.text, captionStyle, 2, 'fade', captionLimit, 'bottom', {
      minSize: captionMinSize,
      maxLines: CAPTION_MAX_LINES,
      allowMoreLines: true,
    });
    if (!placed) throw tooLong(caption.text);
    captionPlacements.push({ start, end, placed });
    boxes.push({ kind: 'caption', ref: `caption-${index}`, region: 'subtitle', box: placed.box, fontSize: placed.size, lines: placed.lines });
    const sizeTag = placed.size !== captionStyle.size ? `{\\fs${placed.size}}` : '';
    captionEvents.push(dialogue(0, start, end, 'Caption', `{\\an2\\pos(${placed.x},${placed.y})\\fad(60,60)}${sizeTag}${joinLines(placed.lines)}`));
  });

  for (const overlay of plan.textOverlays) {
    const start = overlay.startSec;
    const end = Math.min(overlay.endSec, total);
    if (end <= start) continue;
    const styleName = STYLE_FOR_OVERLAY[overlay.style] + (overlay.emphasis === 'accent' ? 'Accent' : '');
    const style = styleByName.get(styleName)!;
    const text = overlay.style === 'label' ? overlay.text.toLocaleUpperCase('en-AU') : overlay.text;
    const alignment = ALIGNMENT_FOR_PLACEMENT[overlay.placement];

    let placed: Placement | null = null;
    let region: AssRegionName = 'strict';
    if (overlay.placement === 'top') {
      placed = fitStyled(text, style, alignment, overlay.animation, safeZone.head, 'top');
      if (placed) region = 'head';
      else placed = fitStyled(text, style, alignment, overlay.animation, strict, 'top');
    } else if (overlay.placement === 'centre') {
      placed = fitStyled(text, style, alignment, overlay.animation, strict, 'centre');
    } else {
      const captionTops = captionPlacements.filter((c) => overlaps(start, end, c.start, c.end)).map((c) => c.placed.box.top);
      const bottom = captionTops.length > 0 ? Math.min(strict.bottom, Math.min(...captionTops) - margin) : strict.bottom;
      placed = fitStyled(text, style, alignment, overlay.animation, { ...strict, bottom }, 'bottom');
    }
    if (!placed) throw tooLong(overlay.text);

    boxes.push({ kind: 'overlay', ref: overlay.id, region, box: placed.box, fontSize: placed.size, lines: placed.lines });
    const sizeTag = placed.size !== style.size ? `{\\fs${placed.size}}` : '';
    const tags = animationTags(overlay.animation, placed.x, placed.y, alignment, placed.y + risePx);
    events.push(dialogue(1, start, end, styleName, `${tags}${sizeTag}${joinLines(placed.lines)}`));
  }

  events.push(...captionEvents);

  const handle = (brand.socialHandle ?? '').trim();
  if (handle.length > 0) {
    const show = Math.min(HANDLE_SHOW_SEC, total * 0.3);
    const start = Math.max(0, total - show);
    const alreadyShown = plan.textOverlays.some((o) => o.text.toLowerCase().includes(handle.toLowerCase()));
    if (show >= 0.8 && !alreadyShown) {
      const busy = (placement: TextOverlay['placement']) =>
        plan.textOverlays.some((o) => o.placement === placement && overlaps(o.startSec, Math.min(o.endSec, total), start, total));
      const captionsBusy = captionPlacements.some((c) => overlaps(c.start, c.end, start, total));
      const handleStyle = styleByName.get('Handle')!;
      const where = !busy('lower') && !captionsBusy ? 'bottom' : !busy('top') ? 'top' : null;
      if (where) {
        const alignment = where === 'bottom' ? 2 : 8;
        const placed = fitStyled(handle, handleStyle, alignment, 'fade', strict, where, { maxLines: 2 });
        if (placed) {
          boxes.push({ kind: 'handle', ref: 'handle', region: 'strict', box: placed.box, fontSize: placed.size, lines: placed.lines });
          const sizeTag = placed.size !== handleStyle.size ? `{\\fs${placed.size}}` : '';
          events.push(dialogue(1, start, total, 'Handle', `${animationTags('fade', placed.x, placed.y, alignment, placed.y)}${sizeTag}${joinLines(placed.lines)}`));
        }
      }
    }
  }

  const document = [
    '[Script Info]',
    '; Generated by Studio Assistant',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    // Lines are wrapped here (see wrapTextToWidth), so libass must not wrap them again.
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');

  return { document, boxes };
}

/** The ASS document alone (see layoutAssDocument for the placement rules). */
export function buildAssDocument(plan: EditPlan, timeline: Timeline, output: OutputFormat, safeZone: SafeZone, brand: AssBrand, fonts: AssFonts): string {
  return layoutAssDocument(plan, timeline, output, safeZone, brand, fonts).document;
}

/**
 * Override tags for one animation: alignment and position first, then the movement.
 * `riseFromY` is where a rising line starts (it eases up to `y` over 350 ms).
 */
export function animationTags(animation: TextOverlay['animation'], x: number, y: number, alignment: number, riseFromY: number): string {
  switch (animation) {
    case 'fade':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(250,250)}`;
    case 'rise':
      return `{\\an${alignment}\\move(${x},${riseFromY},${x},${y},0,350)\\fad(200,250)}`;
    case 'pop': {
      const pct = Math.round(POP_SCALE * 100);
      return `{\\an${alignment}\\pos(${x},${y})\\fad(120,200)\\t(0,180,\\fscx${pct}\\fscy${pct})\\t(180,320,\\fscx100\\fscy100)}`;
    }
    default:
      return `{\\an${alignment}\\pos(${x},${y})}`;
  }
}

function joinLines(lines: string[]): string {
  return lines.map(escapeAssText).join('\\N');
}

function dialogue(layer: number, start: number, end: number, style: string, text: string): string {
  return `Dialogue: ${layer},${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${text}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
