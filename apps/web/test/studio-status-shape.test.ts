import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AssetAnalysis, type EditPlan, type MusicLicence } from '@studio/core';
import type { Edit, EditVersion, Generation, MediaAsset, MusicTrack, Project } from '@studio/db';
import { isStudioBusy, licenceSummary, shapeAssetShots, shapeMusicOption, shapeStudioStatus, shapeStyleOptions, type LinkSigner } from '../src/lib/studio-status-shape';

const t0 = new Date('2026-11-14T00:00:00Z');
const sign: LinkSigner = async (key) => `https://signed.example/${Buffer.from(key).toString('base64url')}`;

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    ownerId: 'u1',
    title: 'Skin fade',
    clientName: 'Jordan',
    notes: '',
    status: 'ready',
    lastSettings: null,
    styleSupport: [
      { styleId: 'beat_montage', supported: true, reason: '' },
      { styleId: 'before_after', supported: false, reason: 'Needs a "before" shot.' },
    ],
    deletedAt: null,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

function analysis(assetId: string): AssetAnalysis {
  const quality = { sharpness: 0.6, brightness: 0.5, motion: 0.2, contrast: 0.4, exposureIssue: 'none' as const, score: 0.7 };
  return {
    version: 1,
    assetId,
    probe: {
      container: 'mov',
      durationSec: 10,
      fileSizeBytes: 1000,
      video: {
        codec: 'hevc',
        codedWidth: 1920,
        codedHeight: 1080,
        displayWidth: 1080,
        displayHeight: 1920,
        rotation: 90,
        fps: 30,
        pixelFormat: 'yuv420p10le',
        bitDepth: 10,
        colour: { primaries: 'bt2020', transfer: 'arib-std-b67', matrix: 'bt2020nc', range: 'tv' },
        isHdr: true,
        hdrFormat: 'hlg',
        bitrate: null,
      },
      audio: { codec: 'aac', sampleRate: 48000, channels: 1, bitrate: null },
    },
    shots: [
      { id: 's1', assetId, startSec: 0, endSec: 4, quality, label: 'cutting', labelSource: 'heuristic', confidence: 0.5, description: '', framing: 'unknown', focus: null, issues: [] },
      { id: 's2', assetId, startSec: 4, endSec: 10, quality, label: 'unknown', labelSource: 'heuristic', confidence: 0.2, description: '', framing: 'unknown', focus: null, issues: [] },
    ],
    sampledFrames: [],
    audio: { hasAudio: true, integratedLoudnessLufs: -20, silenceRatio: 0.1, speechLikely: true, speechConfidence: 0.7 },
    transcript: null,
    labelling: { source: 'heuristic', model: null, note: '' },
    completedAt: t0.toISOString(),
  };
}

