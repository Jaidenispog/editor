import { AppError, VERTICAL_1080, VERTICAL_PREVIEW, computeTimeline, type OutputFormat } from '@studio/core';
import { buildAudioGraph } from './audio-filters.js';
import { escapeFilterPath, formatNumber } from './escape.js';
import { buildLogoFilters, type LogoLayout } from './logo.js';
import { buildSegmentFilter, quantiseTimeline } from './video-filters.js';
import type { RenderCommand, RenderInputs } from './types.js';

/** Resolves the output size/frame rate: an explicit format wins, otherwise it follows the quality. */
export function resolveOutputFormat(inputs: Pick<RenderInputs, 'output' | 'quality'>): OutputFormat {
  return inputs.output ?? (inputs.quality === 'export' ? VERTICAL_1080 : VERTICAL_PREVIEW);
}

/** Longest edit the renderer accepts: 3 minutes keeps one file valid for Instagram Reels and TikTok. */
export const MAX_RENDER_DURATION_SEC = 180;

/** Exports longer than this use the lower peak bitrate so a 180 s file stays under Instagram's 300 MB cap. */
export const LONG_EXPORT_SEC = 90;

/**
 * H.264 level for a 1080x1920 export: 4.1 covers 1080p up to 30 fps, 4.2 is needed above that
 * (8,160 macroblocks per frame; level 4.1 allows 245,760 per second, 4.2 allows 522,240).
 */
export function exportLevelFor(fps: number): '4.1' | '4.2' {
  return fps <= 30 ? '4.1' : '4.2';
}

/**
 * Video encoder settings. Both qualities share the frame-rate and GOP settings (constant frame
 * rate; closed 2 s GOP, i.e. a keyframe exactly every 2 s and never an extra one on a scene change)
 * and the BT.709 tags, so a preview behaves like its export. Previews favour speed (veryfast,
 * CRF 27). Exports use the platform preset from docs/research/platform-constraints.md section 5:
 * libx264 High profile at level 4.1 (≤ 30 fps) or 4.2 (60 fps), CRF 18 with a peak of 20 Mbit/s
 * (24 at 60 fps, 12 for edits over 90 s), yuv420p, progressive.
 */
export function videoCodecArgs(quality: RenderInputs['quality'], fps: number, durationSec = 0): string[] {
  const gop = String(fps * 2);
  const shared = [
    '-pix_fmt',
    'yuv420p',
    '-field_order',
    'progressive',
    '-r',
    String(fps),
    '-fps_mode',
    'cfr',
    '-g',
    gop,
    '-keyint_min',
    gop,
    '-sc_threshold',
    '0',
    '-flags',
    '+cgop',
    '-bf',
    '2',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
  ];
  if (quality === 'export') {
    const peak = durationSec > LONG_EXPORT_SEC ? 12 : fps > 30 ? 24 : 20;
    return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-maxrate', `${peak}M`, '-bufsize', `${peak * 2}M`, '-profile:v', 'high', '-level:v', exportLevelFor(fps), ...shared];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-profile:v', 'high', ...shared];
}

/** Refuses an edit longer than MAX_RENDER_DURATION_SEC with a plain AppError('VALIDATION'). */
export function assertRenderableDuration(totalDurationSec: number): void {
  if (totalDurationSec > MAX_RENDER_DURATION_SEC) {
    throw new AppError(
      'VALIDATION',
      `This edit runs for ${Math.round(totalDurationSec)} seconds. Videos for Instagram and TikTok can be at most 3 minutes, so shorten it and try again.`,
      { details: { totalDurationSec, maxDurationSec: MAX_RENDER_DURATION_SEC } },
    );
  }
}

/** Audio encoder settings for both qualities: AAC-LC, 192 kbit/s, 48 kHz, stereo. */
export const AUDIO_CODEC_ARGS: readonly string[] = ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

/**
 * Turns a validated plan into one FFmpeg invocation. Pure: nothing is read or written.
 *
 * Inputs: one `-ss/-t/-i` per segment (accurate input seeking, auto-rotation left on), then the
 * music file. Video: a chain per segment (see buildSegmentFilter), joined left to right with
 * `concat` for hard cuts or `xfade` for transitions, with every length, offset and transition
 * snapped to the frame grid by quantiseTimeline, then the logo (when `logoLayout` draws one; see logo.ts), then the
 * ASS overlay. Audio: see buildAudioGraph. The output is trimmed to the timeline
 * total so the file length matches the plan to within a frame.
 */
