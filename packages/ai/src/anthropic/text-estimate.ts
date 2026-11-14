import { readFile } from 'node:fs/promises';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type Anthropic from '@anthropic-ai/sdk';
import { CancelledError } from '@studio/core';
import type { Logger } from 'pino';
import { z } from 'zod';
import { DEFAULT_MODEL_RATES, type RateTable } from '../pricing.js';
import type { AiCallOptions, AiUsage } from '../types.js';
import { mapAnthropicError, usageFrom, type AnthropicMessagesClient, type StructuredResponse } from './client.js';

/** Frames sent per reference video at most (preferences design §8.3). */
export const TEXT_ESTIMATE_MAX_FRAMES = 8;
/** Frames smaller than this on their short edge are not sent (memo §10). */
export const TEXT_ESTIMATE_MIN_EDGE_PX = 200;
const TEXT_ESTIMATE_MAX_TOKENS = 2_000;

/** The system prompt: whether added text is visible, never what it says, never who is in the frame (memo §10). */
export const TEXT_ESTIMATE_SYSTEM_PROMPT =
  'You look at still frames from a short vertical video. Say only whether added on-screen text (titles, captions, stickers) is visible in each frame and roughly how much of the frame it covers. Do not read out or transcribe the text. Do not identify or describe people.';

/** Structured answer (every property required; enums compared after parsing). */
export const TextEstimateWireSchema = z.object({
  frames: z.array(z.object({ index: z.number().int(), hasOnScreenText: z.boolean(), coverage: z.enum(['none', 'small', 'large']) })),
});
export type TextEstimateWire = z.infer<typeof TextEstimateWireSchema>;

/** One JPEG still to check. */
export interface TextEstimateFrame {
  jpegPath: string;
  width: number;
  height: number;
}

/** How many frames were checked and how many showed added text; null when the estimate could not be made. */
export interface TextEstimateResult {
  measurement: { framesChecked: number; framesWithText: number } | null;
  usage: AiUsage | null;
}

/** Estimates how much added on-screen text a reference video has. Present only when AI is configured. */
export interface OnScreenTextEstimator {
  name: string;
  model: string;
  estimateOnScreenText(frames: TextEstimateFrame[], opts?: AiCallOptions): Promise<TextEstimateResult>;
}

/** Settings for {@link AnthropicTextEstimator}. */
export interface AnthropicTextEstimatorOptions {
  client: AnthropicMessagesClient;
  model: string;
  logger?: Logger;
  rates?: RateTable;
}

/**
 * On-screen text estimate with a vision model (`AI_VISION_MODEL`, effort low, structured output). Up to eight base64
 * JPEG frames, each with `transformations: { oversized_image: 'error' }` so nothing is silently downscaled. A refusal,
 * running out of tokens or an unreadable answer gives `measurement: null` ("not measured"); nothing is ever guessed.
 */
export class AnthropicTextEstimator implements OnScreenTextEstimator {
  readonly name = 'anthropic-text-estimate';
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly logger: Logger | undefined;
  private readonly rates: RateTable;

  constructor(opts: AnthropicTextEstimatorOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.logger = opts.logger;
    this.rates = opts.rates ?? DEFAULT_MODEL_RATES;
  }

  /** Builds the request (exposed for tests). Frames that cannot be read or are too small are left out. */
  async buildRequest(frames: TextEstimateFrame[]): Promise<{ request: Anthropic.MessageCreateParamsNonStreaming; sent: number }> {
    const images: string[] = [];
    for (const frame of frames.slice(0, TEXT_ESTIMATE_MAX_FRAMES)) {
      if (Math.min(frame.width, frame.height) < TEXT_ESTIMATE_MIN_EDGE_PX) continue;
      try {
        images.push((await readFile(frame.jpegPath)).toString('base64'));
      } catch (err) {
        this.logger?.warn({ err }, 'reference frame could not be read; skipping it');
      }
    }
    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: `There are ${images.length} frames. Answer once per frame, using its number as index.` }];
    images.forEach((data, i) => {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data }, transformations: { oversized_image: 'error' } });
      content.push({ type: 'text', text: `Frame ${i + 1}` });
    });
    return {
      sent: images.length,
      request: {
        model: this.model,
        max_tokens: TEXT_ESTIMATE_MAX_TOKENS,
        system: [{ type: 'text', text: TEXT_ESTIMATE_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(TextEstimateWireSchema), effort: 'low' },
      },
    };
  }

  async estimateOnScreenText(frames: TextEstimateFrame[], opts: AiCallOptions = {}): Promise<TextEstimateResult> {
    const signal = opts.signal;
    if (signal?.aborted) throw new CancelledError();
    const { request, sent } = await this.buildRequest(frames);
    if (sent === 0) return { measurement: null, usage: null };
    const started = Date.now();
    let res: StructuredResponse;
    try {
      res = await this.client.messages.parse(request, signal ? { signal } : {});
    } catch (err) {
      throw mapAnthropicError(err, 'estimate the on-screen text', signal);
    }
    const usage = usageFrom([res], this.model, Date.now() - started, this.rates);
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return { measurement: null, usage };
    const parsed = TextEstimateWireSchema.safeParse(res.parsed_output);
    if (!parsed.success) return { measurement: null, usage };
    const byIndex = new Map<number, boolean>();
    for (const f of parsed.data.frames) if (f.index >= 1 && f.index <= sent) byIndex.set(f.index, f.hasOnScreenText && f.coverage !== 'none');
    // Every frame must be answered; a partial answer is not a measurement.
    if (byIndex.size !== sent) return { measurement: null, usage };
    return { measurement: { framesChecked: sent, framesWithText: [...byIndex.values()].filter(Boolean).length }, usage };
  }
}
