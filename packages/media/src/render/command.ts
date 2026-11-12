import { AppError, VERTICAL_1080, VERTICAL_PREVIEW, computeTimeline, type OutputFormat } from '@studio/core';
import { buildAudioGraph } from './audio-filters.js';
import { escapeFilterPath, formatNumber } from './escape.js';
import { buildSegmentFilter } from './video-filters.js';
import type { RenderCommand, RenderInputs } from './types.js';

/** Resolves the output size/frame rate: an explicit format wins, otherwise it follows the quality. */
export function resolveOutputFormat(inputs: Pick<RenderInputs, 'output' | 'quality'>): OutputFormat {
  return inputs.output ?? (inputs.quality === 'export' ? VERTICAL_1080 : VERTICAL_PREVIEW);
}

/** Encoder settings per quality. Previews favour speed; exports favour fidelity. */
export function videoCodecArgs(quality: RenderInputs['quality']): string[] {
  if (quality === 'export') {
    return ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
}

/**
 * Turns a validated plan into one FFmpeg invocation. Pure: nothing is read or written.
 *
 * Inputs: one `-ss/-t/-i` per segment (accurate input seeking, auto-rotation left on), then the
 * music file. Video: a chain per segment (see buildSegmentFilter), joined left to right with
 * `concat` for hard cuts or `xfade` for transitions whose offsets are computeTimeline's start
 * times, then the ASS overlay. Audio: see buildAudioGraph. The output is trimmed to the timeline
 * total so the file length matches the plan to within a frame.
 */
export function buildRenderCommand(inputs: RenderInputs, outputPath: string, assPath: string | null): RenderCommand {
  const { plan } = inputs;
  const output = resolveOutputFormat(inputs);
  const timeline = computeTimeline(plan);
  const total = timeline.totalDurationSec;
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

  const filters: string[] = [];
  for (const placed of timeline.segments) {
    const asset = inputs.assets[placed.segment.assetId];
    filters.push(
      buildSegmentFilter({
        inputIndex: placed.index,
        segment: placed.segment,
        playDurationSec: placed.playDurationSec,
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
    if (transition) {
      filters.push(
        `[${current}][v_${k}]xfade=transition=${transition.type}:duration=${formatNumber(transition.durationSec)}:offset=${formatNumber(placed.startSec)}[${label}]`,
      );
    } else {
      filters.push(`[${current}][v_${k}]concat=n=2:v=1:a=0[${label}]`);
    }
    current = label;
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
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(...videoCodecArgs(inputs.quality));
  args.push(
    '-r',
    String(output.fps),
    '-g',
    String(output.fps * 2),
    '-bf',
    '2',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-movflags',
    '+faststart',
  );
  if (threads > 0) {
    args.push('-threads', String(threads));
  }
  args.push('-t', formatNumber(total), '-f', 'mp4', outputPath);

  return { args, filterComplex, totalDurationSec: total };
}
