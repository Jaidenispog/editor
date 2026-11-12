import type { EditPlan, Timeline } from '@studio/core';
import { formatNumber } from './escape.js';
import type { RenderAsset } from './types.js';

/** Every audio stem is brought to the same format before mixing. */
export const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** Music gain while a kept original-sound segment is playing (about -12 dB). */
export const DUCK_GAIN = 0.25;

/**
 * Splits a speed change into `atempo` stages that each stay within 0.5–2.0, where the filter
 * sounds best. Speed 1 needs no stage at all.
 */
export function atempoChain(speed: number): string[] {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RangeError(`Speed must be a positive number, got ${String(speed)}`);
  }
  const stages: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    stages.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    stages.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) {
    stages.push(`atempo=${formatNumber(remaining)}`);
  }
  return stages;
}

export interface AudioGraphOptions {
  plan: EditPlan;
  timeline: Timeline;
  assets: Record<string, RenderAsset>;
  /** FFmpeg input index of the music file, or null when the plan has no music. */
  musicInputIndex: number | null;
}

export interface AudioGraph {
  /** Filter chains to append to the filtergraph (empty when the edit has no sound). */
  filters: string[];
  /** False means the output should be muxed without an audio stream (`-an`). */
  hasAudio: boolean;
  /** Output-time windows (seconds) where original sound plays; music ducks under them. */
  originalWindows: Array<{ startSec: number; endSec: number }>;
}

/** True when a segment's own sound is part of the mix: asked for by the segment or globally, and present. */
export function segmentKeepsSound(plan: EditPlan, segmentIndex: number, assets: Record<string, RenderAsset>): boolean {
  const segment = plan.segments[segmentIndex];
  if (!segment) return false;
  const asset = assets[segment.assetId];
  if (!asset || asset.probe.audio === null) return false;
  if (plan.audio.originalSound.volume <= 0) return false;
  return segment.keepOriginalSound || plan.audio.originalSound.enabled;
}

/**
 * Builds the audio side of the graph: the music stem (trimmed to the edit, faded, ducked under
 * original sound), one stem per segment that keeps its own sound (tempo-matched, delayed to its
 * place on the timeline), mixed together, loudness-normalised and resampled to 48 kHz as `[aout]`.
 *
 * Loudness is a single `loudnorm` pass. A two-pass upgrade would run `loudnorm=print_format=json`
 * over the mix first and feed `measured_I/measured_TP/measured_LRA/measured_thresh` back with
 * `linear=true`; the extra pass costs a full decode and was not worth it for previews.
 */
export function buildAudioGraph(options: AudioGraphOptions): AudioGraph {
  const { plan, timeline, assets, musicInputIndex } = options;
  const total = timeline.totalDurationSec;
  const filters: string[] = [];
  const stems: string[] = [];
  const originalWindows: Array<{ startSec: number; endSec: number }> = [];

  const keptIndices = timeline.segments.filter((p) => segmentKeepsSound(plan, p.index, assets)).map((p) => p.index);
  for (const index of keptIndices) {
    const placed = timeline.segments[index];
    if (!placed) continue;
    originalWindows.push({ startSec: placed.startSec, endSec: Math.min(placed.endSec, total) });
  }

  const music = plan.audio.music;
  if (music && musicInputIndex !== null) {
    const parts = [
      `[${musicInputIndex}:a]atrim=start=${formatNumber(music.startOffsetSec)}:end=${formatNumber(music.startOffsetSec + total)}`,
      'asetpts=PTS-STARTPTS',
      AUDIO_FORMAT,
      `volume=${formatNumber(music.volume)}`,
    ];
    if (music.fadeInSec > 0) {
      parts.push(`afade=t=in:st=0:d=${formatNumber(Math.min(music.fadeInSec, total))}`);
    }
    if (music.fadeOutSec > 0) {
      const fadeOut = Math.min(music.fadeOutSec, total);
      parts.push(`afade=t=out:st=${formatNumber(Math.max(0, total - fadeOut))}:d=${formatNumber(fadeOut)}`);
    }
    if (music.duckUnderOriginal) {
      for (const window of originalWindows) {
        parts.push(`volume=${formatNumber(DUCK_GAIN)}:enable='between(t,${formatNumber(window.startSec)},${formatNumber(window.endSec)})'`);
      }
    }
    parts.push('apad', `atrim=end=${formatNumber(total)}`);
    filters.push(`${parts.join(',')}[music]`);
    stems.push('music');
  }

  for (const index of keptIndices) {
    const placed = timeline.segments[index];
    if (!placed) continue;
    const next = timeline.segments[index + 1];
    const fadeIn = placed.transitionInSec;
    const fadeOut = next ? next.transitionInSec : 0;
    const parts = [`[${index}:a]asetpts=PTS-STARTPTS`, AUDIO_FORMAT, ...atempoChain(placed.segment.speed)];
    // Original sound crosses over with the neighbouring segment for exactly the video transition.
    if (fadeIn > 0) {
      parts.push(`afade=t=in:st=0:d=${formatNumber(fadeIn)}`);
    }
    if (fadeOut > 0) {
      parts.push(`afade=t=out:st=${formatNumber(Math.max(0, placed.playDurationSec - fadeOut))}:d=${formatNumber(fadeOut)}`);
    }
    const delayMs = Math.max(0, Math.round(placed.startSec * 1000));
    parts.push(`volume=${formatNumber(plan.audio.originalSound.volume)}`, `adelay=${delayMs}|${delayMs}`, 'apad', `atrim=end=${formatNumber(total)}`);
    const label = `o_${index}`;
    filters.push(`${parts.join(',')}[${label}]`);
    stems.push(label);
  }

  if (stems.length === 0) {
    return { filters: [], hasAudio: false, originalWindows };
  }

  const loudnorm = `loudnorm=I=${formatNumber(plan.audio.loudnessTargetLufs)}:TP=-1.5:LRA=11`;
  const inputs = stems.map((s) => `[${s}]`).join('');
  if (stems.length === 1) {
    filters.push(`${inputs}${loudnorm},aresample=48000[aout]`);
  } else {
    filters.push(`${inputs}amix=inputs=${stems.length}:normalize=0:duration=longest,${loudnorm},aresample=48000[aout]`);
  }
  return { filters, hasAudio: true, originalWindows };
}
