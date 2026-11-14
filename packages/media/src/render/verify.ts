import { ffprobeRaw, type FfprobeOutput } from '../ffprobe.js';

/** What an exported file must look like (docs/research/platform-constraints.md section 5). */
export interface ExportExpectation {
  width: number;
  height: number;
  fps: number;
  /** H.264 level as a string, e.g. "4.1". */
  level: string;
  /** Whether the plan produces sound; when false the file must have no audio stream. */
  hasAudio: boolean;
  /** The timeline length the file must match to within one frame. */
  durationSec: number;
}

/** The result of checking an export: `problems` lists every mismatch in plain technical terms (for logs). */
export interface ExportCheck {
  ok: boolean;
  problems: string[];
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) return Number(rate) || 0;
  return n / d;
}

/**
 * Checks an ffprobe report against the export preset: H.264 High profile at the expected level,
 * yuv420p, progressive, constant frame rate, the expected size, BT.709 tags, AAC-LC 48 kHz stereo
 * when there is sound (and no audio stream when there is none), and a duration within one frame of
 * the timeline. Pure, so it can be tested without FFmpeg.
 */
export function checkExportProbe(raw: FfprobeOutput, expected: ExportExpectation): ExportCheck {
  const problems: string[] = [];
  const videos = raw.streams.filter((s) => s.codec_type === 'video');
  const audios = raw.streams.filter((s) => s.codec_type === 'audio');
  const video = videos[0];

  if (videos.length !== 1 || !video) {
    problems.push(`expected one video stream, found ${videos.length}`);
  } else {
    if (video.codec_name !== 'h264') problems.push(`video codec is ${video.codec_name ?? 'unknown'}, expected h264`);
    if (video.profile !== 'High') problems.push(`H.264 profile is ${video.profile ?? 'unknown'}, expected High`);
    const level = Math.round(Number(expected.level) * 10);
    if (video.level !== level) problems.push(`H.264 level is ${video.level ?? 'unknown'}, expected ${level}`);
    if (video.pix_fmt !== 'yuv420p') problems.push(`pixel format is ${video.pix_fmt ?? 'unknown'}, expected yuv420p`);
    if (video.width !== expected.width || video.height !== expected.height) {
      problems.push(`frame is ${video.width ?? '?'}x${video.height ?? '?'}, expected ${expected.width}x${expected.height}`);
    }
    if (video.side_data_list?.some((s) => typeof s.rotation === 'number' && s.rotation !== 0)) problems.push('video carries a rotation flag');
    if (video.field_order !== 'progressive') problems.push(`field order is ${video.field_order ?? 'unknown'}, expected progressive`);
    for (const [field, value] of [
      ['colour matrix', video.color_space],
      ['colour transfer', video.color_transfer],
      ['colour primaries', video.color_primaries],
    ] as const) {
      if (value !== 'bt709') problems.push(`${field} is ${value ?? 'untagged'}, expected bt709`);
    }
    const rFps = parseRate(video.r_frame_rate);
    const avgFps = parseRate(video.avg_frame_rate);
    if (Math.abs(rFps - expected.fps) > 1e-6) problems.push(`frame rate is ${video.r_frame_rate ?? 'unknown'}, expected ${expected.fps}`);
    if (Math.abs(avgFps - expected.fps) > expected.fps * 0.005) problems.push(`average frame rate is ${video.avg_frame_rate ?? 'unknown'}, so the frame rate is not constant at ${expected.fps}`);
  }

  if (expected.hasAudio) {
    const audio = audios[0];
    if (audios.length !== 1 || !audio) {
      problems.push(`expected one audio stream, found ${audios.length}`);
    } else {
      if (audio.codec_name !== 'aac' || audio.profile !== 'LC') problems.push(`audio is ${audio.codec_name ?? 'unknown'} ${audio.profile ?? ''}`.trimEnd() + ', expected AAC-LC');
      if (Number(audio.sample_rate) !== 48000) problems.push(`audio sample rate is ${audio.sample_rate ?? 'unknown'}, expected 48000`);
      if (audio.channels !== 2) problems.push(`audio has ${audio.channels ?? 'unknown'} channels, expected 2`);
    }
  } else if (audios.length > 0) {
    problems.push(`expected no audio stream, found ${audios.length}`);
  }

  const frame = 1 / expected.fps;
  const formatDuration = Number(raw.format.duration);
  if (!Number.isFinite(formatDuration) || Math.abs(formatDuration - expected.durationSec) > frame + 1e-3) {
    problems.push(`file lasts ${raw.format.duration ?? 'unknown'} s, expected ${expected.durationSec.toFixed(3)} s within one frame`);
  }
  const videoDuration = Number(video?.duration);
  if (video && (!Number.isFinite(videoDuration) || Math.abs(videoDuration - expected.durationSec) > frame + 1e-3)) {
    problems.push(`video lasts ${video.duration ?? 'unknown'} s, expected ${expected.durationSec.toFixed(3)} s within one frame`);
  }

  return { ok: problems.length === 0, problems };
}

/** Probes an exported file with ffprobe and checks it against the export preset (see checkExportProbe). */
export async function verifyExport(filePath: string, expected: ExportExpectation, ffprobePath = 'ffprobe'): Promise<ExportCheck> {
  return checkExportProbe(await ffprobeRaw(filePath, ffprobePath), expected);
}
