import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type Anthropic from '@anthropic-ai/sdk';
import { AppError, CancelledError, EDIT_PLAN_VERSION, VERTICAL_1080 } from '@studio/core';
import type { Logger } from 'pino';
import { DEFAULT_MODEL_RATES, type RateTable } from '../pricing.js';
import { effectiveSettings } from '../rules/settings.js';
import type { AiCallOptions, EditPlanner, PlannerInput, PlannerResult } from '../types.js';
import { mapAnthropicError, usageFrom, type AnthropicMessagesClient, type StructuredResponse } from './client.js';
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserContent } from './prompts.js';
import { PlannerWireSchema, type PlannerWire } from './schemas.js';

/** Output limit for a planning call (fits the SDK's non-streaming limit). */
export const PLANNER_MAX_TOKENS = 16_000;
/** Second attempt when the first reply was cut off; sent as a stream (required by the SDK at this size). */
export const PLANNER_RETRY_MAX_TOKENS = 32_000;

/** Settings for AnthropicPlanner. */
export interface AnthropicPlannerOptions {
  client: AnthropicMessagesClient;
  model: string;
  effort: 'low' | 'medium' | 'high';
  logger?: Logger;
  rates?: RateTable;
}

/**
 * Edit planner backed by Claude with structured output. It returns the model's plan unvalidated; the caller
 * validates it against the real footage and calls again with `previousErrors` to repair (see planWithRepair).
 * Sampling parameters and thinking settings are left at the model's defaults (adaptive thinking).
 */
export class AnthropicPlanner implements EditPlanner {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly effort: AnthropicPlannerOptions['effort'];
  private readonly logger: Logger | undefined;
  private readonly rates: RateTable;

  constructor(opts: AnthropicPlannerOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.effort = opts.effort;
    this.logger = opts.logger;
    this.rates = opts.rates ?? DEFAULT_MODEL_RATES;
  }

  /** Builds the request body for a planning call (exposed for tests and debugging). */
  buildRequest(input: PlannerInput, maxTokens: number = PLANNER_MAX_TOKENS): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: PLANNER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildPlannerUserContent(input) }],
      output_config: { format: zodOutputFormat(PlannerWireSchema), effort: this.effort },
    };
  }

  /** Asks the model for a plan; maps refusals and API failures to AppErrors the worker understands. */
  async planEdit(input: PlannerInput, opts: AiCallOptions = {}): Promise<PlannerResult> {
    const signal = opts.signal;
    if (signal?.aborted) throw new CancelledError();
    const started = Date.now();
    const responses: StructuredResponse[] = [];
    try {
      let res = await this.client.messages.parse(this.buildRequest(input), signal ? { signal } : {});
      responses.push(res);
      if (res.stop_reason === 'max_tokens') {
        this.logger?.warn({ styleId: input.styleId, model: this.model }, 'planner reply hit max_tokens; retrying with a larger limit');
        res = await this.client.messages.stream(this.buildRequest(input, PLANNER_RETRY_MAX_TOKENS), signal ? { signal } : {}).finalMessage();
        responses.push(res);
      }
      const usage = usageFrom(responses, this.model, Date.now() - started, this.rates);
      if (res.stop_reason === 'refusal') {
        const reason = res.stop_details?.explanation?.trim();
        throw new AppError('UNSUPPORTED', reason ? `The AI planner declined this request: ${reason}` : 'The AI planner declined this request.', {
          details: { usage, category: res.stop_details?.category ?? null },
        });
      }
      if (res.stop_reason === 'max_tokens') {
        throw new AppError('PROCESSING_FAILED', 'The AI plan was too long to finish. A simpler edit will be created instead.', { details: { usage } });
      }
      const parsed = PlannerWireSchema.safeParse(res.parsed_output);
      if (!parsed.success) {
        throw new AppError('PROCESSING_FAILED', 'The AI planner returned an unreadable plan.', { details: { usage } });
      }
      this.logger?.debug({ styleId: input.styleId, usage }, 'planner reply received');
      return { plan: toPlanCandidate(parsed.data, input), usage, source: 'ai' };
    } catch (err) {
      throw mapAnthropicError(err, 'plan this edit', signal);
    }
  }
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * Turns the model's wire output into an EditPlan-shaped object. Only fields the model does not decide are set
 * here (version, output format, target, style, the real music track id); everything else is passed through
 * for validateEditPlan to judge, so a mistake becomes a repairable validation error rather than a silent fix.
 */
export function toPlanCandidate(wire: PlannerWire, input: PlannerInput): unknown {
  const s = effectiveSettings(input);
  const music = input.music && s.musicOn && wire.audio.music ? { ...wire.audio.music, trackId: input.music.trackId } : null;
  return {
    version: EDIT_PLAN_VERSION,
    styleId: input.styleId,
    title: cut(wire.title.trim() || 'Edit', 80),
    description: cut(wire.description.trim() || wire.title.trim() || 'Edit', 280),
    rationale: cut(wire.rationale, 2000),
    output: VERTICAL_1080,
    targetDurationSec: Math.min(90, Math.max(5, s.target)),
    segments: wire.segments,
    textOverlays: wire.textOverlays,
    captions: wire.captions,
    audio: { ...wire.audio, music },
    colourPreset: wire.colourPreset,
  };
}
