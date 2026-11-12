import { describe, expect, it } from 'vitest';
import { evaluateStyleSupport } from '../src/style-support.js';
import type { AssetAnalysis, Shot } from '../src/analysis.js';

function shot(id: string, label: Shot['label'], start = 0, end = 3, source: Shot['labelSource'] = 'vision_model'): Shot {
  return {
    id,
    assetId: 'a1',
    startSec: start,
    endSec: end,
    quality: { sharpness: 0.7, brightness: 0.5, motion: 0.3, contrast: 0.5, exposureIssue: 'none', score: 0.8 },
    label,
    labelSource: source,
    confidence: 0.9,
    description: '',
    framing: 'unknown',
    focus: null,
    issues: [],
  };
}

function analysis(shots: Shot[]): AssetAnalysis {
  return {
    version: 1,
    assetId: 'a1',
    probe: {
      container: 'mov',
      durationSec: 30,
      fileSizeBytes: 1000,
      video: { codec: 'h264', codedWidth: 1080, codedHeight: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' }, isHdr: false, hdrFormat: null, bitrate: null },
      audio: null,
    },
    shots,
    sampledFrames: [],
    audio: { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 1, speechLikely: false, speechConfidence: 0 },
    transcript: null,
    labelling: { source: 'vision_model', model: 'test', note: '' },
    completedAt: new Date().toISOString(),
  };
}

describe('evaluateStyleSupport', () => {
  it('only offers before/after when both shots exist', () => {
    const noBefore = evaluateStyleSupport([analysis([shot('1', 'cutting'), shot('2', 'fade_detail', 3, 6), shot('3', 'result', 6, 9), shot('4', 'cutting', 9, 12)])]);
    const ba = noBefore.find((s) => s.styleId === 'before_after')!;
    expect(ba.supported).toBe(false);
    expect(ba.reason).toMatch(/before/);
    expect(noBefore.find((s) => s.styleId === 'cinematic_reveal')!.supported).toBe(true);
    expect(noBefore.find((s) => s.styleId === 'beat_montage')!.supported).toBe(true);

    const withBefore = evaluateStyleSupport([analysis([shot('0', 'before', 0, 2, 'manual'), shot('1', 'cutting', 2, 5), shot('3', 'result', 6, 9)])]);
    expect(withBefore.find((s) => s.styleId === 'before_after')!.supported).toBe(true);
  });
  it('explains unlabelled footage', () => {
    const res = evaluateStyleSupport([analysis([shot('1', 'unknown', 0, 3, 'heuristic'), shot('2', 'unknown', 3, 6, 'heuristic'), shot('3', 'unknown', 6, 9, 'heuristic'), shot('4', 'unknown', 9, 12, 'heuristic')])]);
    expect(res.find((s) => s.styleId === 'beat_montage')!.supported).toBe(true);
    const reveal = res.find((s) => s.styleId === 'cinematic_reveal')!;
    expect(reveal.supported).toBe(false);
    expect(reveal.reason).toMatch(/Tag your clips/);
  });
});
