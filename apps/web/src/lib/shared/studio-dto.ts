import type { GenerationSettings, MusicLicence, StyleId } from '@studio/core';
import type { JobDto } from './dto.js';
import type { EnergyCurve } from './music-curve.js';

/**
 * Browser-facing shape of GET /api/projects/[id]/status (plain JSON). Media links are short-lived signed
 * URLs; storage keys and other private details never appear here.
 */
export interface StudioStatusDto {
  project: {
    id: string;
    title: string;
    clientName: string;
    notes: string;
    status: string;
    lastSettings: GenerationSettings | null;
    updatedAt: string;
  };
  /** All five styles in their fixed order, with whether the current footage supports them. */
  styles: StyleOptionDto[];
  assets: AssetDto[];
  music: MusicOptionDto[];
  generations: GenerationDto[];
  jobs: JobDto[];
  defaults: { durationSec: number; keepOriginalSound: 'auto' | 'always' | 'never'; captions: 'auto' | 'never'; preferredStyles: StyleId[] };
  limits: { maxUploadBytes: number; partSize: number; mediaLinkTtlSeconds: number };
  /** True while anything is queued or working, so the page polls faster. */
  busy: boolean;
  generatedAt: string;
}

export interface StyleOptionDto {
  id: StyleId;
  name: string;
  description: string;
  supported: boolean;
  /** Plain reason when the style cannot be made from the current clips. */
  reason: string;
}

export interface AssetDto {
  id: string;
  filename: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  statusMessage: string;
  sortOrder: number;
  byteSize: number;
  thumbnailUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  rotation: number;
  isHdr: boolean;
  hasAudio: boolean | null;
  speechLikely: boolean;
  hasTranscript: boolean;
  clipLabel: string | null;
  shots: { count: number; identified: number; labels: Record<string, number> } | null;
  createdAt: string;
}

export interface MusicOptionDto {
  id: string;
  title: string;
  artist: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  statusMessage: string;
  bpm: number | null;
  durationSec: number | null;
  licence: MusicLicence;
  licenceConfirmed: boolean;
  /** Short plain summary such as "Licence confirmed · Instagram, TikTok". */
  licenceSummary: string;
  /** Loudness over the track for the start-point picker (shrunk to a few hundred points), once analysed. */
  energy: EnergyCurve | null;
}

/**
 * One shot of a clip for the "Shots" panel (GET /api/assets/[id]/shots). The frame is a short-lived signed
 * link to a still taken during analysis.
 */
export interface ShotDto {
  id: string;
  startSec: number;
  endSec: number;
  /** The label the editor will use (owner tags applied). */
  label: string;
  /** Where that label came from. */
  source: 'shot_tag' | 'clip_tag' | 'vision_model' | 'heuristic';
  /** What the analysis said before any owner tag. */
  detectedLabel: string;
  /** The owner's tag for this shot only, or null. */
  manualLabel: string | null;
  description: string;
  frameUrl: string | null;
}

/** Response of GET /api/assets/[id]/shots. */
export interface AssetShotsDto {
  assetId: string;
  clipLabel: string | null;
  manualLabels: Record<string, string>;
  shots: ShotDto[];
}

export interface GenerationDto {
  id: string;
  status: string;
  statusMessage: string;
  plannerUsed: string | null;
  settings: GenerationSettings;
  createdAt: string;
  edits: EditDto[];
}

export interface EditDto {
  id: string;
  styleId: StyleId;
  styleName: string;
  styleDescription: string;
  slot: number;
  isFavourite: boolean;
  currentVersionId: string | null;
  /** Every version, newest first; nothing is ever deleted when switching or revising. */
  versions: VersionDto[];
}

export interface VersionDto {
  id: string;
  versionNo: number;
  status: 'planning' | 'planned' | 'rendering_preview' | 'preview_ready' | 'failed' | 'cancelled';
  statusMessage: string;
  origin: 'initial' | 'revise' | 'regenerate';
  instruction: string;
  planSource: 'ai' | 'rules' | 'manual' | null;
  warnings: string[];
  previewUrl: string | null;
  posterUrl: string | null;
  previewDurationSec: number | null;
  exportStatus: 'none' | 'queued' | 'rendering' | 'ready' | 'failed';
  exportMessage: string;
  exportByteSize: number | null;
  createdAt: string;
}

/** Version statuses that mean work is still happening. */
export const ACTIVE_VERSION_STATUSES: ReadonlyArray<VersionDto['status']> = ['planning', 'planned', 'rendering_preview'];

/** Asset statuses that mean the clip is still being processed. */
export const PROCESSING_ASSET_STATUSES: ReadonlyArray<AssetDto['status']> = ['uploaded', 'processing'];
