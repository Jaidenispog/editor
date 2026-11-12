import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AssetProbe } from '@studio/core';
import { ensureSamples, hasFfmpeg, noiseSource, SAMPLE_FILES, samplePath as sample } from './analysis-fixtures.js';
import { FfmpegError } from '../src/ffmpeg.js';
import { probeMedia } from '../src/ffprobe.js';
import { analyseAudio, decodePcm, parseIntegratedLoudness, parseSilenceSeconds, SPEECH_HEURISTIC, speechStats } from '../src/analysis/index.js';

/** A crude vowel-like signal: harmonics of a wandering 140 Hz fundamental, formant-shaped, in 4 Hz syllables. */
function syntheticSpeech(seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let phase = 0;
  const random = noiseSource(12345);
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / sampleRate;
    let v = 0;
    for (let h = 1; h <= 24; h++) {
      const fh = h * f0;
      const formant = Math.exp(-0.5 * ((fh - 600) / 250) ** 2) + 0.7 * Math.exp(-0.5 * ((fh - 1600) / 350) ** 2) + 0.3 * Math.exp(-0.5 * ((fh - 2600) / 400) ** 2);
      v += (formant / h ** 0.3) * Math.sin(h * phase);
    }
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
    out[i] = 0.3 * v * syllable + 0.002 * random();
  }
  return out;
}

const ffmpegAvailable = await hasFfmpeg();
if (!ffmpegAvailable) console.warn('ffmpeg/ffprobe not found on PATH: skipping the audio analysis tests that need them.');

describe.skipIf(!ffmpegAvailable)('audio analysis with FFmpeg', () => {
  let workDir: string;
  const probes: Record<string, AssetProbe> = {};

  beforeAll(async () => {
    await ensureSamples();
    workDir = await mkdtemp(path.join(os.tmpdir(), 'sa-audio-'));
    for (const name of SAMPLE_FILES) probes[name] = await probeMedia(sample(name));
  }, 300_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('reports no audio for a silent-container clip', async () => {
    const result = await analyseAudio(sample('sample_c_noaudio_scenes.mp4'), { probe: probes['sample_c_noaudio_scenes.mp4']! });
    expect(result).toEqual({ hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 0, speechLikely: false, speechConfidence: 0 });
  });

  it('measures loudness of the tone clip and does not mistake the tone for speech', async () => {
    const result = await analyseAudio(sample('sample_a_portrait_sdr.mp4'), { probe: probes['sample_a_portrait_sdr.mp4']! });
    expect(result.hasAudio).toBe(true);
    expect(Number.isFinite(result.integratedLoudnessLufs)).toBe(true);
    expect(result.integratedLoudnessLufs!).toBeGreaterThan(-40);
    expect(result.integratedLoudnessLufs!).toBeLessThan(-5);
    expect(result.silenceRatio).toBeLessThan(0.05);
    expect(result.speechLikely).toBe(false);
    expect(result.speechConfidence).toBeLessThan(SPEECH_HEURISTIC.likelyConfidence);
  }, 30_000);

  it('does not mistake pink noise for speech', async () => {
    const result = await analyseAudio(sample('sample_b_rotated_hevc_hlg.mov'), { probe: probes['sample_b_rotated_hevc_hlg.mov']! });
    expect(result.hasAudio).toBe(true);
    expect(result.speechLikely).toBe(false);
    expect(Number.isFinite(result.integratedLoudnessLufs)).toBe(true);
  }, 30_000);

  it('measures the silent share of a clip that ends in silence', async () => {
    const wav = path.join(workDir, 'tone_then_silence.wav');
    await execa('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]',
      '-c:a', 'pcm_s16le', wav,
    ]);
    const probe = await probeMedia(wav);
    const result = await analyseAudio(wav, { probe });
    expect(result.hasAudio).toBe(true);
    expect(result.silenceRatio).toBeGreaterThan(0.5);
    expect(result.silenceRatio).toBeLessThan(0.7);
    expect(result.speechLikely).toBe(false);
  }, 30_000);

  it('decodes mono and stereo PCM at the requested rate', async () => {
    const mono = await decodePcm(sample('sample_a_portrait_sdr.mp4'), { sampleRate: 16000 });
    const expected = probes['sample_a_portrait_sdr.mp4']!.durationSec * 16000;
    expect(Math.abs(mono.length - expected)).toBeLessThan(expected * 0.02);
    expect(mono.some((v) => Math.abs(v) > 0.05)).toBe(true);
    expect(mono.every((v) => Math.abs(v) <= 1.0001)).toBe(true);
    const stereo = await decodePcm(sample('sample_music_120bpm.mp3'), { sampleRate: 8000, channels: 2 });
    const stereoFrames = stereo.length / 2;
    const expectedFrames = probes['sample_music_120bpm.mp3']!.durationSec * 8000;
    expect(Math.abs(stereoFrames - expectedFrames)).toBeLessThan(expectedFrames * 0.02);
    await expect(decodePcm(sample('sample_c_noaudio_scenes.mp4'))).rejects.toBeInstanceOf(FfmpegError);
  }, 30_000);
});

describe('speech heuristic (pure)', () => {
  it('finds speech-like audio in a syllabic harmonic signal', () => {
    const stats = speechStats(syntheticSpeech(6, SPEECH_HEURISTIC.sampleRate), SPEECH_HEURISTIC.sampleRate);
    expect(stats.speechConfidence).toBeGreaterThanOrEqual(0.5);
    expect(stats.speechSeconds).toBeGreaterThanOrEqual(1.5);
    expect(stats.activeSeconds).toBeGreaterThan(stats.speechSeconds * 0.9);
  });

  it('rejects a steady tone and silence', () => {
    const sr = SPEECH_HEURISTIC.sampleRate;
    const tone = new Float32Array(sr * 4);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
    expect(speechStats(tone, sr).speechConfidence).toBe(0);
    expect(speechStats(new Float32Array(sr * 4), sr)).toEqual({ speechConfidence: 0, speechSeconds: 0, activeSeconds: 0 });
    expect(speechStats(new Float32Array(10), sr).speechConfidence).toBe(0);
  });
});

describe('FFmpeg output parsing (pure)', () => {
  it('sums silence runs, including one still open at the end', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 1.5',
      '[silencedetect @ 0x1] silence_end: 3.25 | silence_duration: 1.75',
      '[silencedetect @ 0x1] silence_start: 8',
    ].join('\n');
    expect(parseSilenceSeconds(stderr, 10)).toBeCloseTo(3.75, 6);
    expect(parseSilenceSeconds('', 10)).toBe(0);
  });

  it('reads the integrated loudness from the ebur128 summary', () => {
    const stderr = '[Parsed_ebur128_1 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -21.8 LUFS\n    Threshold: -31.8 LUFS\n';
    expect(parseIntegratedLoudness(stderr)).toBe(-21.8);
    expect(parseIntegratedLoudness('  I:   -inf LUFS')).toBeNull();
    expect(parseIntegratedLoudness('no summary here')).toBeNull();
  });
});
