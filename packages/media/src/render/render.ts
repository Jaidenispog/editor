import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AppError,
  CancelledError,
  VERTICAL_SAFE_ZONE_1080x1920,
  scaleSafeZone,
  validateEditPlan,
  type PlanValidationContext,
} from '@studio/core';
import { FfmpegError, runFfmpeg } from '../ffmpeg.js';
import { probeMedia } from '../ffprobe.js';
import { buildAssDocument } from './ass.js';
import { buildRenderCommand, resolveOutputFormat } from './command.js';
import type { RenderInputs, RenderResult } from './types.js';

/** Validation window around the target: generous, because the planners already enforced the real bounds. */
export const DURATION_BOUNDS_FACTOR = { min: 0.5, max: 1.6 } as const;

/** Builds the validator context from the probes and music the renderer was handed. */
export function validationContextFor(inputs: RenderInputs): PlanValidationContext {
  const plan = inputs.plan;
  const music = inputs.music && plan.audio.music ? { trackId: inputs.music.trackId ?? plan.audio.music.trackId, durationSec: inputs.music.durationSec } : null;
  return {
    assets: Object.entries(inputs.assets).map(([id, asset]) => ({ id, durationSec: asset.probe.durationSec, hasAudio: asset.probe.audio !== null })),
    music,
    transcripts: inputs.transcripts ?? {},
    durationBounds: { min: plan.targetDurationSec * DURATION_BOUNDS_FACTOR.min, max: plan.targetDurationSec * DURATION_BOUNDS_FACTOR.max },
  };
}

/** True when the plan (or brand handle) puts any text on screen, so an ASS file is needed. */
export function planHasText(inputs: Pick<RenderInputs, 'plan' | 'brand'>): boolean {
  return inputs.plan.textOverlays.length > 0 || inputs.plan.captions.length > 0 || (inputs.brand.socialHandle ?? '').trim().length > 0;
}

/**
 * Renders a validated edit plan to an MP4 at `outputPath`.
 *
 * Steps: re-validate the plan against the real probes (defence in depth), write the ASS overlay
 * file into tmpDir, build the FFmpeg command, run it with progress, probe the result. A cancelled
 * render rethrows CancelledError and removes the partial file; an FFmpeg failure becomes an
 * AppError('PROCESSING_FAILED') carrying the stderr tail and arguments for the logs.
 */
export async function renderEditPlan(inputs: RenderInputs, outputPath: string): Promise<RenderResult> {
  if (inputs.signal?.aborted) {
    throw new CancelledError('Render cancelled before it started');
  }

  const validation = validateEditPlan(inputs.plan, validationContextFor(inputs));
  if (!validation.ok || !validation.plan || !validation.timeline) {
    throw new AppError('VALIDATION', 'This edit cannot be rendered because its plan no longer matches the footage.', {
      details: { errors: validation.errors, warnings: validation.warnings },
    });
  }
  const plan = validation.plan;
  const timeline = validation.timeline;

  for (const segment of plan.segments) {
    const asset = inputs.assets[segment.assetId];
    if (!asset?.probe.video) {
      throw new AppError('VALIDATION', `Clip ${segment.assetId} has no video and cannot be used in an edit.`);
    }
  }

  const output = resolveOutputFormat(inputs);
  const safeZone = scaleSafeZone(VERTICAL_SAFE_ZONE_1080x1920, output.width, output.height);

  await mkdir(inputs.tmpDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  let assPath: string | null = null;
  if (planHasText({ plan, brand: inputs.brand })) {
    assPath = join(inputs.tmpDir, `overlay-${randomUUID()}.ass`);
    const document = buildAssDocument(plan, timeline, output, safeZone, inputs.brand, {
      headline: inputs.brand.fontHeadline,
      body: inputs.brand.fontBody,
    });
    await writeFile(assPath, document, 'utf8');
  }

  const command = buildRenderCommand({ ...inputs, plan, output }, outputPath, assPath);
  const total = command.totalDurationSec;
  const onProgress = inputs.onProgress;

  try {
    await runFfmpeg(command.args, {
      ...(inputs.ffmpegPath ? { ffmpegPath: inputs.ffmpegPath } : {}),
      ...(inputs.signal ? { signal: inputs.signal } : {}),
      ...(onProgress
        ? {
            onProgress: (p) => {
              const fraction = total > 0 ? p.outTimeSec / total : 0;
              onProgress(Math.min(1, Math.max(0, fraction)));
            },
          }
        : {}),
    });
  } catch (err) {
    await rm(outputPath, { force: true });
    if (err instanceof CancelledError) {
      throw err;
    }
    if (err instanceof FfmpegError) {
      throw new AppError('PROCESSING_FAILED', 'The video could not be rendered. Please try again; if it keeps failing, check that the clips still play.', {
        cause: err,
        details: { stderrTail: err.stderrTail, ffmpegArgs: command.args },
      });
    }
    throw err;
  }

  const probe = await probeMedia(outputPath, inputs.ffprobePath);
  onProgress?.(1);
  return {
    outputPath,
    durationSec: probe.durationSec,
    byteSize: probe.fileSizeBytes,
    probe,
    ffmpegArgs: command.args,
    assPath,
  };
}
