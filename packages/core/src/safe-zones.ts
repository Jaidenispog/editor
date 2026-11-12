/**
 * Safe zone for text so it clears the UI chrome of BOTH Instagram Reels and TikTok at 1080x1920.
 * Values are conservative (the union of commonly published guidance); see docs/research for sources.
 * Top: status bar + "Reels"/"For You" headers. Bottom: caption, username, sound and the progress bar.
 * Right: TikTok action rail (like/comment/share). Left: small gutter.
 */
export interface SafeZone {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const VERTICAL_SAFE_ZONE_1080x1920: SafeZone = {
  width: 1080,
  height: 1920,
  top: 250,
  bottom: 450,
  left: 70,
  right: 150,
};

/** Scales the 1080x1920 safe zone to another output size (e.g. 540x960 previews). */
export function scaleSafeZone(zone: SafeZone, width: number, height: number): SafeZone {
  const sx = width / zone.width;
  const sy = height / zone.height;
  return {
    width,
    height,
    top: Math.round(zone.top * sy),
    bottom: Math.round(zone.bottom * sy),
    left: Math.round(zone.left * sx),
    right: Math.round(zone.right * sx),
  };
}

export function safeArea(zone: SafeZone): { x: number; y: number; width: number; height: number } {
  return {
    x: zone.left,
    y: zone.top,
    width: zone.width - zone.left - zone.right,
    height: zone.height - zone.top - zone.bottom,
  };
}
