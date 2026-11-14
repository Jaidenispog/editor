import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError, CancelledError, safeZoneFor, validateEditPlan, type PlanValidationContext } from '@studio/core';
import { FfmpegError, runFfmpeg } from '../ffmpeg.js';
import { probeMedia } from '../ffprobe.js';
import { layoutAssDocument, type AssTextBox } from './ass.js';
import { assertRenderableDuration, buildRenderCommand, exportLevelFor, resolveOutputFormat } from './command.js';
import { checkOverlayRects, layoutLogo, logoRects, resolveRenderFont, type LogoLayout } from './logo.js';
import type { RenderInputs, RenderResult } from './types.js';
import { verifyExport, type ExportCheck } from './verify.js';

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
 * Steps: re-validate the plan against the real probes (defence in depth), refuse edits over
 * MAX_RENDER_DURATION_SEC, write the ASS overlay file into tmpDir, build the FFmpeg command, run it
 * with progress, and for exports check the file with verifyExport (codec, profile, level, size,
 * colour tags, audio format, duration); then probe the result. A cancelled render rethrows
 * CancelledError and removes the partial file; an FFmpeg failure, or an export that fails the
 * check, becomes an AppError('PROCESSING_FAILED') with the details for the logs and no file left behind.
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
  assertRenderableDuration(timeline.totalDurationSec);

  for (const segment of plan.segments) {
    const asset = inputs.assets[segment.assetId];
    if (!asset?.probe.video) {
      throw new AppError('VALIDATION', `Clip ${segment.assetId} has no video and cannot be used in an edit.`);
    }
  }

  const output = resolveOutputFormat(inputs);
  const safeZone = safeZoneFor(output.width, output.height);

  await mkdir(inputs.tmpDir, { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });

  let assPath: string | null = null;
  let textBoxes: AssTextBox[] = [];
  if (planHasText({ plan, brand: inputs.brand })) {
    const fonts = await stat(inputs.fontsDir).catch(() => null);
    if (!fonts?.isDirectory()) {
      throw new AppError('INTERNAL', 'The fonts for video text are missing on the server, so this edit could not be rendered.', {
        details: { fontsDir: inputs.fontsDir },
      });
    }
    assPath = join(inputs.tmpDir, `overlay-${randomUUID()}.ass`);
    // Fonts that do not ship with the renderer (older settings) are drawn with Inter rather than a random system font.
    const headline = await resolveRenderFont(inputs.brand.fontHeadline, inputs.fontsDir);
    const body = await resolveRenderFont(inputs.brand.fontBody, inputs.fontsDir);
    const layout = layoutAssDocument(plan, timeline, output, safeZone, inputs.brand, { headline, body });
    textBoxes = layout.boxes;
    await writeFile(assPath, layout.document, 'utf8');
  }

  let logoLayout: LogoLayout | null = null;
  if (inputs.brand.logo) {
    logoLayout = layoutLogo(inputs.brand.logo, output, safeZone, timeline.totalDurationSec, textBoxes);
    const check = checkOverlayRects(logoRects(logoLayout), safeZone);
    if (!check.ok) {
      throw new AppError('INTERNAL', 'The logo could not be placed safely, so this edit was not rendered.', { details: { problems: check.problems } });
    }
  }

  const command = buildRenderCommand({ ...inputs, plan, output }, outputPath, assPath, logoLayout);
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

  let exportCheck: ExportCheck | null = null;
  if (inputs.quality === 'export') {
    exportCheck = await verifyExport(
      outputPath,
      { width: output.width, height: output.height, fps: output.fps, level: exportLevelFor(output.fps), hasAudio: command.hasAudio, durationSec: total },
      inputs.ffprobePath,
    );
    if (!exportCheck.ok) {
      await rm(outputPath, { force: true });
      throw new AppError(
        'PROCESSING_FAILED',
        'The exported video did not come out in the format Instagram and TikTok expect, so it was not saved. Please try exporting again.',
        { details: { problems: exportCheck.problems, ffmpegArgs: command.args } },
      );
    }
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
    exportCheck,
    logoLayout,
  };
}
