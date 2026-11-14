import type { ColourPreset, OutputFormat, Segment, Timeline } from '@studio/core';
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
  /** Whole output frames this segment contributes (from quantiseTimeline). */
  frames: number;
  /** Whether the source clip is HDR and needs tone-mapping. */
  isHdr: boolean;
  output: OutputFormat;
  colourPreset: ColourPreset;
  /** Label for the chain's output pad, without brackets (e.g. `v_0`). */
  outputLabel: string;
}

/** A segment's place on the output frame grid. */
export interface SegmentFrames {
  index: number;
  /** First output frame of the segment (where an incoming transition starts). */
  startFrame: number;
  /** One past the segment's last output frame. */
  endFrame: number;
  /** endFrame − startFrame, always at least 1. */
  frames: number;
  /** Frames shared with the previous segment by an `xfade` (0 for the first segment and hard cuts). */
  transitionFrames: number;
}

/**
 * Snaps computeTimeline's continuous times to the output frame grid cumulatively: every segment
 * boundary is rounded to the nearest frame once, and a segment spans the frames between its rounded
 * start and end. Rounding each segment's length on its own instead lets the errors add up — a
 * 16-cut beat montage could end several frames away from the plan, fail verifyExport and drift off
 * the music it was cut to. Here the file's length and every cut stay within half a frame of the plan.
 */
export function quantiseTimeline(timeline: Timeline, fps: number): SegmentFrames[] {
  const out: SegmentFrames[] = [];
  let previousEnd = 0;
  for (const placed of timeline.segments) {
    let startFrame = 0;
    let transitionFrames = 0;
    if (placed.index > 0) {
      if (placed.transitionInSec > 0) {
        // xfade needs at least one shared frame, and cannot reach back past the start of the stream.
        startFrame = Math.max(0, Math.min(Math.round(placed.startSec * fps), previousEnd - 1));
        transitionFrames = previousEnd - startFrame;
      } else {
        startFrame = previousEnd;
      }
    }
    // The segment must outlast the transition into it by at least one frame.
    const endFrame = Math.max(startFrame + transitionFrames + 1, Math.round(placed.endSec * fps));
    out.push({ index: placed.index, startFrame, endFrame, frames: endFrame - startFrame, transitionFrames });
    previousEnd = endFrame;
  }
  return out;
}

/**
 * Cloned frames appended to a segment before it is trimmed. Snapping a boundary can ask a segment
 * for up to one frame more than its source span holds, and the `fps` filter can drop the last
 * frame of a speed-changed span; the padding guarantees `trim` always finds the full frame count.
 */
export const SEGMENT_PAD_FRAMES = 3;

/**
 * Builds the per-segment video chain:
 * reset timestamps → speed change → constant frame rate (padded, then trimmed to the exact frame count) →
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
  const frames = Math.max(1, Math.floor(options.frames));
  const focusX = segment.framing.mode === 'focus' ? clamp01(segment.framing.focusX) : 0.5;
  const focusY = segment.framing.mode === 'focus' ? clamp01(segment.framing.focusY) : 0.5;

  const steps: string[] = ['setpts=PTS-STARTPTS'];
  if (segment.speed !== 1) {
    steps.push(`setpts=PTS/${formatNumber(segment.speed)}`);
  }
  steps.push(`fps=${fps}`, `tpad=stop_mode=clone:stop=${SEGMENT_PAD_FRAMES}`, `trim=end_frame=${frames}`);
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
