import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  CancelledError,
  JOB_TYPES,
  STYLES,
  evaluateStyleSupport,
  computeTimeline,
  parseRevisionInstruction,
  type EditPlan,
  type GenerationSettings,
  type PlanValidationContext,
  type RevisionHints,
  type StyleId,
} from '@studio/core';
import { schema, type EditVersion } from '@studio/db';
import type { PlannerInput } from '@studio/ai';
import type { WorkerContext } from '../context.js';
import type { TrackedRun } from '../lib/job-tracker.js';
import { enqueueTracked } from '../lib/jobs.js';
import { durationBoundsFor, loadMusic, loadProjectFootage, loadSettings, recordAiUsage, type LoadedFootage, type LoadedMusic } from '../lib/plan-context.js';
import { planWithFallback } from '../lib/planning.js';
import { friendlyFailure } from '../lib/job-tracker.js';

const PLANNING_CONCURRENCY = 2;

/** Plans every edit of a generation (one per chosen style), then queues preview renders. */
export async function handleGenerateEdits(ctx: WorkerContext, run: TrackedRun, payload: { generationId: string; projectId: string }): Promise<void> {
  const generation = await ctx.db.query.generations.findFirst({ where: eq(schema.generations.id, payload.generationId) });
  if (!generation) throw new AppError('NOT_FOUND', 'This generation no longer exists');
  const setGeneration = (values: Partial<typeof schema.generations.$inferInsert>) =>
    ctx.db.update(schema.generations).set({ ...values, updatedAt: new Date() }).where(eq(schema.generations.id, generation.id));
  const setProjectStatus = (status: 'ready' | 'generating') =>
    ctx.db.update(schema.projects).set({ status, updatedAt: new Date() }).where(eq(schema.projects.id, payload.projectId));

  try {
    const footage = await loadProjectFootage(ctx, payload.projectId);
    if (!footage || footage.assets.length === 0) throw new AppError('UNSUPPORTED', 'No processed clips are available in this project yet.');
    const settings = await loadSettings(ctx);
    const music = await loadMusic(ctx, generation.settings.musicTrackId);
    if (generation.settings.musicTrackId && !music) {
      throw new AppError('UNSUPPORTED', 'The chosen music track is not ready yet. Wait for it to finish analysing, then generate again.');
    }

    await setGeneration({ status: 'planning', statusMessage: 'Planning the edits' });
    await setProjectStatus('generating');

    const edits = await ctx.db.query.edits.findMany({ where: eq(schema.edits.generationId, generation.id), orderBy: [asc(schema.edits.slot)] });
    const versionIds = edits.map((e) => e.currentVersionId).filter((v): v is string => Boolean(v));
    const versions = versionIds.length ? await ctx.db.query.editVersions.findMany({ where: inArray(schema.editVersions.id, versionIds) }) : [];
    const pending = edits
      .map((edit) => ({ edit, version: versions.find((v) => v.id === edit.currentVersionId) }))
      .filter((x): x is { edit: (typeof edits)[number]; version: EditVersion } => Boolean(x.version) && x.version!.status === 'planning');

    const support = new Map(evaluateStyleSupport(footage.analyses).map((s) => [s.styleId, s]));
    let planned = 0;
    let done = 0;
    const total = pending.length;

    const worker = async (item: { edit: (typeof edits)[number]; version: EditVersion }) => {
      const styleId = item.edit.styleId as StyleId;
      const sup = support.get(styleId);
      try {
        run.checkCancelled();
        if (sup && !sup.supported) throw new AppError('UNSUPPORTED', `${STYLES[styleId].name}: ${sup.reason}`);
        const input = buildPlannerInput({ styleId, settings: generation.settings, footage, music, appSettings: settings, attempt: 0 });
        const vctx = validationContextFor(footage, music, generation.settings.durationSec);
        const outcome = await planWithFallback(ctx.ai.planner, ctx.ai.rulesPlanner, input, vctx, ctx.logger, run.signal);
        for (const u of outcome.usages) await recordAiUsage(ctx, payload.projectId, `planning:${styleId}`, u);
        await ctx.db
          .update(schema.editVersions)
          .set({
            plan: outcome.plan,
            validation: { ok: true, errors: [], warnings: outcome.validation.warnings },
            planSource: outcome.source,
            plannerModel: outcome.model,
            status: 'planned',
            statusMessage: outcome.fallbackReason ? `Planned with the rules-based editor (${outcome.fallbackReason})` : 'Planned · rendering preview',
            updatedAt: new Date(),
          })
          .where(eq(schema.editVersions.id, item.version.id));
        await enqueueTracked(ctx, JOB_TYPES.RENDER_PREVIEW, { editVersionId: item.version.id, projectId: payload.projectId }, { singletonKey: `preview:${item.version.id}` });
        planned++;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        ctx.logger.error({ err, styleId }, 'planning failed');
        await ctx.db
          .update(schema.editVersions)
          .set({ status: 'failed', statusMessage: friendlyFailure(err), updatedAt: new Date() })
          .where(eq(schema.editVersions.id, item.version.id));
      } finally {
        done++;
        await run.progress(0.1 + 0.85 * (done / Math.max(1, total)), `Planned ${done} of ${total} edits`);
      }
    };

    await runPool(pending, PLANNING_CONCURRENCY, worker);

    if (planned === 0) {
      await setGeneration({ status: 'failed', statusMessage: 'None of the chosen styles could be built from this footage', plannerUsed: ctx.ai.planner.name });
      await setProjectStatus('ready');
      throw new AppError('PROCESSING_FAILED', 'None of the chosen styles could be built from this footage.');
    }
    await setGeneration({
      status: 'rendering',
      statusMessage: `${planned} edit${planned === 1 ? '' : 's'} planned, rendering previews`,
      plannerUsed: ctx.ai.planner.name,
    });
    await run.progress(1, 'Edits planned');
  } catch (err) {
    if (err instanceof CancelledError) {
      await setGeneration({ status: 'cancelled', statusMessage: 'Cancelled' });
      await ctx.db
        .update(schema.editVersions)
        .set({ status: 'cancelled', statusMessage: 'Cancelled', updatedAt: new Date() })
        .where(and(inArray(schema.editVersions.editId, (await ctx.db.query.edits.findMany({ columns: { id: true }, where: eq(schema.edits.generationId, generation.id) })).map((e) => e.id)), eq(schema.editVersions.status, 'planning')));
      await setProjectStatus('ready');
    } else if (!(err instanceof AppError && err.code === 'PROCESSING_FAILED')) {
      await setGeneration({ status: 'failed', statusMessage: friendlyFailure(err) });
      await setProjectStatus('ready');
    }
    throw err;
  }
}

