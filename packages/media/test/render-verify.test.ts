import { describe, expect, it } from 'vitest';
import type { FfprobeOutput } from '../src/ffprobe.js';
import { checkExportProbe, type ExportExpectation } from '../src/render/index.js';

const EXPECTED: ExportExpectation = { width: 1080, height: 1920, fps: 30, level: '4.1', hasAudio: true, durationSec: 8.6 };

/** An ffprobe report shaped like a good export. */
function goodProbe(): FfprobeOutput {
  return {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        level: 41,
        width: 1080,
        height: 1920,
        pix_fmt: 'yuv420p',
        field_order: 'progressive',
        color_space: 'bt709',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        r_frame_rate: '30/1',
        avg_frame_rate: '30/1',
        duration: '8.600000',
      },
      { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC', sample_rate: '48000', channels: 2, duration: '8.597333' },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '8.600000' },
  };
}

describe('checkExportProbe', () => {
  it('passes a file that matches the export preset', () => {
    expect(checkExportProbe(goodProbe(), EXPECTED)).toEqual({ ok: true, problems: [] });
  });

  it('lists every way a file misses the preset', () => {
    const raw = goodProbe();
    const video = raw.streams[0]!;
    Object.assign(video, {
      codec_name: 'hevc',
      profile: 'Main',
      level: 42,
      pix_fmt: 'yuv420p10le',
      width: 540,
      height: 960,
      field_order: 'tt',
      color_transfer: 'arib-std-b67',
      avg_frame_rate: '29/1',
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    });
    Object.assign(raw.streams[1]!, { profile: 'HE-AAC', sample_rate: '44100', channels: 1 });
    raw.format.duration = '9.0';
    const { ok, problems } = checkExportProbe(raw, EXPECTED);
    expect(ok).toBe(false);
    const text = problems.join('\n');
    for (const fragment of [
      'video codec is hevc',
      'H.264 profile is Main',
      'H.264 level is 42, expected 41',
      'pixel format is yuv420p10le',
      'frame is 540x960, expected 1080x1920',
      'rotation flag',
      'field order is tt',
      'colour transfer is arib-std-b67',
      'frame rate is not constant',
      'expected AAC-LC',
      'sample rate is 44100',
      'audio has 1 channels',
      'file lasts 9.0 s',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('allows one frame of difference in duration but not more', () => {
    const raw = goodProbe();
    raw.format.duration = '8.633';
    raw.streams[0]!.duration = '8.566';
    expect(checkExportProbe(raw, EXPECTED).ok).toBe(true);
    raw.streams[0]!.duration = '8.55';
    expect(checkExportProbe(raw, EXPECTED).problems).toEqual(['video lasts 8.55 s, expected 8.600 s within one frame']);
  });

  it('expects level 4.2 at 60 fps and no audio stream for a silent edit', () => {
    const raw = goodProbe();
    raw.streams = [{ ...raw.streams[0]!, level: 42, r_frame_rate: '60/1', avg_frame_rate: '60/1' }];
    expect(checkExportProbe(raw, { ...EXPECTED, fps: 60, level: '4.2', hasAudio: false }).ok).toBe(true);
    const withAudio = goodProbe();
    expect(checkExportProbe(withAudio, { ...EXPECTED, hasAudio: false }).problems).toEqual(['expected no audio stream, found 1']);
    const missing = goodProbe();
    missing.streams = [missing.streams[0]!];
    expect(checkExportProbe(missing, EXPECTED).problems).toEqual(['expected one audio stream, found 0']);
  });

  it('reports a file with no video at all', () => {
    const raw = goodProbe();
    raw.streams = [raw.streams[1]!];
    expect(checkExportProbe(raw, EXPECTED).problems).toContain('expected one video stream, found 0');
  });
});
