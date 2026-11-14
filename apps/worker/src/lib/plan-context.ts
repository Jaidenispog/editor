import { asc, and, eq, isNull } from 'drizzle-orm';
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  newId,
  type AppSettings,
  type AssetAnalysis,
  type PlanAssetInfo,
  type TranscriptSegment,
} from '@studio/core';
import { schema, type MediaAsset, type MusicTrack, type Project } from '@studio/db';
import type { AiUsage } from '@studio/ai';
import type { WorkerContext } from '../context.js';
import { applyManualLabels } from '@studio/core';

export interface LoadedFootage {
  project: Project;
  assets: Array<MediaAsset & { analysis: AssetAnalysis }>;
  analyses: AssetAnalysis[];
  planAssets: PlanAssetInfo[];
  transcripts: Record<string, TranscriptSegment[]>;
}

/** Loads every ready clip in a project with manual tags applied, in the owner's chosen order. */
export async function loadProjectFootage(ctx: WorkerContext, projectId: string): Promise<LoadedFootage | null> {
  const project = await ctx.db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)) });
  if (!project) return null;
  const rows = await ctx.db.query.mediaAssets.findMany({
    where: and(eq(schema.mediaAssets.projectId, projectId), eq(schema.mediaAssets.status, 'ready'), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.kind, 'video')),
    orderBy: [asc(schema.mediaAssets.sortOrder), asc(schema.mediaAssets.createdAt)],
  });
  const assets = rows
    .filter((r): r is MediaAsset & { analysis: AssetAnalysis } => r.analysis !== null)
    .map((r) => ({ ...r, analysis: applyManualLabels(r.analysis, { clipLabel: r.clipLabel, manualLabels: r.manualLabels }) }));
  const analyses = assets.map((a) => a.analysis);
  const transcripts: Record<string, TranscriptSegment[]> = {};
  for (const a of assets) if (a.analysis.transcript?.segments.length) transcripts[a.id] = a.analysis.transcript.segments;
  return {
    project,
    assets,
    analyses,
    planAssets: assets.map((a) => ({ id: a.id, durationSec: a.analysis.probe.durationSec, hasAudio: a.analysis.probe.audio !== null })),
    transcripts,
  };
}

export interface LoadedMusic {
  track: MusicTrack;
  durationSec: number;
  bpm: number | null;
  beatTimesSec: number[];
}

/** Loads a music track that has finished analysing (null when none was chosen or it is not ready). */
export async function loadMusic(ctx: WorkerContext, trackId: string | null): Promise<LoadedMusic | null> {
  if (!trackId) return null;
  const track = await ctx.db.query.musicTracks.findFirst({ where: and(eq(schema.musicTracks.id, trackId), isNull(schema.musicTracks.deletedAt)) });
  if (!track || track.status !== 'ready' || !track.durationSec) return null;
  return { track, durationSec: track.durationSec, bpm: track.bpm ?? null, beatTimesSec: track.beats?.beatTimesSec ?? [] };
}

/** The owner's saved settings, or the defaults when none are stored or the stored copy no longer parses. */
export async function loadSettings(ctx: WorkerContext): Promise<AppSettings> {
  const row = await ctx.db.query.settings.findFirst({ where: eq(schema.settings.id, 'default') });
  if (!row) return DEFAULT_SETTINGS;
  const parsed = AppSettingsSchema.safeParse(row.data);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** Allowed total-length window around the target: ±12 % but never tighter than ±2 s. */
export function durationBoundsFor(targetSec: number): { min: number; max: number } {
  const slack = Math.max(2, targetSec * 0.12);
  return { min: Math.max(3, targetSec - slack), max: targetSec + slack };
}

/** Records one AI call's tokens and estimated cost for the usage page (nothing is written without usage). */
export async function recordAiUsage(ctx: WorkerContext, projectId: string | null, purpose: string, usage: AiUsage | null): Promise<void> {
  if (!usage) return;
  await ctx.db.insert(schema.aiUsage).values({
    id: newId(),
    projectId,
    purpose,
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    estimatedCostUsdCents: usage.estimatedCostUsdCents,
    durationMs: usage.durationMs,
  });
}
