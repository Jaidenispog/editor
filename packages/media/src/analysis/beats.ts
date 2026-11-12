import type { AssetProbe } from '@studio/core';
import { decodePcm } from './audio.js';
import { throwIfAborted, type AnalysisToolOptions } from './common.js';
import { movingAverage, percentile, refinePeak, regressionSlope, rmsOf, sampleAt, SpectrumAnalyser } from './dsp.js';

export interface BeatAnalysis {
  /** Estimated tempo, or null when the audio has no convincing pulse (silence, noise, free rhythm). */
  bpm: number | null;
  /** Beat times in seconds from the start of the audio; empty when bpm is null. */
  beatTimesSec: number[];
  /** RMS loudness per `energyStepSec` window, normalised so the loudest window is 1. */
  energy: number[];
  energyStepSec: number;
  /** 0–1 prominence of the tempo peak in the onset autocorrelation. */
  confidence: number;
}

export interface DetectBeatsOptions {
  /** Number of interleaved channels in `pcm`; default 1. Onsets are measured per channel and summed. */
  channels?: number;
}

/** Tunables of the beat tracker (documented so the numbers in the tests make sense). */
export const BEAT_DETECTION = {
  frameLength: 1024,
  hop: 512,
  minBpm: 60,
  maxBpm: 180,
  /** Octave ambiguities are folded into this range when the autocorrelation supports it. */
  foldLowBpm: 80,
  foldHighBpm: 160,
  /** Autocorrelation at the folded lag must be at least this share of the raw peak to fold. */
  foldSupportRatio: 0.5,
  /** Centre and width (octaves) of the gentle log-normal tempo prior that breaks ties between octaves. */
  priorCentreBpm: 120,
  priorWidthOctaves: 1,
  energyStepSec: 0.25,
  /** Beats are moved onto an onset peak at most this far away. */
  snapToleranceSec: 0.04,
  /** An onset must reach this share of the envelope maximum to attract a beat. */
  snapMinStrength: 0.1,
  /** Below this confidence the result reports no tempo. */
  minConfidence: 0.2,
  /** Length of the moving average removed from the onset strength before analysis. */
  detrendSec: 0.4,
  /** log(1 + magnitude × this) compresses the spectrum before the flux is taken. */
  logCompression: 50,
  /**
   * Spectral flux peaks in the first frame that contains most of an onset, so the onset sits about
   * 1.2 hops after that frame's start (calibrated on synthetic clicks: mean error under 2 ms).
   */
  onsetOffsetHops: 1.2,
} as const;

const EMPTY: Omit<BeatAnalysis, 'energy' | 'energyStepSec'> = { bpm: null, beatTimesSec: [], confidence: 0 };

/**
 * Finds the tempo and beat grid of PCM audio: spectral-flux onset strength (1024/512 frames, log-magnitude,
 * half-wave rectified, summed over channels), tempo from the autocorrelation of the onset envelope over
 * 60–180 BPM with a gentle prior around 120 BPM and octave ambiguities folded towards 80–160 BPM, phase
 * from the best comb alignment, a beat grid that settles on nearby onsets (±40 ms) so slow drift is
 * followed, and an RMS energy curve per 0.25 s. Silence or noise yields bpm null, an empty grid and a
 * low confidence.
 */
