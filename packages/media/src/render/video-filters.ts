import type { ColourPreset, OutputFormat, Segment } from '@studio/core';
import { formatNumber } from './escape.js';

/** `eq` settings for each colour preset; `null` means the footage is left untouched. */
export const COLOUR_PRESET_FILTERS: Record<ColourPreset, string | null> = {
  none: null,
  natural: 'eq=contrast=1.03:saturation=1.05',
  clean: 'eq=contrast=1.05:saturation=0.98:brightness=0.01',
  cinematic: 'eq=contrast=1.08:saturation=0.92:gamma=0.98',
  punchy: 'eq=contrast=1.1:saturation=1.15',
};

/**
 * HDR (HLG or PQ) to BT.709 SDR: linearise, convert primaries, tone-map with the Hable curve and
 * re-encode as limited-range BT.709. zscale reads the source transfer/primaries from the frames.
 */
export const HDR_TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

export interface SegmentFilterOptions {
  /** Index of the FFmpeg input that carries this segment (one input per segment). */
  inputIndex: number;
  segment: Segment;
  /** Duration after the speed change, in seconds (from computeTimeline). */
  playDurationSec: number;
  /** Whether the source clip is HDR and needs tone-mapping. */
  isHdr: boolean;
  output: OutputFormat;
  colourPreset: ColourPreset;
  /** Label for the chain's output pad, without brackets (e.g. `v_0`). */
  outputLabel: string;
}

/** Number of output frames a segment contributes: its play duration quantised to whole frames. */
export function segmentFrameCount(playDurationSec: number, fps: number): number {
  return Math.max(1, Math.round(playDurationSec * fps));
}

/**
 * Builds the per-segment video chain:
 * reset timestamps → speed change → constant frame rate (trimmed to the exact frame count) →
 * scale to cover the output → crop with the framing focus → HDR tone-mapping when needed →
 * 8-bit 4:2:0 → optional zoom (zoompan, a crop window that eases from `from` to `to` and is scaled
 * back to the output size) → colour preset → square pixels and a 1/fps timebase.
 *
 * Tone-mapping sits after the crop so only output-sized frames go through the float pipeline, and
 * frames dropped by the speed change are never tone-mapped at all.
 */
export function buildSegmentFilter(options: SegmentFilterOptions): string {
  const { segment, output, inputIndex, outputLabel } = options;
  const W = output.width;
  const H = output.height;
  const fps = output.fps;
  const frames = segmentFrameCount(options.playDurationSec, fps);
  const focusX = segment.framing.mode === 'focus' ? clamp01(segment.framing.focusX) : 0.5;
  const focusY = segment.framing.mode === 'focus' ? clamp01(segment.framing.focusY) : 0.5;

  const steps: string[] = ['setpts=PTS-STARTPTS'];
  if (segment.speed !== 1) {
    steps.push(`setpts=PTS/${formatNumber(segment.speed)}`);
  }
  steps.push(`fps=${fps}`, `trim=end_frame=${frames}`);
  steps.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=bicubic`);
  steps.push(`crop=${W}:${H}:x=(iw-${W})*${formatNumber(focusX)}:y=(ih-${H})*${formatNumber(focusY)}`);
  if (options.isHdr) {
    steps.push(HDR_TONEMAP_CHAIN);
  }
  steps.push('format=yuv420p');
  if (segment.zoom && (segment.zoom.from !== 1 || segment.zoom.to !== 1)) {
    steps.push(buildZoomFilter(segment.zoom.from, segment.zoom.to, frames, focusX, focusY, output));
  }
  const colour = COLOUR_PRESET_FILTERS[options.colourPreset];
  if (colour) {
    steps.push(colour);
  }
  steps.push('setsar=1', `settb=1/${fps}`);
  return `[${inputIndex}:v]${steps.join(',')}[${outputLabel}]`;
}

/**
 * A zoom that eases linearly from `from` to `to` across the segment. zoompan crops a window of
 * iw/zoom × ih/zoom anchored on the framing focus and scales it back to the output size, one output
 * frame per input frame (`d=1`), so timing is untouched. FFmpeg's `crop` cannot change its size per
 * frame, which is why zoompan is used for this step.
 */
export function buildZoomFilter(from: number, to: number, frames: number, focusX: number, focusY: number, output: OutputFormat): string {
  const last = Math.max(1, frames - 1);
  const z = `${formatNumber(from)}+(${formatNumber(to)}-${formatNumber(from)})*min(on/${last},1)`;
  const x = `(iw-iw/zoom)*${formatNumber(focusX)}`;
  const y = `(ih-ih/zoom)*${formatNumber(focusY)}`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${output.width}x${output.height}:fps=${output.fps}`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
