import { AppError, CancelledError, errorMessage, validateEditPlan, type EditPlan, type PlanIssue, type PlanValidationContext, type PlanValidationResult } from '@studio/core';
import type { AiUsage, EditPlanner, PlannerInput } from '@studio/ai';
import type { Logger } from 'pino';

export interface PlanOutcome {
  plan: EditPlan;
  validation: PlanValidationResult;
  source: 'ai' | 'rules';
  model: string | null;
  usages: AiUsage[];
  attempts: number;
  /** Set when the primary planner failed and the rules planner produced the result. */
  fallbackReason: string | null;
}

const MAX_REPAIRS = 2;

/**
 * Asks the configured planner for a plan, validates it against the real footage, feeds validation errors
 * back for repair (up to MAX_REPAIRS), and falls back to the deterministic rules planner when the primary
 * planner is unavailable or keeps producing invalid plans. The renderer only ever sees a validated plan.
 */
export async function planWithFallback(
  primary: EditPlanner,
  fallback: EditPlanner,
  input: PlannerInput,
  ctx: PlanValidationContext,
  logger: Logger,
  signal: AbortSignal,
): Promise<PlanOutcome> {
  const usages: AiUsage[] = [];
  let attempts = 0;
  let previousErrors: PlanIssue[] | undefined;
  let fallbackReason: string | null = null;

  if (primary !== fallback) {
    for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
      if (signal.aborted) throw new CancelledError();
      attempts++;
      try {
        const res = await primary.planEdit({ ...input, ...(previousErrors ? { previousErrors } : {}) }, { signal });
        if (res.usage) usages.push(res.usage);
        const validation = validateEditPlan(res.plan, ctx);
        if (validation.ok && validation.plan) {
          return { plan: validation.plan, validation, source: res.source, model: primary.model, usages, attempts, fallbackReason: null };
        }
        previousErrors = validation.errors;
        logger.warn({ styleId: input.styleId, repair, errors: validation.errors.map((e) => e.code) }, 'planner output failed validation; requesting repair');
      } catch (err) {
        if (err instanceof CancelledError || signal.aborted) throw err;
        if (err instanceof AppError && (err.code === 'UNSUPPORTED' || err.code === 'INTEGRATION_NOT_CONFIGURED' || err.code === 'RATE_LIMITED')) {
          fallbackReason = err.message;
          logger.warn({ err, styleId: input.styleId }, 'primary planner unavailable; using rules planner');
          break;
        }
        fallbackReason = errorMessage(err);
        logger.error({ err, styleId: input.styleId, repair }, 'primary planner error');
        if (repair === MAX_REPAIRS) break;
      }
    }
    if (!fallbackReason) fallbackReason = 'The AI planner could not produce a valid edit for this footage; a rules-based edit was created instead.';
  }

  attempts++;
  const res = await fallback.planEdit(input, { signal });
  if (res.usage) usages.push(res.usage);
  const validation = validateEditPlan(res.plan, ctx);
  if (!validation.ok || !validation.plan) {
    throw new AppError('PROCESSING_FAILED', `This style could not be built from the footage: ${validation.errors.map((e) => e.message).join('; ')}`);
  }
  return { plan: validation.plan, validation, source: 'rules', model: null, usages, attempts, fallbackReason };
}
