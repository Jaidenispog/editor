import { ReferenceStyleProfileSchema, STYLES, STYLE_IDS, applyManualLabels, effectivePreferences, licenceStateOf, type AppSettings, type MusicLicence, type StyleId, type StyleSupport } from '@studio/core';
import type { Edit, EditVersion, Generation, JobRow, MediaAsset, MusicTrack, Project } from '@studio/db';
import { downsampleEnergy } from './shared/music-curve.js';
import type { AssetDto, AssetShotsDto, EditDto, GenerationDto, MusicOptionDto, ReferenceDto, ShotDto, StudioStatusDto, StyleOptionDto, VersionDto } from './shared/studio-dto.js';
import { ACTIVE_VERSION_STATUSES, PROCESSING_ASSET_STATUSES } from './shared/studio-dto.js';
import type { JobDto } from './shared/dto.js';
import type { WorkerStatusDto } from './shared/worker-notice.js';

/** Turns a storage key into a short-lived link (or null when it cannot be signed). */
export type LinkSigner = (key: string) => Promise<string | null>;

/** Rows needed to build the status payload, already loaded from the database. */
export interface StudioStatusRows {
  project: Project;
  assets: MediaAsset[];
  tracks: MusicTrack[];
  generations: Generation[];
  edits: Edit[];
  versions: EditVersion[];
  jobs: JobDto[];
  settings: AppSettings;
  maxUploadBytes: number;
  partSize: number;
  mediaLinkTtlSeconds: number;
  /** Background worker status (lib/worker-status.ts); left out, the payload says it was not checked (null). */
  worker?: WorkerStatusDto | null;
  now?: Date;
}

const NO_CLIPS_REASON = 'Add your clips first. Styles become available once the clips have been analysed.';

/** The five styles in order, each marked supported or not with the plain reason from the analysis. */
export function shapeStyleOptions(styleSupport: StyleSupport[] | null): StyleOptionDto[] {
  const byId = new Map((styleSupport ?? []).map((s) => [s.styleId, s]));
  return STYLE_IDS.map((id) => {
    const def = STYLES[id];
    const s = byId.get(id);
    return {
      id,
      name: def.name,
      description: def.shortDescription,
      supported: s ? s.supported : false,
      reason: s ? (s.supported ? '' : s.reason) : NO_CLIPS_REASON,
    };
  });
}

/** Browser-safe summary of one clip; the thumbnail is a signed link, the storage keys stay on the server. */
export async function shapeAsset(asset: MediaAsset, sign: LinkSigner): Promise<AssetDto> {
  const video = asset.probe?.video ?? asset.analysis?.probe.video ?? null;
  // Counts reflect the owner's tags, the same labels the editor plans with.
  const analysis = asset.analysis ? applyManualLabels(asset.analysis, { clipLabel: asset.clipLabel, manualLabels: asset.manualLabels }) : null;
  let shots: AssetDto['shots'] = null;
  if (analysis) {
    const labels: Record<string, number> = {};
    let identified = 0;
    for (const s of analysis.shots) {
      labels[s.label] = (labels[s.label] ?? 0) + 1;
      if (s.label !== 'unknown' && s.label !== 'other') identified++;
    }
    shots = { count: analysis.shots.length, identified, labels };
  }
  const probe = asset.probe ?? analysis?.probe ?? null;
  return {
    id: asset.id,
    filename: asset.originalFilename,
    status: asset.status,
    statusMessage: asset.statusMessage,
    sortOrder: asset.sortOrder,
    byteSize: asset.byteSize,
    thumbnailUrl: asset.thumbnailKey ? await sign(asset.thumbnailKey) : null,
    durationSec: probe ? probe.durationSec : null,
    width: video?.displayWidth ?? null,
    height: video?.displayHeight ?? null,
    rotation: video?.rotation ?? 0,
    isHdr: Boolean(video?.isHdr),
    hasAudio: analysis ? analysis.audio.hasAudio : probe ? probe.audio !== null : null,
    speechLikely: Boolean(analysis?.audio.speechLikely),
    hasTranscript: Boolean(analysis?.transcript && analysis.transcript.segments.length > 0),
    clipLabel: asset.clipLabel,
    shots,
    createdAt: asset.createdAt.toISOString(),
  };
}

/** Plain one-line summary of what a music licence covers (the same states as the licence chip, `licenceStateOf`). */
export function licenceSummary(licence: MusicLicence): string {
  const state = licenceStateOf(licence);
  // "I'm not sure" with the rights box ticked: usable in previews, never shown as a confirmed licence.
  if (state === 'not_confirmed') return licence.confirmedByOwnerAt ? 'Origin not recorded · previews only' : 'Licence not confirmed';
  if (state === 'expired') return 'Licence expired';
  const places = (
    [
      ['instagram', 'Instagram'],
      ['tiktok', 'TikTok'],
      ['youtube', 'YouTube'],
      ['website', 'website'],
    ] as const
  )
    .filter(([k]) => licence.permitted[k])
    .map(([, name]) => name);
  return places.length ? `Licence confirmed · ${places.join(', ')}` : 'Licence confirmed';
}

