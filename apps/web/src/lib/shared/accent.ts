const HEX = /^#([0-9a-f]{6})$/i;

function channels(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const ca = channels(a);
  const cb = channels(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const DEFAULT_ACCENT = '#C8A24A';
const CHARCOAL = '#17181A';
const WHITE = '#FFFFFF';

/**
 * CSS custom properties for the configurable accent colour: the colour itself, a readable text colour to
 * put on top of it (charcoal or white, whichever contrasts more) and a soft tint for backgrounds.
 */
export function accentCssVariables(accent: string | null | undefined): Record<'--accent' | '--accent-foreground' | '--accent-soft', string> {
  const colour = accent && channels(accent) ? accent.toUpperCase() : DEFAULT_ACCENT;
  const rgb = channels(colour) ?? [200, 162, 74];
  const foreground = contrastRatio(colour, CHARCOAL) >= contrastRatio(colour, WHITE) ? CHARCOAL : WHITE;
  return {
    '--accent': colour,
    '--accent-foreground': foreground,
    '--accent-soft': `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.14)`,
  };
}
