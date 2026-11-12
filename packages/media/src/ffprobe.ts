import { execa } from 'execa';
import { stat } from 'node:fs/promises';
import { AssetProbeSchema, type AssetProbe } from '@studio/core';

interface FfprobeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  color_range?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  disposition?: Record<string, number>;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { format_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> };
}

export async function ffprobeRaw(filePath: string, ffprobePath = 'ffprobe'): Promise<FfprobeOutput> {
  const result = await execa(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 120_000, reject: false, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`ffprobe failed (${result.exitCode}): ${(result.stderr ?? '').trim().split('\n').pop() ?? 'unknown error'}`);
  }
  return JSON.parse(result.stdout) as FfprobeOutput;
}

function parseRate(s: string | undefined): number {
  if (!s) return 0;
  const [n, d] = s.split('/').map(Number);
  if (!n || !d) return Number(s) || 0;
  return n / d;
}

function normaliseRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

export function rotationFromStream(stream: FfprobeStream): 0 | 90 | 180 | 270 {
  const sd = stream.side_data_list?.find((s) => typeof s.rotation === 'number');
  if (sd && typeof sd.rotation === 'number') {
    // ffprobe reports the display matrix rotation as counter-clockwise degrees (e.g. -90 for portrait iPhone).
    return normaliseRotation(-sd.rotation);
  }
  const tag = stream.tags?.['rotate'];
  if (tag) return normaliseRotation(Number(tag));
  return 0;
}

function detectHdr(stream: FfprobeStream): { isHdr: boolean; hdrFormat: 'hlg' | 'pq' | null } {
  const trc = (stream.color_transfer ?? '').toLowerCase();
  if (trc === 'arib-std-b67') return { isHdr: true, hdrFormat: 'hlg' };
  if (trc === 'smpte2084') return { isHdr: true, hdrFormat: 'pq' };
  return { isHdr: false, hdrFormat: null };
}

/** Probes a media file and normalises the facts the pipeline needs (rotation, HDR, audio presence). */
export async function probeMedia(filePath: string, ffprobePath = 'ffprobe'): Promise<AssetProbe> {
  const raw = await ffprobeRaw(filePath, ffprobePath);
  const fileSize = Number(raw.format.size) || (await stat(filePath)).size;
  const video = raw.streams.find((s) => s.codec_type === 'video' && !(s.disposition?.['attached_pic'] === 1));
  const audio = raw.streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(raw.format.duration) || Number(video?.duration) || Number(audio?.duration) || 0;

  let videoInfo: AssetProbe['video'] = null;
  if (video && video.width && video.height) {
    const rotation = rotationFromStream(video);
    const swap = rotation === 90 || rotation === 270;
    const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
    const pix = video.pix_fmt ?? null;
    const bitDepth = Number(video.bits_per_raw_sample) || (pix && /10le|10be|p010/.test(pix) ? 10 : pix && /12/.test(pix) ? 12 : 8);
    const hdr = detectHdr(video);
    videoInfo = {
      codec: video.codec_name ?? 'unknown',
      codedWidth: video.width,
      codedHeight: video.height,
      displayWidth: swap ? video.height : video.width,
      displayHeight: swap ? video.width : video.height,
      rotation,
      fps: Math.round(fps * 1000) / 1000,
      pixelFormat: pix,
      bitDepth,
      colour: {
        primaries: video.color_primaries ?? null,
        transfer: video.color_transfer ?? null,
        matrix: video.color_space ?? null,
        range: video.color_range ?? null,
      },
      isHdr: hdr.isHdr,
      hdrFormat: hdr.hdrFormat,
      bitrate: Number(video.bit_rate) || null,
    };
  }

  const probe: AssetProbe = {
    container: (raw.format.format_name ?? 'unknown').split(',')[0] ?? 'unknown',
    durationSec: Math.round(durationSec * 1000) / 1000,
    fileSizeBytes: fileSize,
    video: videoInfo,
    audio: audio
      ? {
          codec: audio.codec_name ?? 'unknown',
          sampleRate: Number(audio.sample_rate) || 0,
          channels: audio.channels ?? 0,
          bitrate: Number(audio.bit_rate) || null,
        }
      : null,
  };
  return AssetProbeSchema.parse(probe);
}