/** Library track as a music choice in the style controls. */
export function shapeMusicOption(track: MusicTrack): MusicOptionDto {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    status: track.status,
    statusMessage: track.statusMessage,
    bpm: track.bpm,
    durationSec: track.durationSec,
    licence: track.licence,
    licenceConfirmed: Boolean(track.licence.confirmedByOwnerAt),
    licenceSummary: licenceSummary(track.licence),
    energy: track.status === 'ready' && track.beats ? downsampleEnergy(track.beats.energy, track.beats.energyStepSec) : null,
    genres: track.genres ?? [],
    moods: track.moods ?? [],
    licenceState: licenceStateOf(track.licence),
  };
}

/**
 * One reference video for the Studio strip and Settings: file name, processing state, thumbnail and (once measured)
 * the profile with its suggestions. Never anything that could be used as footage.
 */
export async function shapeReference(asset: MediaAsset, sign: LinkSigner): Promise<ReferenceDto> {
  const parsed = asset.referenceProfile ? ReferenceStyleProfileSchema.safeParse(asset.referenceProfile) : null;
  return {
    id: asset.id,
    filename: asset.originalFilename,
    status: asset.status,
    statusMessage: asset.statusMessage,
    thumbnailUrl: asset.thumbnailKey ? await sign(asset.thumbnailKey) : null,
    profile: parsed?.success ? parsed.data : null,
    createdAt: asset.createdAt.toISOString(),
  };
}

/**
 * The shots of one clip for the "Shots" panel: time range, the label the editor will use and where it came
 * from, and a signed link to the analysis still closest to the middle of the shot.
 */
export async function shapeAssetShots(asset: MediaAsset, sign: LinkSigner): Promise<AssetShotsDto> {
  const raw = asset.analysis;
  const shots: ShotDto[] = [];
  if (raw) {
    const effective = applyManualLabels(raw, { clipLabel: asset.clipLabel, manualLabels: asset.manualLabels });
    for (const [i, shot] of raw.shots.entries()) {
      const applied = effective.shots[i] ?? shot;
      const manual = asset.manualLabels[shot.id] ?? null;
      const usedManual = applied.labelSource === 'manual' && shot.labelSource !== 'manual';
      const source: ShotDto['source'] = usedManual ? (manual ? 'shot_tag' : 'clip_tag') : shot.labelSource === 'vision_model' ? 'vision_model' : shot.labelSource === 'manual' ? 'shot_tag' : 'heuristic';
      const mid = (shot.startSec + shot.endSec) / 2;
      const candidates = raw.sampledFrames.filter((f) => f.shotId === shot.id || (f.shotId === null && f.timeSec >= shot.startSec && f.timeSec <= shot.endSec));
      const frame = candidates.reduce<(typeof candidates)[number] | null>((best, f) => (!best || Math.abs(f.timeSec - mid) < Math.abs(best.timeSec - mid) ? f : best), null);
      shots.push({
        id: shot.id,
        startSec: shot.startSec,
        endSec: shot.endSec,
        label: applied.label,
        source,
        detectedLabel: shot.label,
        manualLabel: manual,
        description: shot.description,
        frameUrl: frame ? await sign(frame.storageKey) : null,
      });
    }
  }
  return { assetId: asset.id, clipLabel: asset.clipLabel, manualLabels: asset.manualLabels, shots };
}

/** One version of an edit; preview links only for finished previews, poster from the first clip used. */
export async function shapeVersion(version: EditVersion, posterKeyFor: (assetId: string) => string | null, sign: LinkSigner): Promise<VersionDto> {
  const firstAssetId = version.plan?.segments[0]?.assetId ?? null;
  const posterKey = firstAssetId ? posterKeyFor(firstAssetId) : null;
  const previewReady = version.status === 'preview_ready' && Boolean(version.previewKey);
  return {
    id: version.id,
    versionNo: version.versionNo,
    status: version.status,
    statusMessage: version.statusMessage,
    origin: version.origin,
    instruction: version.instruction,
    planSource: version.planSource,
    warnings: (version.validation?.warnings ?? []).map((w) => w.message).filter((m) => m.trim().length > 0),
    previewUrl: previewReady && version.previewKey ? await sign(version.previewKey) : null,
    posterUrl: posterKey ? await sign(posterKey) : null,
    previewDurationSec: version.previewDurationSec,
    exportStatus: version.exportStatus,
    exportMessage: version.exportMessage,
    exportByteSize: version.exportByteSize,
    createdAt: version.createdAt.toISOString(),
  };
}

