import { fileURLToPath } from 'node:url';
import { VERTICAL_1080, type AssetProbe, type EditPlan } from '@studio/core';
import type { RenderBrand } from '../src/render/index.js';

export const SAMPLES_DIR = fileURLToPath(new URL('../../../data/samples/', import.meta.url));
export const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));

export const SAMPLE_FILES = {
  a: `${SAMPLES_DIR}sample_a_portrait_sdr.mp4`,
  b: `${SAMPLES_DIR}sample_b_rotated_hevc_hlg.mov`,
  c: `${SAMPLES_DIR}sample_c_noaudio_scenes.mp4`,
  music: `${SAMPLES_DIR}sample_music_120bpm.mp3`,
} as const;

export const ASSET_IDS = { a: 'asset-a', b: 'asset-b', c: 'asset-c' } as const;
export const MUSIC_TRACK_ID = 'track-120';

export const TEST_BRAND: RenderBrand = {
  accentColour: '#C8A24A',
  videoTextStyle: 'minimal',
  fontHeadline: 'Inter Display',
  fontBody: 'Inter',
  socialHandle: '@ivanhoe.barber',
};

/** A probe shaped like the real samples, for tests that never touch FFmpeg. */
export function fakeProbe(options: { durationSec: number; hasAudio: boolean; hdr?: boolean; rotated?: boolean }): AssetProbe {
  const rotated = options.rotated ?? false;
  return {
    container: 'mov',
    durationSec: options.durationSec,
    fileSizeBytes: 1_000_000,
    video: {
      codec: options.hdr ? 'hevc' : 'h264',
      codedWidth: rotated ? 1920 : 1080,
      codedHeight: rotated ? 1080 : 1920,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: rotated ? 90 : 0,
      fps: 30,
      pixelFormat: options.hdr ? 'yuv420p10le' : 'yuv420p',
      bitDepth: options.hdr ? 10 : 8,
      colour: options.hdr
        ? { primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv' }
        : { primaries: null, transfer: null, matrix: null, range: null },
      isHdr: options.hdr ?? false,
      hdrFormat: options.hdr ? 'hlg' : null,
      bitrate: null,
    },
    audio: options.hasAudio ? { codec: 'aac', sampleRate: 48000, channels: 1, bitrate: 96000 } : null,
  };
}

/**
 * The plan every render test starts from, built from the synthetic samples:
 * a (speed 1.5, zoom 1→1.1, original sound kept) → b (HDR, rotated; fade 0.5 s) →
 * c (wipe 0.4 s; focus framing) → a again (hard cut). 2.0 + 2.5 + 3.0 + 2.0 − 0.5 − 0.4 = 8.6 s.
 */
export function samplePlan(): EditPlan {
  return {
    version: 1,
    styleId: 'before_after',
    title: 'Fresh skin fade',
    description: 'Before and after with a quick look at the work in between.',
    rationale: '',
    output: VERTICAL_1080,
    targetDurationSec: 8,
    segments: [
      { id: 's0', assetId: ASSET_IDS.a, inSec: 0.5, outSec: 3.5, speed: 1.5, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: { from: 1, to: 1.1 }, transitionIn: null, role: 'cutting', keepOriginalSound: true },
      { id: 's1', assetId: ASSET_IDS.b, inSec: 1.0, outSec: 3.5, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: { type: 'fade', durationSec: 0.5 }, role: 'fade_detail', keepOriginalSound: false },
      { id: 's2', assetId: ASSET_IDS.c, inSec: 0.5, outSec: 3.5, speed: 1, framing: { mode: 'focus', focusX: 0.3, focusY: 0.4 }, zoom: null, transitionIn: { type: 'wipeleft', durationSec: 0.4 }, role: 'before', keepOriginalSound: false },
      { id: 's3', assetId: ASSET_IDS.a, inSec: 8, outSec: 10, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role: 'result', keepOriginalSound: false },
    ],
    textOverlays: [
      { id: 't1', text: 'Fresh skin fade', startSec: 0.4, endSec: 2.4, placement: 'top', style: 'headline', animation: 'rise', emphasis: 'normal' },
      { id: 't2', text: "Ivanhoe's finest", startSec: 1.0, endSec: 3.0, placement: 'lower', style: 'headline', animation: 'pop', emphasis: 'accent' },
      { id: 't3', text: 'Before', startSec: 4.0, endSec: 6.0, placement: 'centre', style: 'label', animation: 'fade', emphasis: 'normal' },
      { id: 't4', text: 'Book online', startSec: 6.8, endSec: 8.4, placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal' },
    ],
    captions: [],
    audio: {
      music: { trackId: MUSIC_TRACK_ID, startOffsetSec: 2, volume: 0.85, fadeInSec: 0.3, fadeOutSec: 1.2, duckUnderOriginal: true },
      originalSound: { enabled: false, volume: 1 },
      beatAlignment: null,
      loudnessTargetLufs: -14,
    },
    colourPreset: 'natural',
  };
}

/** A short two-segment plan (4 s) used where a full render would only cost time. */
export function shortPlan(): EditPlan {
  const plan = samplePlan();
  plan.targetDurationSec = 6;
  plan.segments = [plan.segments[0]!, { ...plan.segments[3]!, id: 's1' }];
  plan.textOverlays = [];
  return plan;
}
