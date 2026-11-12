import { safeArea, type EditPlan, type OutputFormat, type SafeZone, type TextOverlay, type Timeline } from '@studio/core';
import { colourToAss, escapeAssText, formatAssTime } from './escape.js';
import type { RenderBrand } from './types.js';

/** Font family names used by the ASS styles. */
export interface AssFonts {
  headline: string;
  body: string;
}

/** The brand facts the ASS builder needs (a RenderBrand satisfies this). */
export type AssBrand = Pick<RenderBrand, 'accentColour' | 'videoTextStyle' | 'socialHandle'>;

/** Captions wrap at roughly this many characters per line. */
export const CAPTION_WRAP_CHARS = 26;
/** Captions never run past this many lines. */
export const CAPTION_MAX_LINES = 2;

/** How long the brand handle shows at the end of a video, at most. */
export const HANDLE_SHOW_SEC = 2.5;

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

/**
 * Greedy word wrap for captions. Lines are kept within `maxChars` where possible; when the text
 * needs more than `maxLines` lines the width grows until it fits, so a caption never becomes a
 * tower of short lines.
 */
export function wrapCaptionText(text: string, maxChars = CAPTION_WRAP_CHARS, maxLines = CAPTION_MAX_LINES): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const totalLength = words.join(' ').length;
  let width = Math.max(1, maxChars);
  for (;;) {
    const lines = greedyWrap(words, width);
    if (lines.length <= maxLines || width >= totalLength) return lines;
    width = Math.max(width + 1, Math.ceil(totalLength / maxLines));
  }
}

function greedyWrap(words: string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Builds the ASS (SubStation Alpha v4+) document that libass burns into the video: one style per
 * text treatment (plus accent variants in the brand colour), every overlay and caption placed with
 * explicit `\pos`/`\an` inside the safe area so nothing lands under Instagram or TikTok chrome.
 */
export function buildAssDocument(plan: EditPlan, timeline: Timeline, output: OutputFormat, safeZone: SafeZone, brand: AssBrand, fonts: AssFonts): string {
  const W = output.width;
  const H = output.height;
  const scale = H / 1920;
  const treatment = TREATMENTS[brand.videoTextStyle];
  const area = safeArea(safeZone);
  const total = timeline.totalDurationSec;

  const margin = Math.round(H * 0.012);
  const centreX = Math.round(area.x + area.width / 2);
  const topY = Math.round(area.y + margin);
  const bottomY = Math.round(area.y + area.height - margin);
  const centreY = Math.round(area.y + area.height / 2);
  const risePx = Math.round(40 * scale);

  const white = colourToAss('#FFFFFF');
  const black = colourToAss('#000000');
  const shadowColour = colourToAss('#000000', 0x80);
  const accent = colourToAss(brand.accentColour);

  const sizes = {
    headline: Math.round(H * 0.052 * treatment.headlineScale),
    subtitle: Math.round(H * 0.034),
    label: Math.round(H * 0.03),
    caption: Math.round(H * 0.036),
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
      safeZone.left,
      safeZone.right,
      safeZone.bottom + margin,
      1,
    ].join(','),
  );

  const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
  const captionWindows = plan.captions.map((c) => ({ start: c.startSec, end: Math.min(c.endSec, total) })).filter((c) => c.end > c.start);
  const captionBlock = Math.round(sizes.caption * 1.25 * CAPTION_MAX_LINES + margin);

  const events: string[] = [];

  for (const overlay of plan.textOverlays) {
    const start = overlay.startSec;
    const end = Math.min(overlay.endSec, total);
    if (end <= start) continue;
    const styleName = STYLE_FOR_OVERLAY[overlay.style] + (overlay.emphasis === 'accent' ? 'Accent' : '');
    let y: number;
    let alignment: number;
    switch (overlay.placement) {
      case 'top':
        y = topY;
        alignment = 8;
        break;
      case 'centre':
        y = centreY;
        alignment = 5;
        break;
      default: {
        // A lower headline that shares its time with captions sits above the caption block.
        const lift = captionWindows.some((c) => overlaps(start, end, c.start, c.end)) ? captionBlock : 0;
        y = bottomY - lift;
        alignment = 2;
      }
    }
    const text = overlay.style === 'label' ? overlay.text.toLocaleUpperCase('en-AU') : overlay.text;
    // A rising line starts below its resting spot; a bottom-anchored one must not start in the margin.
    const riseFromY = alignment === 2 ? Math.min(y + risePx, Math.round(area.y + area.height)) : y + risePx;
    const tags = animationTags(overlay.animation, centreX, y, alignment, riseFromY);
    events.push(dialogue(1, start, end, styleName, `${tags}${escapeAssText(text)}`));
  }

  for (const caption of plan.captions) {
    const start = caption.startSec;
    const end = Math.min(caption.endSec, total);
    if (end <= start) continue;
    const lines = wrapCaptionText(caption.text);
    if (lines.length === 0) continue;
    const widest = Math.max(...lines.map((l) => l.length));
    const sizeTag = widest > CAPTION_WRAP_CHARS ? `\\fs${Math.round(Math.max(sizes.caption * 0.65, (sizes.caption * CAPTION_WRAP_CHARS) / widest))}` : '';
    const text = lines.map(escapeAssText).join('\\N');
    events.push(dialogue(0, start, end, 'Caption', `{\\an2\\pos(${centreX},${bottomY})\\fad(60,60)${sizeTag}}${text}`));
  }

  const handle = (brand.socialHandle ?? '').trim();
  if (handle.length > 0) {
    const show = Math.min(HANDLE_SHOW_SEC, total * 0.3);
    const start = Math.max(0, total - show);
    const alreadyShown = plan.textOverlays.some((o) => o.text.toLowerCase().includes(handle.toLowerCase()));
    if (show >= 0.8 && !alreadyShown) {
      const busy = (placement: TextOverlay['placement']) =>
        plan.textOverlays.some((o) => o.placement === placement && overlaps(o.startSec, Math.min(o.endSec, total), start, total));
      const captionsBusy = captionWindows.some((c) => overlaps(c.start, c.end, start, total));
      if (!busy('lower') && !captionsBusy) {
        events.push(dialogue(1, start, total, 'Handle', `${animationTags('fade', centreX, bottomY, 2, bottomY)}${escapeAssText(handle)}`));
      } else if (!busy('top')) {
        events.push(dialogue(1, start, total, 'Handle', `${animationTags('fade', centreX, topY, 8, topY)}${escapeAssText(handle)}`));
      }
    }
  }

  return [
    '[Script Info]',
    '; Generated by Studio Assistant',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
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
    case 'pop':
      return `{\\an${alignment}\\pos(${x},${y})\\fad(120,200)\\t(0,180,\\fscx108\\fscy108)\\t(180,320,\\fscx100\\fscy100)}`;
    default:
      return `{\\an${alignment}\\pos(${x},${y})}`;
  }
}

function dialogue(layer: number, start: number, end: number, style: string, text: string): string {
  return `Dialogue: ${layer},${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${text}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