function asset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  const a = analysis(id);
  return {
    id,
    projectId: 'p1',
    kind: 'video',
    originalFilename: `${id}.mov`,
    mimeType: 'video/quicktime',
    byteSize: 1000,
    sortOrder: 0,
    originalKey: `projects/p1/assets/${id}/original.mov`,
    proxyKey: `projects/p1/assets/${id}/proxy.mp4`,
    thumbnailKey: `projects/p1/assets/${id}/thumb.jpg`,
    status: 'ready',
    statusMessage: '2 shots',
    probe: a.probe,
    analysis: a,
    manualLabels: {},
    clipLabel: null,
    deletedAt: null,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

const licence: MusicLicence = {
  kind: 'commercial_licence',
  source: 'Library',
  licenceName: '',
  proofUrl: '',
  notes: '',
  permitted: { promotionalUse: true, instagram: true, tiktok: true, youtube: false, website: false },
  attributionRequired: false,
  attributionText: '',
  expiresAt: null,
  confirmedByOwnerAt: t0.toISOString(),
};

function track(id: string, overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    projectId: null,
    title: 'Beat',
    artist: '',
    source: 'upload',
    catalogueProvider: null,
    catalogueTrackId: null,
    storageKey: `music/${id}/original.mp3`,
    mimeType: 'audio/mpeg',
    byteSize: 100,
    durationSec: 40,
    bpm: 120,
    beats: null,
    moods: [],
    licence,
    status: 'ready',
    statusMessage: '',
    deletedAt: null,
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

const plan = { segments: [{ assetId: 'a2' }] } as unknown as EditPlan;

function version(id: string, overrides: Partial<EditVersion> = {}): EditVersion {
  return {
    id,
    editId: 'e1',
    versionNo: 1,
    parentVersionId: null,
    origin: 'initial',
    instruction: '',
    planSource: 'rules',
    plannerModel: null,
    plan,
    validation: { ok: true, errors: [], warnings: [{ code: 'SILENT_EDIT', message: 'This edit has no music and no original sound; it will export silent', severity: 'warning' } as never] },
    status: 'preview_ready',
    statusMessage: 'Preview ready',
    previewKey: `projects/p1/edits/e1/v1/preview.mp4`,
    previewDurationSec: 24.5,
    exportStatus: 'none',
    exportKey: null,
    exportByteSize: null,
    exportMessage: '',
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

const generation: Generation = {
  id: 'g1',
  projectId: 'p1',
  requestedBy: 'u1',
  settings: { durationSec: 25, styles: ['beat_montage'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
  status: 'complete',
  statusMessage: '',
  plannerUsed: 'rules',
  createdAt: t0,
  updatedAt: t0,
};

const edit: Edit = { id: 'e1', projectId: 'p1', generationId: 'g1', styleId: 'beat_montage', slot: 0, isFavourite: true, currentVersionId: 'v2', deletedAt: null, createdAt: t0, updatedAt: t0 };

function rows(overrides: Partial<Parameters<typeof shapeStudioStatus>[0]> = {}): Parameters<typeof shapeStudioStatus>[0] {
  return {
    project: project(),
    assets: [asset('a2', { sortOrder: 1 }), asset('a1', { sortOrder: 0, thumbnailKey: null, status: 'processing', analysis: null, probe: null, statusMessage: 'Creating a preview copy' })],
    tracks: [track('t1'), track('t2', { status: 'processing', bpm: null, licence: { ...licence, confirmedByOwnerAt: null } }), track('t3', { projectId: 'p1' })],
    generations: [generation],
    edits: [edit],
    versions: [version('v1'), version('v2', { versionNo: 2, parentVersionId: 'v1', origin: 'revise', instruction: 'Make this 15 seconds', status: 'rendering_preview', previewKey: null, planSource: 'ai' })],
    jobs: [],
    settings: DEFAULT_SETTINGS,
    maxUploadBytes: 1024,
    partSize: 8 * 1024 * 1024,
    mediaLinkTtlSeconds: 3600,
    now: t0,
    ...overrides,
  };
}

describe('status payload shaping', () => {
  it('lists clips in order with friendly facts and signed thumbnails only', async () => {
    const dto = await shapeStudioStatus(rows(), sign);
    expect(dto.assets.map((a) => a.id)).toEqual(['a1', 'a2']);
    const [processing, ready] = dto.assets;
    expect(processing).toMatchObject({ status: 'processing', thumbnailUrl: null, durationSec: null, shots: null, hasAudio: null });
    expect(ready).toMatchObject({ isHdr: true, rotation: 90, width: 1080, height: 1920, durationSec: 10, hasAudio: true, speechLikely: true, hasTranscript: false });
    expect(ready?.shots).toEqual({ count: 2, identified: 1, labels: { cutting: 1, unknown: 1 } });
    expect(ready?.thumbnailUrl).toMatch(/^https:\/\/signed\.example\//);
  });

  it('never copies storage keys, plans or private fields into the payload', async () => {
    const json = JSON.stringify(await shapeStudioStatus(rows(), sign));
    for (const word of ['originalKey', 'proxyKey', 'thumbnailKey', 'previewKey', 'exportKey', 'storageKey', '"plan"', 'projects/p1', 'music/t1', 'ownerId']) {
      expect(json).not.toContain(word);
    }
  });

  it('nests edits with every version (newest first) and links only finished previews', async () => {
    const dto = await shapeStudioStatus(rows(), sign);
    const e = dto.generations[0]?.edits[0];
    expect(e).toMatchObject({ styleId: 'beat_montage', styleName: 'Beat-synced montage', isFavourite: true, currentVersionId: 'v2' });
    expect(e?.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    const [v2, v1] = e?.versions ?? [];
    expect(v2).toMatchObject({ origin: 'revise', instruction: 'Make this 15 seconds', previewUrl: null, planSource: 'ai' });
    expect(v1?.previewUrl).toMatch(/^https:\/\/signed\.example\//);
    expect(v1?.posterUrl).toMatch(/^https:\/\/signed\.example\//);
    expect(v1?.warnings).toEqual(['This edit has no music and no original sound; it will export silent']);
  });

  it('offers only library music and summarises the licence plainly', async () => {
    const dto = await shapeStudioStatus(rows(), sign);
    expect(dto.music.map((m) => m.id)).toEqual(['t1', 't2']);
    expect(dto.music[0]).toMatchObject({ bpm: 120, licenceConfirmed: true, licenceSummary: 'Licence confirmed · Instagram, TikTok' });
    expect(dto.music[1]).toMatchObject({ licenceConfirmed: false, licenceSummary: 'Licence not confirmed' });
    expect(licenceSummary({ ...licence, expiresAt: '2020-01-01T00:00:00Z' })).toBe('Licence expired');
  });

  it('reports busy while work is happening and idle when everything has settled', async () => {
    const busy = await shapeStudioStatus(rows(), sign);
    expect(busy.busy).toBe(true);
    const idle = await shapeStudioStatus(
      rows({ assets: [asset('a2')], tracks: [track('t1')], versions: [version('v1')], edits: [{ ...edit, currentVersionId: 'v1' }] }),
      sign,
    );
    expect(idle.busy).toBe(false);
    expect(isStudioBusy({ ...idle, generations: [{ ...idle.generations[0]!, edits: [{ ...idle.generations[0]!.edits[0]!, versions: [{ ...idle.generations[0]!.edits[0]!.versions[0]!, exportStatus: 'rendering' }] }] }] })).toBe(true);
  });

  it('lists all five styles with plain reasons, or asks for clips first', async () => {
    const styles = shapeStyleOptions(project().styleSupport);
    expect(styles.map((s) => s.id)).toEqual(['beat_montage', 'cinematic_reveal', 'before_after', 'clean_promo', 'process_story']);
    expect(styles[0]).toMatchObject({ supported: true, reason: '' });
    expect(styles[2]).toMatchObject({ supported: false, reason: 'Needs a "before" shot.' });
    const none = await shapeStudioStatus(rows({ assets: [] }), sign);
    expect(none.styles.every((s) => !s.supported && /Add your clips first/.test(s.reason))).toBe(true);
  });

  it('counts shot labels with the owner tags applied', async () => {
    const dto = await shapeStudioStatus(rows({ assets: [asset('a2', { manualLabels: { s2: 'result' } })] }), sign);
    expect(dto.assets[0]?.shots).toEqual({ count: 2, identified: 2, labels: { cutting: 1, result: 1 } });
  });

  it('sends a small energy curve for analysed music only', () => {
    const energy = Array.from({ length: 160 }, (_, i) => (i % 4) / 4);
    const ready = shapeMusicOption(track('t1', { beats: { beatTimesSec: [0.5, 1], energy, energyStepSec: 0.25 } }));
    expect(ready.energy?.values.length).toBeLessThanOrEqual(120);
    expect(ready.energy?.stepSec).toBe(0.5);
    expect(JSON.stringify(ready)).not.toContain('beatTimesSec');
    expect(shapeMusicOption(track('t2', { status: 'processing', beats: { beatTimesSec: [], energy, energyStepSec: 0.25 } })).energy).toBeNull();
    expect(shapeMusicOption(track('t3')).energy).toBeNull();
  });
});

describe('per-shot panel shaping', () => {
  const withFrames = (overrides: Partial<MediaAsset> = {}) => {
    const base = asset('a2', overrides);
    const a = base.analysis!;
    return {
      ...base,
      analysis: {
        ...a,
        shots: [a.shots[0]!, { ...a.shots[1]!, labelSource: 'vision_model' as const, label: 'fade_detail' as const, description: 'Close-up of the fade' }],
        sampledFrames: [
          { timeSec: 0.5, storageKey: 'projects/p1/assets/a2/frames/f0.jpg', width: 768, height: 432, shotId: 's1' },
          { timeSec: 2.1, storageKey: 'projects/p1/assets/a2/frames/f1.jpg', width: 768, height: 432, shotId: 's1' },
          { timeSec: 9.5, storageKey: 'projects/p1/assets/a2/frames/f2.jpg', width: 768, height: 432, shotId: null },
        ],
      },
    };
  };

  it('lists each shot with its range, the label in use, where it came from and the middle frame', async () => {
    const dto = await shapeAssetShots(withFrames(), sign);
    expect(dto.shots.map((s) => [s.id, s.startSec, s.endSec, s.label, s.source])).toEqual([
      ['s1', 0, 4, 'cutting', 'heuristic'],
      ['s2', 4, 10, 'fade_detail', 'vision_model'],
    ]);
    // s1 runs 0–4 s: the frame at 2.1 s is closest to its middle.
    expect(dto.shots[0]?.frameUrl).toBe(await sign('projects/p1/assets/a2/frames/f1.jpg'));
    // s2 has no frame tagged with its id, but one falls inside its time range.
    expect(dto.shots[1]?.frameUrl).toBe(await sign('projects/p1/assets/a2/frames/f2.jpg'));
    expect(dto.shots[1]?.description).toBe('Close-up of the fade');
    expect(JSON.stringify(dto)).not.toContain('storageKey');
  });

  it('marks shot tags and clip tags as the owner\'s', async () => {
    const dto = await shapeAssetShots(withFrames({ clipLabel: 'result', manualLabels: { s1: 'before' } }), sign);
    expect(dto.shots[0]).toMatchObject({ label: 'before', source: 'shot_tag', manualLabel: 'before', detectedLabel: 'cutting' });
    expect(dto.shots[1]).toMatchObject({ label: 'result', source: 'clip_tag', manualLabel: null, detectedLabel: 'fade_detail' });
    expect(dto.manualLabels).toEqual({ s1: 'before' });
    expect(dto.clipLabel).toBe('result');
  });

  it('returns no shots for a clip that has not been analysed', async () => {
    expect((await shapeAssetShots(asset('a1', { analysis: null }), sign)).shots).toEqual([]);
  });
});
