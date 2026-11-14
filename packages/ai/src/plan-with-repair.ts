import { AppError, CancelledError, errorMessage, type EditPlan, type PlanIssue, type PlanValidationResult } from '@studio/core';
import type { AiUsage, EditPlanner, PlannerInput } from './types.js';

/** Options for planWithRepair. */
export interface PlanWithRepairOptions {
  /** How many times the primary planner may be asked to fix its own plan (default 2). */
  maxRepairs?: number;
  signal?: AbortSignal;
}

/** A validated plan and how it was obtained. */
export interface PlanWithRepairOutcome {
  plan: EditPlan;
  validation: PlanValidationResult;
  source: 'ai' | 'rules';
  model: string | null;
  usages: AiUsage[];
  attempts: number;
  /** Plain-language reason the fallback planner was used, or null when the primary plan was accepted. */
  fallbackReason: string | null;
}

/**
 * The planning policy: ask the primary planner, validate the result against the real footage, feed validation
 * errors back for repair up to `maxRepairs` times, then fall back to the deterministic planner. Configuration,
 * refusal and rate-limit errors skip straight to the fallback; cancellation is rethrown. Only a validated plan
 * is ever returned. (The worker runs an equivalent loop in apps/worker/src/lib/planning.ts.)
 */
export async function planWithRepair(
  primary: EditPlanner,
  fallback: EditPlanner,
  input: PlannerInput,
  validate: (plan: unknown) => PlanValidationResult,
  opts: PlanWithRepairOptions = {},
): Promise<PlanWithRepairOutcome> {
  const maxRepairs = opts.maxRepairs ?? 2;
  const signal = opts.signal;
  const callOpts = signal ? { signal } : {};
  const usages: AiUsage[] = [];
  let attempts = 0;
  let previousErrors: PlanIssue[] | undefined;
  let fallbackReason: string | null = null;

  if (primary !== fallback) {
    for (let repair = 0; repair <= maxRepairs; repair++) {
      if (signal?.aborted) throw new CancelledError();
      attempts++;
      try {
        const res = await primary.planEdit(previousErrors ? { ...input, previousErrors } : input, callOpts);
        if (res.usage) usages.push(res.usage);
        const validation = validate(res.plan);
        if (validation.ok && validation.plan) {
          return { plan: validation.plan, validation, source: res.source, model: primary.model, usages, attempts, fallbackReason: null };
        }
        previousErrors = validation.errors;
      } catch (err) {
        if (err instanceof CancelledError || signal?.aborted) throw err;
        fallbackReason = errorMessage(err);
        if (err instanceof AppError && (err.code === 'UNSUPPORTED' || err.code === 'INTEGRATION_NOT_CONFIGURED' || err.code === 'RATE_LIMITED')) break;
      }
    }
    fallbackReason ??= 'The AI planner could not produce a valid edit for this footage, so a rules-based edit was created instead.';
  }

  attempts++;
  const res = await fallback.planEdit(input, callOpts);
  if (res.usage) usages.push(res.usage);
  const validation = validate(res.plan);
  if (!validation.ok || !validation.plan) {
    throw new AppError('PROCESSING_FAILED', 'This style could not be built from the footage.', { details: { errors: validation.errors } });
  }
  return { plan: validation.plan, validation, source: res.source, model: fallback.model, usages, attempts, fallbackReason };
}
