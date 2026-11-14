import Anthropic from '@anthropic-ai/sdk';
import { AppError, CancelledError } from '@studio/core';
import { DEFAULT_MODEL_RATES, estimateCost, type RateTable } from '../pricing.js';
import type { AiUsage } from '../types.js';

/** The parts of a Messages API response this package reads (structurally matches the SDK's ParsedMessage). */
export interface StructuredResponse {
  parsed_output?: unknown;
  stop_reason: string | null;
  stop_details?: { explanation?: string | null; category?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * The slice of the Anthropic client used here: `messages.parse` for structured output and `messages.stream`
 * for the long retry (the SDK refuses non-streaming requests whose max_tokens implies more than ten minutes).
 * Tests inject a fake with the same shape; production passes the real client from `createAnthropicClient`.
 */
export interface AnthropicMessagesClient {
  messages: {
    parse(params: Anthropic.MessageCreateParamsNonStreaming, options?: RequestOptions): PromiseLike<StructuredResponse>;
    stream(params: Anthropic.MessageStreamParams, options?: RequestOptions): { finalMessage(): Promise<StructuredResponse> };
  };
}

/** Creates the real SDK client (it retries 429/5xx and connection errors twice by default). */
export function createAnthropicClient(apiKey: string, opts: { maxRetries?: number; timeoutMs?: number } = {}): AnthropicMessagesClient {
  return new Anthropic({ apiKey, maxRetries: opts.maxRetries ?? 2, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
}

/**
 * Maps SDK errors (most specific first) to the app's error codes with plain messages. Aborts become
 * CancelledError so the job tracker records a cancellation rather than a failure.
 */
export function mapAnthropicError(err: unknown, task: string, signal?: AbortSignal): Error {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) return new CancelledError();
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError('INTEGRATION_NOT_CONFIGURED', 'The Anthropic API key was not accepted. Check the AI settings.', { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError('RATE_LIMITED', 'The AI service is busy right now. Please try again in a few minutes.', { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError('PROCESSING_FAILED', `The AI service could not ${task} with this request.`, { cause: err, details: { status: err.status, type: err.type } });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError('PROCESSING_FAILED', 'The AI service could not be reached. Please try again shortly.', { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError('PROCESSING_FAILED', `The AI service could not ${task} right now. Please try again shortly.`, { cause: err, details: { status: err.status } });
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Raised by the structured-output helper when the reply does not match the schema.
    return new AppError('PROCESSING_FAILED', `The AI service returned an unreadable answer while trying to ${task}.`, { cause: err });
  }
  return new AppError('PROCESSING_FAILED', `Something went wrong while asking the AI service to ${task}.`, { cause: err });
}

/** Sums the usage of one or more responses into an AiUsage record with an estimated cost. */
export function usageFrom(responses: StructuredResponse[], model: string, durationMs: number, rates: RateTable = DEFAULT_MODEL_RATES): AiUsage {
  const counts = responses.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + (r.usage.input_tokens ?? 0),
      outputTokens: acc.outputTokens + (r.usage.output_tokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (r.usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (r.usage.cache_creation_input_tokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  return { provider: 'anthropic', model, ...counts, durationMs: Math.round(durationMs), estimatedCostUsdCents: estimateCost(counts, model, rates).estimatedCostUsdCents };
}
