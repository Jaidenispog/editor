/**
 * Text-safe zones for one vertical video that suits BOTH Instagram Reels and TikTok.
 *
 * The 1080x1920 numbers are the conservative union of Meta's Reels guidance (keep roughly 14% of
 * the top, 35% of the bottom and 6% of each side free of text) and the most conservative
 * third-party reading of TikTok's in-feed template (240 px top, 660 px bottom, 120 px each side,
 * plus a ~180 px action-button column on the right from y ≈ 840). Sources and caveats:
 * docs/research/platform-constraints.md section 5. Reviewed on SAFE_ZONE_REVIEWED_ON; both apps
 * change their chrome without notice, so re-measure roughly every six months.
 *
 * Coordinates have their origin at the top-left. Every rectangle is half-open: it covers pixels
 * `left <= x < right` and `top <= y < bottom`, so `right - left` is its width.
 *
 * Regions:
 * - `strict` (R_strict, x 120–780, y 270–1248): the default for all text.
 * - `head` (R_head, x 120–960, y 270–840): wider, for boxes whose bottom edge is at y ≤ 840,
 *   i.e. above the action column.
 * - `forbidden`: the top band (y < 270), bottom band (y ≥ 1248), both sides (x < 120, x ≥ 960)
 *   and the action column (x ≥ 780 where y ≥ 840). Nothing drawn may touch them.
 * - `subtitle`: captions are centred at x = 540, at most 480 px wide, bottom edge ≤ 1248, and set
 *   in type at least 56 px (em size) at 1080 px wide.
 */

/** A half-open pixel rectangle: `left <= x < right`, `top <= y < bottom`. */
export interface SafeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A named area of the frame that platform chrome covers. */
export interface ForbiddenArea {
  name: 'top_band' | 'bottom_band' | 'left_side' | 'right_side' | 'action_column';
  rect: SafeRect;
}

/** Where captions (subtitles) may go. */
export interface SubtitleZone {
  /** Captions are centred on this x. */
  centreX: number;
  /** A caption box is at most this wide. */
  maxWidth: number;
  /** A caption box ends at or above this y (exclusive bottom edge). */
  maxBottom: number;
  /** Minimum type size (em size in pixels). */
  minTypePx: number;
}

/** The full safe-zone model for one output size. */
export interface SafeZone {
  width: number;
  height: number;
  /** R_strict: the default region for all text. */
  strict: SafeRect;
  /** R_head: a wider region for boxes that end at or above `head.bottom`. */
  head: SafeRect;
  forbidden: readonly ForbiddenArea[];
  subtitle: SubtitleZone;
}

/** The date the numbers below were last checked against platform guidance. */
export const SAFE_ZONE_REVIEWED_ON = '2026-11-09';

/** The researched safe zone at 1080x1920. Use scaleSafeZone for any other output size. */
export const VERTICAL_SAFE_ZONE_1080x1920: SafeZone = {
  width: 1080,
  height: 1920,
  strict: { left: 120, top: 270, right: 780, bottom: 1248 },
  head: { left: 120, top: 270, right: 960, bottom: 840 },
  forbidden: [
    { name: 'top_band', rect: { left: 0, top: 0, right: 1080, bottom: 270 } },
    { name: 'bottom_band', rect: { left: 0, top: 1248, right: 1080, bottom: 1920 } },
    { name: 'left_side', rect: { left: 0, top: 270, right: 120, bottom: 1248 } },
    { name: 'right_side', rect: { left: 960, top: 270, right: 1080, bottom: 1248 } },
    { name: 'action_column', rect: { left: 780, top: 840, right: 960, bottom: 1248 } },
  ],
  subtitle: { centreX: 540, maxWidth: 480, maxBottom: 1248, minTypePx: 56 },
};

/**
 * Scales a safe zone to another output size (e.g. 540x960 previews). Allowed regions are rounded
 * inwards and forbidden areas outwards, so a scaled zone is never more permissive than the original.
 * Horizontal values scale with the width, vertical ones with the height; the minimum type size
 * scales with the width.
 */
export function scaleSafeZone(zone: SafeZone, width: number, height: number): SafeZone {
  const sx = width / zone.width;
  const sy = height / zone.height;
  const inward = (r: SafeRect): SafeRect => ({
    left: Math.ceil(r.left * sx),
    top: Math.ceil(r.top * sy),
    right: Math.floor(r.right * sx),
    bottom: Math.floor(r.bottom * sy),
  });
  const outward = (r: SafeRect): SafeRect => ({
    left: Math.floor(r.left * sx),
    top: Math.floor(r.top * sy),
    right: Math.ceil(r.right * sx),
    bottom: Math.ceil(r.bottom * sy),
  });
  return {
    width,
    height,
    strict: inward(zone.strict),
    head: inward(zone.head),
    forbidden: zone.forbidden.map((f) => ({ name: f.name, rect: outward(f.rect) })),
    subtitle: {
      centreX: Math.round(zone.subtitle.centreX * sx),
      maxWidth: Math.floor(zone.subtitle.maxWidth * sx),
      maxBottom: Math.floor(zone.subtitle.maxBottom * sy),
      minTypePx: Math.ceil(zone.subtitle.minTypePx * sx),
    },
  };
}

/** The researched safe zone at the given output size. */
export function safeZoneFor(width: number, height: number): SafeZone {
  return width === VERTICAL_SAFE_ZONE_1080x1920.width && height === VERTICAL_SAFE_ZONE_1080x1920.height
    ? VERTICAL_SAFE_ZONE_1080x1920
    : scaleSafeZone(VERTICAL_SAFE_ZONE_1080x1920, width, height);
}

/** Width of a rectangle. */
export function rectWidth(r: SafeRect): number {
  return r.right - r.left;
}

/** Height of a rectangle. */
export function rectHeight(r: SafeRect): number {
  return r.bottom - r.top;
}

/** True when `inner` lies entirely inside `outer`. */
export function rectContains(outer: SafeRect, inner: SafeRect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

/** True when the two rectangles share at least one pixel. */
export function rectsIntersect(a: SafeRect, b: SafeRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The region a text box may use: R_head when its bottom edge is at or above `head.bottom`,
 * otherwise R_strict.
 */
export function regionForBox(zone: SafeZone, box: Pick<SafeRect, 'bottom'>): SafeRect {
  return box.bottom <= zone.head.bottom ? zone.head : zone.strict;
}

/** True when a text box lies inside R_strict, or inside R_head when it ends above the action column. */
export function isTextBoxSafe(zone: SafeZone, box: SafeRect): boolean {
  return rectContains(zone.strict, box) || rectContains(zone.head, box);
}

/** The forbidden areas a box touches (empty when it is safe). */
export function forbiddenAreasTouched(zone: SafeZone, box: SafeRect): ForbiddenArea['name'][] {
  return zone.forbidden.filter((f) => rectsIntersect(f.rect, box)).map((f) => f.name);
}

/**
 * True when a caption box follows the subtitle rules: centred on `subtitle.centreX` (within a
 * pixel), no wider than `subtitle.maxWidth`, ending at or above `subtitle.maxBottom` and inside R_strict.
 */
export function isSubtitleBoxSafe(zone: SafeZone, box: SafeRect): boolean {
  const centre = (box.left + box.right) / 2;
  return (
    Math.abs(centre - zone.subtitle.centreX) <= 1 &&
    rectWidth(box) <= zone.subtitle.maxWidth &&
    box.bottom <= zone.subtitle.maxBottom &&
    rectContains(zone.strict, box)
  );
}
