import { DEFAULT_SETTINGS, type AssetAnalysis, type PlanAssetInfo, type SegmentLabel, type Shot, type TranscriptSegment } from '@studio/core';
import type { PlannerInput } from '../src/types.js';

/** [startSec, endSec, label, score?] */
export type ShotSpec = [number, number, SegmentLabel, number?];

/** Builds one shot record the way the media package and the owner's tags would. */
export function makeShot(assetId: string, index: number, [startSec, endSec, label, score = 0.9]: ShotSpec): Shot {
  return {
    id: `${assetId.slice(0, 8)}-s${index}`,
    assetId,
    startSec,
    endSec,
    quality: { sharpness: 0.8, brightness: 0.5, motion: 0.2, contrast: 0.4, exposureIssue: 'none', score },
    label,
    labelSource: label === 'unknown' ? 'heuristic' : 'manual',
    confidence: label === 'unknown' ? 0 : 1,
    description: '',
    framing: 'unknown',
    focus: null,
    issues: [],
  };
}

/** Builds a complete AssetAnalysis for a synthetic clip. */
export function makeAnalysis(
  assetId: string,
  durationSec: number,
  shots: ShotSpec[],
  opts: { hasAudio?: boolean; transcript?: TranscriptSegment[] } = {},
): AssetAnalysis {
  const hasAudio = opts.hasAudio ?? true;
  return {
    version: 1,
    assetId,
    probe: {
      container: 'mov,mp4',
      durationSec,
      fileSizeBytes: 1_000_000,
      video: {
        codec: 'h264',
        codedWidth: 1080,
        codedHeight: 1920,
        displayWidth: 1080,
        displayHeight: 1920,
        rotation: 0,
        fps: 30,
        pixelFormat: 'yuv420p',
        bitDepth: 8,
        colour: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
        isHdr: false,
        hdrFormat: null,
        bitrate: 8_000_000,
      },
      audio: hasAudio ? { codec: 'aac', sampleRate: 48000, channels: 1, bitrate: 128000 } : null,
    },
    shots: shots.map((s, i) => makeShot(assetId, i, s)),
    sampledFrames: [],
    audio: { hasAudio, integratedLoudnessLufs: hasAudio ? -20 : null, silenceRatio: 0, speechLikely: Boolean(opts.transcript), speechConfidence: opts.transcript ? 0.8 : 0 },
    transcript: opts.transcript ? { provider: 'openai', language: 'english', segments: opts.transcript } : null,
    labelling: { source: 'manual', model: null, note: '' },
    completedAt: '2026-11-14T00:00:00.000Z',
  };
}

export function assetsFor(analyses: AssetAnalysis[]): PlanAssetInfo[] {
  return analyses.map((a) => ({ id: a.assetId, durationSec: a.probe.durationSec, hasAudio: a.probe.audio !== null }));
}

export const ASSET_A = 'aaaaaaaa-0000-7000-8000-000000000001';
export const ASSET_B = 'bbbbbbbb-0000-7000-8000-000000000002';
export const ASSET_C = 'cccccccc-0000-7000-8000-000000000003';

/** The client's spoken lines in clip B (used to check captions are copied verbatim). */
export const TRANSCRIPT_B: TranscriptSegment[] = [
  { startSec: 0.4, endSec: 2.6, text: 'Keep the top long, just tidy it up.' },
  { startSec: 5.2, endSec: 7.4, text: 'Yeah, take the sides right down.' },
  { startSec: 10.1, endSec: 11.8, text: 'That looks mint, mate.' },
];

/** A labelled synthetic project: per-shot tags covering every role, speech on clip B. */
export function labelledProject(withTranscript = true): AssetAnalysis[] {
  return [
    makeAnalysis(ASSET_A, 20, [
      [0, 3, 'before', 0.85],
      [3, 8, 'cutting', 0.9],
      [8, 12, 'cutting', 0.8],
      [12, 16, 'fade_detail', 0.95],
      [16, 18, 'styling', 0.7],
      [18, 20, 'result', 0.9],
    ]),
    makeAnalysis(
      ASSET_B,
      15,
      [
        [0, 4, 'cutting', 0.75],
        [4, 8, 'fade_detail', 0.85],
        [8, 12, 'result', 0.95],
        [12, 15, 'reaction', 0.8],
      ],
      withTranscript ? { transcript: TRANSCRIPT_B } : {},
    ),
    makeAnalysis(
      ASSET_C,
      10,
      [
        [0, 4, 'environment', 0.6],
        [4, 7, 'styling', 0.8],
        [7, 10, 'result', 0.88],
      ],
      { hasAudio: false },
    ),
  ];
}

/** The worker integration test's footage: three clips with clip-level tags (every shot in a clip shares one label). */
export function clipTaggedProject(): AssetAnalysis[] {
  return [
    makeAnalysis(ASSET_A, 12, [
      [0, 4.003, 'cutting', 0.955],
      [4.003, 8.007, 'cutting', 0.955],
      [8.007, 12.01, 'cutting', 0.955],
    ]),
    makeAnalysis(ASSET_B, 10, [
      [0, 3.335, 'before', 1],
      [3.335, 6.67, 'before', 1],
      [6.67, 10.005, 'before', 1],
    ]),
    makeAnalysis(
      ASSET_C,
      6,
      [
        [0, 2, 'result', 0.847],
        [2, 4, 'result', 0.955],
        [4, 6, 'result', 0.908],
      ],
      { hasAudio: false },
    ),
  ];
}

/** Same three clips with no tags at all. */
export function untaggedProject(): AssetAnalysis[] {
  return clipTaggedProject().map((a) => ({ ...a, shots: a.shots.map((s) => ({ ...s, label: 'unknown' as const, labelSource: 'heuristic' as const, confidence: 0 })) }));
}

/** A complete planner input with the app's default settings. */
export function plannerInput(analyses: AssetAnalysis[], overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    styleId: 'beat_montage',
    targetDurationSec: 20,
    analyses,
    assets: assetsFor(analyses),
    music: null,
    preferences: DEFAULT_SETTINGS.preferences,
    brand: { ...DEFAULT_SETTINGS.brand, businessName: 'Ivanhoe Barber Co' },
    businessName: 'Ivanhoe Barber Co',
    instructions: '',
    keepOriginalSound: 'auto',
    captions: 'auto',
    attempt: 0,
    ...overrides,
  };
}

/** A 40-second 120 BPM track (beat every 0.5 s), like scripts/make-sample-footage.sh produces. */
export function clickTrack(durationSec = 40): NonNullable<PlannerInput['music']> {
  const beats: number[] = [];
  for (let t = 0.05; t < durationSec; t += 0.5) beats.push(Math.round(t * 1000) / 1000);
  return { trackId: 'track-1', durationSec, bpm: 120, beatTimesSec: beats, title: 'Click track 120' };
}