export function buildRenderCommand(inputs: RenderInputs, outputPath: string, assPath: string | null, logoLayout: LogoLayout | null = null): RenderCommand {
  const { plan } = inputs;
  const output = resolveOutputFormat(inputs);
  const timeline = computeTimeline(plan);
  const total = timeline.totalDurationSec;
  assertRenderableDuration(total);
  const threads = inputs.threads && inputs.threads > 0 ? Math.floor(inputs.threads) : 0;

  const args: string[] = [];
  if (threads > 0) {
    args.push('-filter_threads', String(threads));
  }

  for (const segment of plan.segments) {
    const asset = inputs.assets[segment.assetId];
    if (!asset) {
      throw new AppError('VALIDATION', `Segment ${segment.id} refers to a clip that is not available (${segment.assetId})`);
    }
    args.push('-ss', segment.inSec.toFixed(3), '-t', (segment.outSec - segment.inSec).toFixed(3), '-i', asset.path);
  }

  const musicInputIndex = plan.audio.music && inputs.music ? plan.segments.length : null;
  if (musicInputIndex !== null && inputs.music) {
    args.push('-i', inputs.music.path);
  }

  // The logo, looped as a still at the output frame rate and cut to the edit's length.
  const logo = inputs.brand.logo ?? null;
  const drawsLogo = Boolean(logo && logoLayout && (logoLayout.corner || logoLayout.endCard));
  const logoInputIndex = drawsLogo ? plan.segments.length + (musicInputIndex !== null ? 1 : 0) : null;
  if (drawsLogo && logo) {
    args.push('-loop', '1', '-framerate', String(output.fps), '-t', formatNumber(total), '-i', logo.path);
  }

  const frameGrid = quantiseTimeline(timeline, output.fps);
  const filters: string[] = [];
  for (const placed of timeline.segments) {
    const asset = inputs.assets[placed.segment.assetId];
    filters.push(
      buildSegmentFilter({
        inputIndex: placed.index,
        segment: placed.segment,
        frames: frameGrid[placed.index]!.frames,
        isHdr: asset?.probe.video?.isHdr ?? false,
        output,
        colourPreset: plan.colourPreset,
        outputLabel: `v_${placed.index}`,
      }),
    );
  }

  let current = 'v_0';
  for (const placed of timeline.segments.slice(1)) {
    const k = placed.index;
    const label = `x_${k}`;
    const transition = placed.segment.transitionIn;
    const grid = frameGrid[k]!;
    if (transition && grid.transitionFrames > 0) {
      const duration = formatNumber(grid.transitionFrames / output.fps);
      const offset = formatNumber(grid.startFrame / output.fps);
      filters.push(`[${current}][v_${k}]xfade=transition=${transition.type}:duration=${duration}:offset=${offset}[${label}]`);
    } else {
      // concat outputs a 1/1000000 timebase; xfade needs both inputs on the same 1/F timebase, so restore it
      // here or any transition that follows a hard cut fails to configure.
      filters.push(`[${current}][v_${k}]concat=n=2:v=1:a=0,settb=1/${output.fps}[${label}]`);
    }
    current = label;
  }

  if (logoInputIndex !== null && logoLayout) {
    // Before the text, so captions and titles always sit on top of the logo.
    filters.push(...buildLogoFilters(logoLayout, logoInputIndex, current, 'vlogo'));
    current = 'vlogo';
  }

  if (assPath) {
    filters.push(`[${current}]ass=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(inputs.fontsDir)}[vout]`);
  } else {
    filters.push(`[${current}]null[vout]`);
  }

  const audio = buildAudioGraph({ plan, timeline, assets: inputs.assets, musicInputIndex });
  filters.push(...audio.filters);

  const filterComplex = filters.join(';');
  args.push('-filter_complex', filterComplex, '-map', '[vout]');
  if (audio.hasAudio) {
    args.push('-map', '[aout]', ...AUDIO_CODEC_ARGS);
  } else {
    args.push('-an');
  }

  args.push(...videoCodecArgs(inputs.quality, output.fps, total), '-movflags', '+faststart');
  if (threads > 0) {
    args.push('-threads', String(threads));
  }
  args.push('-t', formatNumber(total), '-f', 'mp4', outputPath);

  return { args, filterComplex, totalDurationSec: total, hasAudio: audio.hasAudio };
}
