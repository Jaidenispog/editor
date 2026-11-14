import type { GenerationSettings, MusicLicence, StyleId } from '@studio/core';
import type { JobDto } from './dto.js';

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
  limits: { maxUploadBytes: number; partSize: number };
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