/** Plans a new version of one edit from an instruction (revise) or a fresh take (regenerate). */
export async function handleReviseEdit(
  ctx: WorkerContext,
  run: TrackedRun,
  payload: { editId: string; projectId: string; newVersionId: string; mode: 'revise' | 'regenerate' },
): Promise<void> {
  const edit = await ctx.db.query.edits.findFirst({ where: eq(schema.edits.id, payload.editId) });
  if (!edit) throw new AppError('NOT_FOUND', 'This edit no longer exists');
  const version = await ctx.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, payload.newVersionId) });
  if (!version) throw new AppError('NOT_FOUND', 'The new version row is missing');
  const parent = version.parentVersionId ? await ctx.db.query.editVersions.findFirst({ where: eq(schema.editVersions.id, version.parentVersionId) }) : null;
  const generation = await ctx.db.query.generations.findFirst({ where: eq(schema.generations.id, edit.generationId) });
  if (!generation) throw new AppError('NOT_FOUND', 'The original generation is missing');
  const footage = await loadProjectFootage(ctx, payload.projectId);
  if (!footage || footage.assets.length === 0) throw new AppError('UNSUPPORTED', 'No processed clips are available in this project.');
  const settings = await loadSettings(ctx);
  const music = await loadMusic(ctx, generation.settings.musicTrackId);
  const styleId = edit.styleId as StyleId;

  const fail = async (message: string) =>
    ctx.db.update(schema.editVersions).set({ status: 'failed', statusMessage: message, updatedAt: new Date() }).where(eq(schema.editVersions.id, version.id));

  try {
    await run.progress(0.1, payload.mode === 'revise' ? 'Applying your changes' : 'Creating a fresh take');
    const previousPlan = parent?.plan ?? null;
    const hints: RevisionHints | undefined = payload.mode === 'revise' ? parseRevisionInstruction(version.instruction) : undefined;
    let targetDurationSec = generation.settings.durationSec;
    if (previousPlan) targetDurationSec = Math.round(computeTimeline(previousPlan).totalDurationSec) || targetDurationSec;
    if (hints?.targetDurationSec) {
      if (hints.targetDurationSec === -1) targetDurationSec = Math.max(8, Math.round(targetDurationSec * 0.75));
      else if (hints.targetDurationSec === -2) targetDurationSec = Math.min(90, Math.round(targetDurationSec * 1.3));
      else targetDurationSec = hints.targetDurationSec;
    }
    const attempt = payload.mode === 'regenerate' ? Math.max(1, version.versionNo - 1) : 0;
    const input = buildPlannerInput({
      styleId,
      settings: { ...generation.settings, durationSec: targetDurationSec },
      footage,
      music,
      appSettings: settings,
      attempt,
      ...(previousPlan ? { previousPlan } : {}),
      ...(payload.mode === 'revise' ? { revisionInstruction: version.instruction, revisionHints: hints } : {}),
    });
    const vctx = validationContextFor(footage, music, targetDurationSec, hints?.transitions === 'restrained' || hints?.transitions === 'none');
    const outcome = await planWithFallback(ctx.ai.planner, ctx.ai.rulesPlanner, input, vctx, ctx.logger, run.signal);
    for (const u of outcome.usages) await recordAiUsage(ctx, payload.projectId, `${payload.mode}:${styleId}`, u);
    await ctx.db
      .update(schema.editVersions)
      .set({
        plan: outcome.plan,
        validation: { ok: true, errors: [], warnings: outcome.validation.warnings },
        planSource: outcome.source,
        plannerModel: outcome.model,
        status: 'planned',
        statusMessage: outcome.fallbackReason ? `Planned with the rules-based editor (${outcome.fallbackReason})` : 'Planned · rendering preview',
        updatedAt: new Date(),
      })
      .where(eq(schema.editVersions.id, version.id));
    await enqueueTracked(ctx, JOB_TYPES.RENDER_PREVIEW, { editVersionId: version.id, projectId: payload.projectId }, { singletonKey: `preview:${version.id}` });
    await run.progress(1, 'New version planned');
  } catch (err) {
    if (err instanceof CancelledError) {
      await ctx.db.update(schema.editVersions).set({ status: 'cancelled', statusMessage: 'Cancelled', updatedAt: new Date() }).where(eq(schema.editVersions.id, version.id));
    } else {
      await fail(friendlyFailure(err));
    }
    throw err;
  }
}

