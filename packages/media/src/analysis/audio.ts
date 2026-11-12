import type { AssetProbe, AudioAnalysis } from '@studio/core';
import { runFfmpegCapture, runFfmpegToBuffer } from '../ffmpeg.js';
import { throwIfAborted, type AnalysisToolOptions } from './common.js';
import { movingAverage, percentile, rmsOf, SpectrumAnalyser, zeroCrossingRate } from './dsp.js';

export interface DecodePcmOptions extends AnalysisToolOptions {
  /** Output sample rate; default 22050 Hz. */
  sampleRate?: number;
}

/**
 * Decodes the first audio stream to mono 32-bit float PCM at `sampleRate` (via an FFmpeg pipe).
 * Returns an empty array for a file without audio.
 */
export async function decodePcm(inputPath: string, options: DecodePcmOptions = {}): Promise<Float32Array> {
  const sampleRate = Math.round(options.sampleRate ?? 22050);
  if (!(sampleRate > 0)) throw new Error('decodePcm: sampleRate must be positive');
  throwIfAborted(options.signal, 'Audio decode');
  const buffer = await runFfmpegToBuffer(
    ['-i', inputPath, '-map', '0:a:0?', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    {
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  // Copy into a fresh, 4-byte aligned ArrayBuffer: Node buffers can be unaligned slices of a pool.
  const usable = buffer.length - (buffer.length % 4);
  const aligned = new ArrayBuffer(usable);
  new Uint8Array(aligned).set(buffer.subarray(0, usable));
  const pcm = new Float32Array(aligned);
  if (!isLittleEndian()) {
    const view = new DataView(aligned);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * 4, true);
  }
  return pcm;
}

function isLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}

export interface AnalyseAudioOptions extends AnalysisToolOptions {
  probe: AssetProbe;
}

/** Silence detection parameters (FFmpeg silencedetect). */
export const SILENCE_DETECTION = { noiseDb: -35, minDurationSec: 0.5 } as const;

/**
 * Parameters of the speech heuristic. It is a heuristic, not a classifier: it looks for frames that are
 * clearly above the clip's own noise floor, have a zero-crossing rate typical of voiced/unvoiced speech,
 * concentrate their energy in the 300–3400 Hz telephone band and sit inside a syllable-like loudness
 * swing. Steady tones, hums and broadband noise fail at least one of those tests; music can pass, which
 * only means transcription will be attempted (and may return nothing).
 */
export const SPEECH_HEURISTIC = {
  sampleRate: 16000,
  frameSec: 0.025,
  hopSec: 0.01,
  /** Frames louder than this many dB above the adaptive noise floor count as active. */
  activeAboveFloorDb: 10,
  /** Absolute RMS floor (dBFS) below which nothing counts as active. */
  minActiveDb: -60,
  /** Percentile of frame loudness used as the adaptive noise floor. */
  noiseFloorPercentile: 15,
  zcrMin: 0.02,
  zcrMax: 0.3,
  bandLowHz: 300,
  bandHighHz: 3400,
  /** Minimum share of the frame's energy that must sit in the speech band. */
  bandRatioMin: 0.55,
  /** Loudness swing (dB) required within ±modulationWindowSec for the frame to look syllabic. */
  modulationRangeDb: 8,
  modulationWindowSec: 0.4,
  /** speechLikely needs this confidence and this much speech-like audio. */
  likelyConfidence: 0.35,
  likelyMinSeconds: 1.5,
} as const;

export interface SpeechStats {
  /** Share of active (non-silent) frames that look like speech, 0–1. */
  speechConfidence: number;
  speechSeconds: number;
  activeSeconds: number;
}

/** Runs the speech heuristic (see SPEECH_HEURISTIC) over mono PCM; pure and synchronous. */
export function speechStats(pcm: Float32Array, sampleRate: number): SpeechStats {
  const h = SPEECH_HEURISTIC;
  const frameLen = Math.round(h.frameSec * sampleRate);
  const hop = Math.round(h.hopSec * sampleRate);
  const frameCount = pcm.length >= frameLen ? Math.floor((pcm.length - frameLen) / hop) + 1 : 0;
  if (frameCount < 10) return { speechConfidence: 0, speechSeconds: 0, activeSeconds: 0 };

  const analyser = new SpectrumAnalyser(frameLen);
  const spectrum = new Float64Array(analyser.bins);
  const binHz = sampleRate / analyser.fftSize;
  const bandLo = Math.max(1, Math.floor(h.bandLowHz / binHz));
  const bandHi = Math.min(analyser.bins - 1, Math.ceil(h.bandHighHz / binHz));

  const loudnessDb = new Float64Array(frameCount);
  const zcr = new Float64Array(frameCount);
  const bandRatio = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const offset = f * hop;
    loudnessDb[f] = 20 * Math.log10(rmsOf(pcm, offset, offset + frameLen) + 1e-9);
    zcr[f] = zeroCrossingRate(pcm, offset, offset + frameLen);
    analyser.magnitudes(pcm, offset, spectrum);
    let total = 0;
    let band = 0;
    for (let k = 1; k < analyser.bins; k++) {
      const p = spectrum[k]! * spectrum[k]!;
      total += p;
      if (k >= bandLo && k <= bandHi) band += p;
    }
    bandRatio[f] = total > 0 ? band / total : 0;
  }

  const noiseFloorDb = percentile(loudnessDb, h.noiseFloorPercentile);
  const activeDb = Math.max(noiseFloorDb + h.activeAboveFloorDb, h.minActiveDb);
  const smoothedDb = movingAverage(loudnessDb, 1);
  const radius = Math.round(h.modulationWindowSec / h.hopSec);

  let active = 0;
  let speechLike = 0;
  for (let f = 0; f < frameCount; f++) {
    if (loudnessDb[f]! < activeDb) continue;
    active++;
    if (zcr[f]! < h.zcrMin || zcr[f]! > h.zcrMax) continue;
    if (bandRatio[f]! < h.bandRatioMin) continue;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let g = Math.max(0, f - radius); g <= Math.min(frameCount - 1, f + radius); g++) {
      const v = Math.max(smoothedDb[g]!, h.minActiveDb - 20);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < h.modulationRangeDb) continue;
    speechLike++;
  }
  const secondsPerFrame = hop / sampleRate;
  return {
    speechConfidence: active > 0 ? Math.round((speechLike / active) * 1000) / 1000 : 0,
    speechSeconds: speechLike * secondsPerFrame,
    activeSeconds: active * secondsPerFrame,
  };
}

