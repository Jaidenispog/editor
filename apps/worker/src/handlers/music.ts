import path from 'node:path';
import { eq } from 'drizzle-orm';
import { AppError, CancelledError } from '@studio/core';
import { schema } from '@studio/db';
import { analyseMusic, probeMedia } from '@studio/media';
import type { WorkerContext } from '../context.js';
import { INTERRUPTED_MESSAGE, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { createJobTempDir, removeTempDir } from '../lib/temp.js';

/** Probes an uploaded music track and detects its tempo/beat grid so cuts can be aligned to the music. */
export async function handleAnalyseMusic(ctx: WorkerContext, run: TrackedRun, payload: { trackId: string }): Promise<void> {
  const track = await ctx.db.query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, payload.trackId) });
  if (!track) throw new AppError('NOT_FOUND', 'Music track no longer exists');
  await ctx.db.update(schema.musicTracks).set({ status: 'processing', statusMessage: 'Analysing the track', updatedAt: new Date() }).where(eq(schema.musicTracks.id, track.id));
  const tmp = await createJobTempDir(ctx.tmpRoot, run.jobId);
  try {
    const local = path.join(tmp, `track.${track.storageKey.split('.').pop() ?? 'bin'}`);
    await run.progress(0.1, 'Fetching the track');
    await ctx.store.downloadToFile(track.storageKey, local);
    const probe = await probeMedia(local, ctx.env.FFPROBE_PATH);
    if (!probe.audio) throw new AppError('UNSUPPORTED', 'This file has no audio track');
    await run.progress(0.3, 'Detecting the beat');
    const music = await analyseMusic(local, { probe, ffmpegPath: ctx.env.FFMPEG_PATH, signal: run.signal });
    await ctx.db
      .update(schema.musicTracks)
      .set({
        status: 'ready',
        statusMessage: music.bpm ? `Ready · ${Math.round(music.bpm)} BPM` : 'Ready · no clear beat detected',
        durationSec: music.durationSec,
        bpm: music.bpm,
        beats: { beatTimesSec: music.beatTimesSec, energy: music.energy, energyStepSec: music.energyStepSec },
        updatedAt: new Date(),
      })
      .where(eq(schema.musicTracks.id, track.id));
    await run.progress(1, 'Track ready');
  } catch (err) {
    const outcome = err instanceof CancelledError ? await stopOutcome(run) : null;
    const values =
      outcome === 'cancelled'
        ? { status: 'uploaded' as const, statusMessage: 'Analysis cancelled' } // the web app reads this exact text (MUSIC_ANALYSIS_CANCELLED_MESSAGE)
        : outcome === 'resume'
          ? { status: 'processing' as const, statusMessage: INTERRUPTED_MESSAGE }
          : { status: 'failed' as const, statusMessage: err instanceof AppError ? err.message : 'The track could not be analysed' };
    await ctx.db
      .update(schema.musicTracks)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.musicTracks.id, track.id));
    throw err;
  } finally {
    await removeTempDir(tmp);
  }
}