export function detectBeats(pcm: Float32Array, sampleRate: number, options: DetectBeatsOptions = {}): BeatAnalysis {
  const c = BEAT_DETECTION;
  if (!(sampleRate > 0)) throw new Error('detectBeats: sampleRate must be positive');
  const channelCount = Math.max(1, Math.floor(options.channels ?? 1));
  const channels = splitChannels(pcm, channelCount);
  const mono = channelCount === 1 ? pcm : mixDown(channels);
  const energy = energyCurve(mono, sampleRate, c.energyStepSec);
  const base = { energy, energyStepSec: c.energyStepSec };

  const flux = onsetStrength(channels);
  const fps = sampleRate / c.hop;
  const frameCount = flux.length;
  if (frameCount < Math.ceil(fps * 2)) return { ...EMPTY, ...base };

  // Detrend and half-wave rectify, then normalise so the strongest onset is 1.
  const trend = movingAverage(flux, Math.max(1, Math.round((c.detrendSec * fps) / 2)));
  const envelope = new Float64Array(frameCount);
  let envelopeMax = 0;
  for (let i = 0; i < frameCount; i++) {
    const v = Math.max(0, flux[i]! - trend[i]!);
    envelope[i] = v;
    if (v > envelopeMax) envelopeMax = v;
  }
  if (envelopeMax <= 0) return { ...EMPTY, ...base };
  for (let i = 0; i < frameCount; i++) envelope[i] = envelope[i]! / envelopeMax;

  // Autocorrelation of the (lightly smoothed, mean-removed) envelope over the tempo range.
  const smooth = movingAverage(envelope, 1);
  let mean = 0;
  for (let i = 0; i < frameCount; i++) mean += smooth[i]!;
  mean /= frameCount;
  const centred = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i++) centred[i] = smooth[i]! - mean;
  let acf0 = 0;
  for (let i = 0; i < frameCount; i++) acf0 += centred[i]! * centred[i]!;
  if (acf0 <= 0) return { ...EMPTY, ...base };

  const lagMin = Math.max(1, Math.floor((fps * 60) / c.maxBpm));
  const lagMax = Math.ceil((fps * 60) / c.minBpm);
  const lagLimit = Math.min(frameCount - 2, lagMax * 2 + 1);
  const lagTop = Math.min(lagMax, lagLimit);
  if (lagTop <= lagMin) return { ...EMPTY, ...base };
  const acf = new Float64Array(lagLimit + 1);
  for (let lag = 1; lag <= lagLimit; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < frameCount; i++) sum += centred[i]! * centred[i + lag]!;
    acf[lag] = sum / acf0;
  }

  // Pick the lag with the best prior-weighted autocorrelation; confidence comes from the raw values.
  let bestLag = lagMin;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let lag = lagMin; lag <= lagTop; lag++) {
    const score = acf[lag]! * tempoPrior((60 * fps) / lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const peak = acf[bestLag]!;
  const median = percentile(acf.subarray(lagMin, lagTop + 1), 50);
  const confidence = Math.round(Math.min(1, Math.max(0, peak - median)) * 1000) / 1000;
  if (confidence < c.minConfidence) return { ...EMPTY, ...base, confidence };

  // Fold octave ambiguities towards the comfortable editing range when the other octave is also periodic.
  let lag = refinePeak(acf, bestLag);
  const rawBpm = (60 * fps) / lag;
  if (rawBpm < c.foldLowBpm) {
    const half = lag / 2;
    if (half >= 1 && sampleAt(acf, half) >= c.foldSupportRatio * peak) lag = refinePeak(acf, Math.round(half));
  } else if (rawBpm > c.foldHighBpm) {
    const double = lag * 2;
    if (double <= lagLimit && sampleAt(acf, double) >= c.foldSupportRatio * peak) lag = refinePeak(acf, Math.round(double));
  }
  const period = lag;

  // Phase: the comb offset that collects the most onset strength.
  let bestPhase = 0;
  let bestPhaseScore = Number.NEGATIVE_INFINITY;
  for (let phase = 0; phase < period; phase += 0.05) {
    let score = 0;
    for (let p = phase; p < frameCount; p += period) score += sampleAt(envelope, p);
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  // Walk the grid, letting each beat settle on a nearby onset so slow drift is followed.
  const tolerance = c.snapToleranceSec * fps;
  const positions: number[] = [];
  const snappedIndex: number[] = [];
  const snappedPosition: number[] = [];
  let predicted = bestPhase;
  while (predicted <= frameCount - 1) {
    const snapped = snapToOnset(envelope, predicted, tolerance, c.snapMinStrength);
    const position = snapped ?? predicted;
    if (snapped !== null) {
      snappedIndex.push(positions.length);
      snappedPosition.push(snapped);
    }
    positions.push(position);
    predicted = position + period;
  }

  let refinedPeriod = period;
  if (snappedPosition.length >= 4) {
    const slope = regressionSlope(snappedIndex, snappedPosition);
    if (slope > 0 && Math.abs(slope - period) < period * 0.1) refinedPeriod = slope;
  }
  const bpm = Math.round(((60 * fps) / refinedPeriod) * 10) / 10;
  const beatTimesSec = positions.map((p) => Math.round((((p + c.onsetOffsetHops) * c.hop) / sampleRate) * 1000) / 1000);
  return { bpm, beatTimesSec, confidence, ...base };
}

/** Gentle log-normal weight favouring tempos near the prior centre (1 at the centre, ~0.6 one octave away). */
function tempoPrior(bpm: number): number {
  const { priorCentreBpm, priorWidthOctaves } = BEAT_DETECTION;
  const octaves = Math.log2(bpm / priorCentreBpm) / priorWidthOctaves;
  return Math.exp(-0.5 * octaves * octaves);
}

/** De-interleaves PCM into one array per channel (the input itself for mono). */
function splitChannels(pcm: Float32Array, channelCount: number): Float32Array[] {
  if (channelCount === 1) return [pcm];
  const frames = Math.floor(pcm.length / channelCount);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++) channels[ch]![i] = pcm[i * channelCount + ch]!;
  }
  return channels;
}

