import { TEXT_METRICS_CODES, TEXT_METRICS_DATA } from './text-metrics-data.js';

/**
 * Conservative text measurement for the ASS layout. Widths are in ASS font-size units: multiply by
 * the `\fs` value to get pixels. They come from the real font files (see text-metrics-data.ts) and
 * take the widest weight of each family, so a measured line is never narrower than libass draws it
 * (kerning only ever tightens these fonts' Latin text).
 */
export interface TextMetrics {
  family: string;
  /** Em size divided by the ASS font size (libass makes usWinAscent + usWinDescent equal the size). */
  emPerSize: number;
  /** Advance width of one character in font-size units. */
  advance(codePoint: number): number;
}

/**
 * Width given to characters the table does not cover (emoji, CJK, symbols drawn by a fallback font).
 * Wider than any covered glyph so such text is never under-estimated.
 */
export const UNKNOWN_CHAR_WIDTH = 1.3;

const INDEX = new Map<number, number>(TEXT_METRICS_CODES.map((code, i) => [code, i]));

function build(family: string, emPerSize: number, widths: readonly number[]): TextMetrics {
  return {
    family,
    emPerSize,
    advance(codePoint: number): number {
      const i = INDEX.get(codePoint);
      if (i === undefined) return UNKNOWN_CHAR_WIDTH;
      const w = widths[i] ?? 0;
      // A zero means no face in the family has the glyph, so libass falls back to another font.
      return w > 0 ? w / 1000 : UNKNOWN_CHAR_WIDTH;
    },
  };
}

const FAMILIES = new Map<string, TextMetrics>(Object.entries(TEXT_METRICS_DATA).map(([family, data]) => [family, build(family, data.emPerSize, data.widths)]));

/** Every family's widest advance per character: used for a family the table does not know. */
const WIDEST = (() => {
  const all = Object.values(TEXT_METRICS_DATA);
  const widths = TEXT_METRICS_CODES.map((_, i) => Math.max(...all.map((d) => d.widths[i] ?? 0)));
  return build('fallback', Math.min(...all.map((d) => d.emPerSize)), widths);
})();

/** Metrics for a font family, or the widest-of-all fallback when the family is not in the table. */
export function textMetricsFor(family: string): TextMetrics {
  return FAMILIES.get(family) ?? WIDEST;
}

/** Width of one line of text in font-size units, before letter spacing and scaling. */
export function lineWidthUnits(metrics: TextMetrics, text: string): number {
  let width = 0;
  for (const ch of text) {
    width += metrics.advance(ch.codePointAt(0) ?? 0);
  }
  return width;
}