export function validationContextFor(footage: LoadedFootage, music: LoadedMusic | null, targetDurationSec: number, restrainedTransitionsOnly = false): PlanValidationContext {
  return {
    assets: footage.planAssets,
    music: music ? { trackId: music.track.id, durationSec: music.durationSec } : null,
    transcripts: footage.transcripts,
    durationBounds: durationBoundsFor(targetDurationSec),
    restrainedTransitionsOnly,
  };
}

export function buildPlannerInput(args: {
  styleId: StyleId;
  settings: GenerationSettings;
  footage: LoadedFootage;
  music: LoadedMusic | null;
  appSettings: Awaited<ReturnType<typeof loadSettings>>;
  attempt: number;
  previousPlan?: EditPlan;
  revisionInstruction?: string;
  revisionHints?: RevisionHints | undefined;
}): PlannerInput {
  const { styleId, settings, footage, music, appSettings, attempt } = args;
  return {
    styleId,
    targetDurationSec: settings.durationSec,
    analyses: footage.analyses,
    assets: footage.planAssets,
    music: music ? { trackId: music.track.id, durationSec: music.durationSec, bpm: music.bpm, beatTimesSec: music.beatTimesSec, title: music.track.title } : null,
    preferences: appSettings.preferences,
    brand: appSettings.brand,
    businessName: appSettings.brand.businessName,
    instructions: settings.instructions,
    keepOriginalSound: settings.keepOriginalSound,
    captions: settings.captions,
    attempt,
    ...(args.previousPlan ? { previousPlan: args.previousPlan } : {}),
    ...(args.revisionInstruction ? { revisionInstruction: args.revisionInstruction } : {}),
    ...(args.revisionHints ? { revisionHints: args.revisionHints } : {}),
  };
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