function mixDown(channels: Float32Array[]): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i]!;
    mono[i] = sum / channels.length;
  }
  return mono;
}

/** Spectral flux per frame, summed over channels: half-wave rectified increase of the log-magnitude spectrum. */
function onsetStrength(channels: Float32Array[]): Float64Array {
  const { frameLength, hop, logCompression } = BEAT_DETECTION;
  const length = channels[0]?.length ?? 0;
  const frameCount = length >= frameLength ? Math.floor((length - frameLength) / hop) + 1 : 0;
  const flux = new Float64Array(Math.max(0, frameCount));
  if (frameCount === 0) return flux;
  const analyser = new SpectrumAnalyser(frameLength, frameLength);
  const current = new Float64Array(analyser.bins);
  const previous = new Float64Array(analyser.bins);
  for (const channel of channels) {
    previous.fill(0);
    for (let f = 0; f < frameCount; f++) {
      analyser.magnitudes(channel, f * hop, current);
      let sum = 0;
      for (let k = 1; k < analyser.bins; k++) {
        const logMag = Math.log1p(current[k]! * logCompression);
        if (f > 0) sum += Math.max(0, logMag - previous[k]!);
        previous[k] = logMag;
      }
      if (f > 0) flux[f] = flux[f]! + sum;
    }
  }
  return flux;
}

/** RMS per window, normalised so the loudest window is 1 (all zeros for silence). */
function energyCurve(pcm: Float32Array, sampleRate: number, stepSec: number): number[] {
  const window = Math.max(1, Math.round(stepSec * sampleRate));
  const count = Math.ceil(pcm.length / window);
  const values: number[] = [];
  let max = 0;
  for (let i = 0; i < count; i++) {
    const v = rmsOf(pcm, i * window, (i + 1) * window);
    values.push(v);
    if (v > max) max = v;
  }
  return values.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
}

/** The strongest onset peak within ±tolerance frames of `position`, refined to sub-frame precision, or null. */
function snapToOnset(envelope: Float64Array, position: number, tolerance: number, minStrength: number): number | null {
  const lo = Math.max(1, Math.ceil(position - tolerance));
  const hi = Math.min(envelope.length - 2, Math.floor(position + tolerance));
  let best = -1;
  for (let i = lo; i <= hi; i++) {
    const v = envelope[i]!;
    if (v < minStrength) continue;
    if (v < envelope[i - 1]! || v < envelope[i + 1]!) continue;
    if (best < 0 || v > envelope[best]!) best = i;
  }
  if (best < 0) return null;
  const refined = refinePeak(envelope, best);
  return Math.abs(refined - position) <= tolerance ? refined : best;
}

export interface AnalyseMusicOptions extends AnalysisToolOptions {
  probe: AssetProbe;
}

export interface MusicAnalysis extends BeatAnalysis {
  durationSec: number;
}

/** Sample rate the music track is decoded at before beat detection. */
export const MUSIC_ANALYSIS_SAMPLE_RATE = 22050;

/**
 * Decodes a music file (stereo when the track is stereo, so hard-panned rhythm parts are not lost in a
 * downmix) and runs detectBeats, returning the track's beat grid and duration.
 */
export async function analyseMusic(inputPath: string, options: AnalyseMusicOptions): Promise<MusicAnalysis> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Music analysis');
  if (!probe.audio) throw new Error('Music analysis: the file has no audio');
  const channels: 1 | 2 = probe.audio.channels >= 2 ? 2 : 1;
  const pcm = await decodePcm(inputPath, {
    sampleRate: MUSIC_ANALYSIS_SAMPLE_RATE,
    channels,
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(signal ? { signal } : {}),
  });
  throwIfAborted(signal, 'Music analysis');
  const beats = detectBeats(pcm, MUSIC_ANALYSIS_SAMPLE_RATE, { channels });
  const frames = pcm.length / channels;
  const durationSec = probe.durationSec > 0 ? probe.durationSec : Math.round((frames / MUSIC_ANALYSIS_SAMPLE_RATE) * 1000) / 1000;
  return { durationSec, ...beats };
}