function isStyleId(value: string): value is StyleId {
  return (STYLE_IDS as readonly string[]).includes(value);
}

/** True when anything in the payload is still queued or being worked on. */
export function isStudioBusy(dto: Pick<StudioStatusDto, 'generations' | 'jobs' | 'music'> & { assets: Array<Pick<AssetDto, 'status'>> }): boolean {
  if (dto.jobs.some((j) => j.status === 'queued' || j.status === 'running')) return true;
  if (dto.assets.some((a) => PROCESSING_ASSET_STATUSES.includes(a.status))) return true;
  if (dto.music.some((m) => m.status === 'uploaded' || m.status === 'processing')) return true;
  for (const g of dto.generations) {
    if (g.status === 'queued' || g.status === 'planning' || g.status === 'rendering') return true;
    for (const e of g.edits) {
      for (const v of e.versions) {
        if (ACTIVE_VERSION_STATUSES.includes(v.status)) return true;
        if (v.exportStatus === 'queued' || v.exportStatus === 'rendering') return true;
      }
    }
  }
  return false;
}

/**
 * Builds the GET /api/projects/[id]/status payload from loaded rows. Pure apart from the signer, so it can be
 * unit tested; nothing private (storage keys, plans, payloads) is copied into the result.
 */
export async function shapeStudioStatus(rows: StudioStatusRows, sign: LinkSigner): Promise<StudioStatusDto> {
  const { project, settings } = rows;
  const videoAssets = rows.assets.filter((a) => a.kind === 'video' && !a.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
  const thumbById = new Map(rows.assets.map((a) => [a.id, a.thumbnailKey]));
  const posterKeyFor = (assetId: string) => thumbById.get(assetId) ?? null;

  const versionsByEdit = new Map<string, EditVersion[]>();
  for (const v of rows.versions) {
    const list = versionsByEdit.get(v.editId) ?? [];
    list.push(v);
    versionsByEdit.set(v.editId, list);
  }

  const generations: GenerationDto[] = [];
  const sortedGenerations = [...rows.generations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const g of sortedGenerations) {
    const edits: EditDto[] = [];
    const genEdits = rows.edits.filter((e) => e.generationId === g.id && !e.deletedAt).sort((a, b) => a.slot - b.slot);
    for (const e of genEdits) {
      if (!isStyleId(e.styleId)) continue;
      const def = STYLES[e.styleId];
      const versions = [...(versionsByEdit.get(e.id) ?? [])].sort((a, b) => b.versionNo - a.versionNo);
      edits.push({
        id: e.id,
        styleId: e.styleId,
        styleName: def.name,
        styleDescription: def.shortDescription,
        slot: e.slot,
        isFavourite: e.isFavourite,
        dismissed: e.dismissedAt !== null && e.dismissedAt !== undefined,
        currentVersionId: e.currentVersionId,
        versions: await Promise.all(versions.map((v) => shapeVersion(v, posterKeyFor, sign))),
      });
    }
    generations.push({
      id: g.id,
      status: g.status,
      statusMessage: g.statusMessage,
      plannerUsed: g.plannerUsed,
      settings: g.settings,
      createdAt: g.createdAt.toISOString(),
      edits,
    });
  }

  const music = rows.tracks.filter((t) => !t.deletedAt && t.projectId === null).map(shapeMusicOption);
  const assets = await Promise.all(videoAssets.map((a) => shapeAsset(a, sign)));
  const references = await Promise.all(
    rows.assets
      .filter((a) => a.kind === 'reference_video' && !a.deletedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((a) => shapeReference(a, sign)),
  );
  // Form defaults use the effective preferences: pinned, else learned, else declared.
  const prefs = effectivePreferences(settings.preferences);
  const partial = { assets: [...assets, ...references.map((r) => ({ status: r.status }))], generations, jobs: rows.jobs, music };
  return {
    project: {
      id: project.id,
      title: project.title,
      clientName: project.clientName,
      notes: project.notes,
      status: project.status,
      lastSettings: project.lastSettings,
      updatedAt: project.updatedAt.toISOString(),
    },
    styles: shapeStyleOptions(videoAssets.length ? project.styleSupport : null),
    assets,
    music,
    generations,
    jobs: rows.jobs,
    defaults: {
      durationSec: prefs.defaultDurationSec,
      keepOriginalSound: prefs.keepOriginalSound,
      captions: prefs.captions,
      preferredStyles: prefs.preferredStyles,
      styleOrder: prefs.styleOrder,
      musicVolume: prefs.musicVolume,
    },
    references,
    limits: { maxUploadBytes: rows.maxUploadBytes, partSize: rows.partSize, mediaLinkTtlSeconds: rows.mediaLinkTtlSeconds },
    busy: isStudioBusy(partial),
    worker: rows.worker ?? null,
    generatedAt: (rows.now ?? new Date()).toISOString(),
  };
}
