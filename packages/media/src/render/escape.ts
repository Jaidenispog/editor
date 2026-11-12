import { AppError } from '@studio/core';

/**
 * Escapes a file path for use as a filter option value inside `-filter_complex`.
 *
 * FFmpeg unescapes such a value twice: the graph parser (which stops at `,` `;` `[` `]`) and then
 * the option parser (which stops at `:`). Backslashes, quotes and colons therefore need two levels
 * of escaping, while the graph-level separators need one. Spaces are escaped so a path that ends in
 * a space is not trimmed.
 */
export function escapeFilterPath(path: string): string {
  let out = '';
  for (const ch of path) {
    switch (ch) {
      case '\\':
        out += '\\\\\\\\';
        break;
      case "'":
        out += "\\\\\\'";
        break;
      case ':':
        out += '\\\\:';
        break;
      case ' ':
        out += '\\\\\\ ';
        break;
      case ',':
      case ';':
      case '[':
      case ']':
        out += `\\${ch}`;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/**
 * Converts a CSS hex colour (#RRGGBB) to the ASS/SSA form `&HAABBGGRR`.
 * Alpha is 0 (opaque) to 255 (transparent), as ASS defines it.
 */
export function colourToAss(hex: string, alpha = 0): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new AppError('VALIDATION', `"${hex}" is not a hex colour like #C8A24A`);
  }
  const rgb = match[1] ?? '';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = Math.min(255, Math.max(0, Math.round(alpha))).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Invisible word joiner placed after a backslash so libass never reads it as an override tag. */
const WORD_JOINER = '⁠';

/**
 * Escapes plain text for an ASS dialogue line: braces (which open override blocks), backslashes
 * (which start `\N`, `\n`, `\h` and brace escapes) and line breaks (turned into hard breaks).
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, `\\${WORD_JOINER}`)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\t/g, ' ')
    .replace(/\r\n|\r|\n/g, '\\N');
}

/** Formats seconds as the ASS timestamp `h:mm:ss.cc` (centisecond precision, never negative). */
export function formatAssTime(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 100));
  const h = Math.floor(total / 360_000);
  const m = Math.floor((total % 360_000) / 6000);
  const s = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** Formats a number for a filter expression: up to six decimals, no trailing zeros, never exponent form. */
export function formatNumber(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) {
    throw new AppError('INTERNAL', `Cannot format ${String(value)} for an FFmpeg filter`);
  }
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}
