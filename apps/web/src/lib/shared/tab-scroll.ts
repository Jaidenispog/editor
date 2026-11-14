/** Room kept beside a tab scrolled into view, so the strip's edge fade never covers it. */
export const TAB_REVEAL_PADDING_PX = 32;

/** Size and scroll position of a horizontally scrolling strip. */
export interface StripMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** Position of a tab inside the strip's content (offsetLeft relative to the strip, offsetWidth). */
export interface TabMetrics {
  offsetLeft: number;
  offsetWidth: number;
}

/**
 * The strip's scrollLeft that brings the tab into view with the least movement (like `inline: 'nearest'`), keeping
 * `padding` pixels beside it. Only the strip scrolls; the page never moves.
 */
export function revealTabScrollLeft(strip: StripMetrics, tab: TabMetrics, padding = TAB_REVEAL_PADDING_PX): number {
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const lowest = tab.offsetLeft + tab.offsetWidth + padding - strip.clientWidth;
  const highest = tab.offsetLeft - padding;
  let next = strip.scrollLeft;
  if (next > highest) next = highest;
  else if (next < lowest) next = lowest;
  return Math.min(maxScroll, Math.max(0, Math.round(next)));
}

/** Which edges of the strip have more tabs beyond them (shown with a fade). */
export function stripOverflow(strip: StripMetrics): { start: boolean; end: boolean } {
  return { start: strip.scrollLeft > 1, end: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 };
}

/** CSS mask that fades out the edges with more content beyond them (works on any background colour). */
export function stripFadeMask(overflow: { start: boolean; end: boolean }, fadePx = 24): string | undefined {
  if (!overflow.start && !overflow.end) return undefined;
  const start = overflow.start ? `transparent, #000 ${fadePx}px` : '#000, #000';
  const end = overflow.end ? `#000 calc(100% - ${fadePx}px), transparent` : '#000, #000';
  return `linear-gradient(to right, ${start}, ${end})`;
}
