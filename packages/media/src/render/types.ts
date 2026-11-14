import type { AssetProbe, EditPlan, OutputFormat, TranscriptSegment } from '@studio/core';
import type { ExportCheck } from './verify.js';

/** Preview renders are fast and small (540x960); exports are full quality (1080x1920). */
export type RenderQuality = 'preview' | 'export';

/** A source clip the plan refers to: where it is on disk and what ffprobe found in it. */
export interface RenderAsset {
  path: string;
  probe: AssetProbe;
}

/** The music track the plan uses (already downloaded next to the clips). */
export interface RenderMusic {
  path: string;
  durationSec: number;
  /** When given, the track id must match the plan's music track (an extra guard against mix-ups). */
  trackId?: string;
}

/** The parts of the brand configuration the renderer needs for on-screen text. */
export interface RenderBrand {
  /** Hex colour such as #C8A24A, used for accent text. */
  accentColour: string;
  videoTextStyle: 'minimal' | 'bold' | 'editorial';
  /** Font family name for headlines (e.g. "Inter Display"). */
  fontHeadline: string;
  /** Font family name for everything else (e.g. "Inter"). */
  fontBody: string;
  /** Optional handle shown briefly at the end of the video. Empty or missing = not shown. */
  socialHandle?: string;
}

export interface RenderInputs {
  /** A plan that already passed validateEditPlan; it is validated again before rendering. */
  plan: EditPlan;
  /** Every asset the plan refers to, keyed by asset id. */
  assets: Record<string, RenderAsset>;
  music: RenderMusic | null;
  /** Transcript segments keyed by asset id; needed for captions to validate. */
  transcripts?: Record<string, TranscriptSegment[]>;
  quality: RenderQuality;
  /** Output size and frame rate. Defaults to VERTICAL_PREVIEW for previews and VERTICAL_1080 for exports. */
  output?: OutputFormat;
  brand: RenderBrand;
  /** Directory holding the font files handed to libass (e.g. assets/fonts). */
  fontsDir: string;
  /** Scratch directory for the generated subtitle file; created if missing. */
  tmpDir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** CPU threads for FFmpeg (0 or undefined = let FFmpeg decide). */
  threads?: number;
  signal?: AbortSignal;
  /** Called with 0..1 as the render progresses. */
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  byteSize: number;
  probe: AssetProbe;
  /** The exact FFmpeg arguments that produced the file (handy for debugging). */
  ffmpegArgs: string[];
  /** Path of the generated ASS subtitle file, or null when the plan has no on-screen text. */
  assPath: string | null;
  /** The ffprobe check of an export (always passing, or the render would have failed); null for previews. */
  exportCheck: ExportCheck | null;
}

/** The pure, inspectable output of buildRenderCommand. */
export interface RenderCommand {
  args: string[];
  filterComplex: string;
  totalDurationSec: number;
  /** False when the command writes no audio stream (`-an`). */
  hasAudio: boolean;
}