/** Parses FFmpeg silencedetect output into the total silent seconds (open-ended silence runs to `durationSec`). */
export function parseSilenceSeconds(stderr: string, durationSec: number): number {
  let total = 0;
  let openStart: number | null = null;
  const pattern = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  for (const match of stderr.matchAll(pattern)) {
    const kind = match[1];
    const t = Number(match[2]);
    if (!Number.isFinite(t)) continue;
    if (kind === 'start') {
      openStart = t;
    } else if (openStart !== null) {
      total += Math.max(0, t - openStart);
      openStart = null;
    }
  }
  if (openStart !== null && durationSec > openStart) total += durationSec - openStart;
  return total;
}

/** Parses the integrated loudness ("I: -21.8 LUFS") from an ebur128 summary; null when absent or silent. */
export function parseIntegratedLoudness(stderr: string): number | null {
  const match = /^\s*I:\s*(-?\d+(?:\.\d+)?|-inf)\s*LUFS/m.exec(stderr);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Measures the soundtrack of a clip: silence ratio (silencedetect −35 dB / 0.5 s), integrated loudness
 * (EBU R128) and the speech heuristic described on SPEECH_HEURISTIC. A file without audio returns
 * hasAudio=false with zeros.
 */
export async function analyseAudio(inputPath: string, options: AnalyseAudioOptions): Promise<AudioAnalysis> {
  const { probe, signal } = options;
  throwIfAborted(signal, 'Audio analysis');
  if (!probe.audio) {
    return { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 0, speechLikely: false, speechConfidence: 0 };
  }
  const tool = {
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(signal ? { signal } : {}),
  };
  const [{ stderr }, pcm] = await Promise.all([
    runFfmpegCapture(
      [
        '-i', inputPath,
        '-map', '0:a:0',
        '-vn',
        '-af', `silencedetect=n=${SILENCE_DETECTION.noiseDb}dB:d=${SILENCE_DETECTION.minDurationSec},ebur128=framelog=quiet`,
        '-f', 'null',
        '-',
      ],
      { ...tool, loglevel: 'info' },
    ),
    decodePcm(inputPath, { ...tool, sampleRate: SPEECH_HEURISTIC.sampleRate }),
  ]);
  throwIfAborted(signal, 'Audio analysis');

  const durationSec = probe.durationSec > 0 ? probe.durationSec : pcm.length / SPEECH_HEURISTIC.sampleRate;
  const silenceSeconds = parseSilenceSeconds(stderr, durationSec);
  const silenceRatio = durationSec > 0 ? Math.min(1, Math.max(0, silenceSeconds / durationSec)) : 0;
  const speech = speechStats(pcm, SPEECH_HEURISTIC.sampleRate);
  return {
    hasAudio: true,
    integratedLoudnessLufs: parseIntegratedLoudness(stderr),
    silenceRatio: Math.round(silenceRatio * 1000) / 1000,
    speechLikely: speech.speechConfidence >= SPEECH_HEURISTIC.likelyConfidence && speech.speechSeconds >= SPEECH_HEURISTIC.likelyMinSeconds,
    speechConfidence: speech.speechConfidence,
  };
}
