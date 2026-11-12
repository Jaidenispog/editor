import { describe, expect, it } from 'vitest';
import type { AssetAnalysis } from '@studio/core';
import { applyManualLabels } from '../src/lib/analysis-merge.js';

const base: AssetAnalysis = {
  version: 1,
  assetId: 'a',
  probe: { container: 'mov', durationSec: 5, fileSizeBytes: 1, video: null, audio: null },
  shots: [
    { id: 's1', assetId: 'a', startSec: 0, endSec: 2, quality: { sharpness: 0.5, brightness: 0.5, motion: 0.1, contrast: 0.5, exposureIssue: 'none', score: 0.6 }, label: 'unknown', labelSource: 'heuristic', confidence: 0, description: '', framing: 'unknown', focus: null, issues: [] },
    { id: 's2', assetId: 'a', startSec: 2, endSec: 5, quality: { sharpness: 0.5, brightness: 0.5, motion: 0.1, contrast: 0.5, exposureIssue: 'none', score: 0.6 }, label: 'cutting', labelSource: 'vision_model', confidence: 0.8, description: '', framing: 'unknown', focus: null, issues: [] },
  ],
  sampledFrames: [],
  audio: { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 1, speechLikely: false, speechConfidence: 0 },
  transcript: null,
  labelling: { source: 'heuristic', model: null, note: '' },
  completedAt: '2026-01-01T00:00:00.000Z',
};

describe('applyManualLabels', () => {
  it('applies per-shot tags over clip tags over model labels', () => {
    const out = applyManualLabels(base, { clipLabel: 'result', manualLabels: { s1: 'before', bogus: 'nope' } });
    expect(out.shots[0]).toMatchObject({ label: 'before', labelSource: 'manual', confidence: 1 });
    expect(out.shots[1]).toMatchObject({ label: 'result', labelSource: 'manual' });
  });
  it('ignores invalid labels and leaves model labels alone', () => {
    const out = applyManualLabels(base, { clipLabel: 'not-a-label', manualLabels: {} });
    expect(out.shots[1]?.label).toBe('cutting');
    expect(out.shots[1]?.labelSource).toBe('vision_model');
  });
});
