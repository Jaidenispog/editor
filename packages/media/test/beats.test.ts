import { beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { ensureSamples, hasFfmpeg, noiseSource, samplePath } from './analysis-fixtures.js';
import { probeMedia } from '../src/ffprobe.js';
import { analyseMusic, BEAT_DETECTION, detectBeats } from '../src/analysis/index.js';

const MUSIC_SAMPLE = samplePath('sample_music_120bpm.mp3');
const SAMPLE_RATE = 22050;

interface ClickTrackOptions {
  bpm: number;
  seconds: number;
  noiseAmplitude?: number;
  /** 2 writes interleaved stereo with every other click hard-panned to the opposite channel. */
  channels?: 1 | 2;
}

/** Short decaying 1.5 kHz clicks on a steady grid over low noise, the way a metronome track sounds. */
function clickTrack(options: ClickTrackOptions): Float32Array {
  const channels = options.channels ?? 1;
  const frames = Math.round(options.seconds * SAMPLE_RATE);
  const out = new Float32Array(frames * channels);
  const noise = noiseSource(7);
  const noiseAmplitude = options.noiseAmplitude ?? 0.005;
  for (let i = 0; i < out.length; i++) out[i] = noiseAmplitude * noise();
  const period = 60 / options.bpm;
  for (let beat = 0; beat * period < options.seconds; beat++) {
    const start = Math.round(beat * period * SAMPLE_RATE);
    const channel = channels === 2 ? beat % 2 : 0;
    for (let k = 0; k < 400 && start + k < frames; k++) {
      const index = (start + k) * channels + channel;
      out[index] = out[index]! + 0.8 * Math.exp(-k / 80) * Math.sin((2 * Math.PI * 1500 * k) / SAMPLE_RATE);
    }
  }
  return out;
}

function gridErrorsMs(beatTimesSec: number[], periodSec: number): number[] {
  return beatTimesSec.map((t) => Math.abs(t - Math.round(t / periodSec) * periodSec) * 1000);
}

describe('detectBeats (pure)', () => {
  it('finds 120 BPM and a grid within 40 ms on a synthetic click track', () => {
    const result = detectBeats(clickTrack({ bpm: 120, seconds: 20 }), SAMPLE_RATE);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - 120)).toBeLessThanOrEqual(2);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.beatTimesSec.length).toBeGreaterThanOrEqual(36);
    const errors = gridErrorsMs(result.beatTimesSec, 0.5);
    const within = errors.filter((e) => e <= 40).length;
    expect(within / errors.length).toBeGreaterThanOrEqual(0.9);
    for (let i = 1; i < result.beatTimesSec.length; i++) expect(result.beatTimesSec[i]!).toBeGreaterThan(result.beatTimesSec[i - 1]!);
    expect(result.energyStepSec).toBe(BEAT_DETECTION.energyStepSec);
    expect(result.energy).toHaveLength(80);
    expect(Math.max(...result.energy)).toBe(1);
  });

  it('reports no tempo for silence or noise', () => {
    const silence = detectBeats(new Float32Array(SAMPLE_RATE * 20), SAMPLE_RATE);
    expect(silence).toMatchObject({ bpm: null, beatTimesSec: [], confidence: 0 });
    expect(silence.energy.every((e) => e === 0)).toBe(true);

    const noise = new Float32Array(SAMPLE_RATE * 20);
    const random = noiseSource(99);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.1 * random();
    const result = detectBeats(noise, SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.beatTimesSec).toEqual([]);
    expect(result.confidence).toBeLessThan(BEAT_DETECTION.minConfidence);
  });

  it('keeps a pulse that alternates between stereo channels', () => {
    const stereo = clickTrack({ bpm: 120, seconds: 20, channels: 2 });
    const result = detectBeats(stereo, SAMPLE_RATE, { channels: 2 });
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - 120)).toBeLessThanOrEqual(2);
    const errors = gridErrorsMs(result.beatTimesSec, 0.5);
    expect(errors.filter((e) => e <= 40).length / errors.length).toBeGreaterThanOrEqual(0.9);
  });

  it('folds very fast click trains to half time and keeps slow ones that have nothing in between', () => {
    const fast = detectBeats(clickTrack({ bpm: 200, seconds: 20 }), SAMPLE_RATE);
    expect(fast.bpm).not.toBeNull();
    expect(Math.abs(fast.bpm! - 100)).toBeLessThanOrEqual(2);
    const slow = detectBeats(clickTrack({ bpm: 60, seconds: 24 }), SAMPLE_RATE);
    expect(slow.bpm).not.toBeNull();
    expect(Math.abs(slow.bpm! - 60)).toBeLessThanOrEqual(2);
  });

  it('handles clips too short to analyse', () => {
    const result = detectBeats(new Float32Array(SAMPLE_RATE), SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.energy).toHaveLength(4);
  });
});

const ffmpegAvailable = await hasFfmpeg();
if (!ffmpegAvailable) console.warn('ffmpeg/ffprobe not found on PATH: skipping the music analysis test that needs them.');

describe.skipIf(!ffmpegAvailable)('analyseMusic with FFmpeg', () => {
  beforeAll(ensureSamples, 300_000);

  it('finds 120 BPM in the sample click track', async () => {
    const probe = await probeMedia(MUSIC_SAMPLE);
    const result = await analyseMusic(MUSIC_SAMPLE, { probe });
    expect(result.durationSec).toBeCloseTo(40, 0);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - 120)).toBeLessThanOrEqual(3);
    expect(result.confidence).toBeGreaterThanOrEqual(BEAT_DETECTION.minConfidence);
    expect(result.beatTimesSec.length).toBeGreaterThanOrEqual(70);
    const errors = gridErrorsMs(result.beatTimesSec, 0.5);
    expect(errors.filter((e) => e <= 40).length / errors.length).toBeGreaterThanOrEqual(0.9);
    // The decoded audio can be a few milliseconds shorter than the container duration.
    expect(result.energy.length).toBeGreaterThanOrEqual(Math.floor(result.durationSec / result.energyStepSec) - 1);
    expect(result.energy.length).toBeLessThanOrEqual(Math.ceil(result.durationSec / result.energyStepSec) + 1);
  }, 60_000);
});
