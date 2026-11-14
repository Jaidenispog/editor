import { readFile } from 'node:fs/promises';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type Anthropic from '@anthropic-ai/sdk';
import { AppError, CancelledError, SEGMENT_LABELS, type SegmentLabel } from '@studio/core';
import type { Logger } from 'pino';
import { DEFAULT_MODEL_RATES, type RateTable } from '../pricing.js';
import type { AiCallOptions, FrameForLabelling, LabelShotsInput, LabelShotsResult, ShotFraming, ShotLabelResult, VisionLabeler } from '../types.js';
import { mapAnthropicError, usageFrom, type AnthropicMessagesClient, type StructuredResponse } from './client.js';
import { LABELER_SYSTEM_PROMPT, buildLabelerIntro } from './prompts.js';
import { FRAMING_VALUES, LabelWireSchema, type LabelWire } from './schemas.js';

/** Frames per request (well inside the API's image limits and cheap to retry). */
export const MAX_FRAMES_PER_REQUEST = 16;
const LABELER_MAX_TOKENS = 8_000;
/** "before" and "reaction" decide which styles are offered, so they need a clear sighting. */
const SENSITIVE_LABELS: readonly SegmentLabel[] = ['before', 'reaction'];
const SENSITIVE_MIN_CONFIDENCE = 0.75;
const MIN_CONFIDENCE = 0.3;
const MAX_DESCRIPTION_WORDS = 20;

/** Settings for AnthropicVisionLabeler. */
export interface AnthropicVisionLabelerOptions {
  client: AnthropicMessagesClient;
  model: string;
  logger?: Logger;
  rates?: RateTable;
  /** Effort for labelling; low keeps bulk labelling cheap. */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Shot labeller backed by a vision-capable Claude model. Frames go in batches of up to 16 (image block, then
 * "Frame i: shot …, t=…s"), the reply is structured output, and results are merged per shot keeping the most
 * confident one. Uncertain "before"/"reaction" labels are downgraded to "unknown" so no style is unlocked by a guess.
 */
export class AnthropicVisionLabeler implements VisionLabeler {
  readonly name = 'anthropic-vision';
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly logger: Logger | undefined;
  private readonly rates: RateTable;
  private readonly effort: 'low' | 'medium' | 'high';

  constructor(opts: AnthropicVisionLabelerOptions) {
    this.client = opts.client;
    this.model = opts.model;
    this.logger = opts.logger;
    this.rates = opts.rates ?? DEFAULT_MODEL_RATES;
    this.effort = opts.effort ?? 'low';
  }

  /** Builds the request for one batch of frames (exposed for tests). */
  async buildRequest(frames: FrameForLabelling[], context: LabelShotsInput['context'], maxTokens = LABELER_MAX_TOKENS): Promise<Anthropic.MessageCreateParamsNonStreaming> {
    const images: Array<{ frame: FrameForLabelling; data: string }> = [];
    for (const frame of frames) {
      try {
        images.push({ frame, data: (await readFile(frame.jpegPath)).toString('base64') });
      } catch (err) {
        // A missing frame only costs that shot its label; the rest of the batch is still useful.
        this.logger?.warn({ err, shotId: frame.shotId }, 'sampled frame could not be read; skipping it');
      }
    }
    if (images.length === 0) throw new AppError('PROCESSING_FAILED', 'The sampled frames could not be read for shot identification.');
    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: buildLabelerIntro(context, images.length) }];
    for (const [i, { frame, data }] of images.entries()) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      content.push({ type: 'text', text: `Frame ${i + 1}: shot ${frame.shotId}, t=${frame.timeSec.toFixed(2)}s` });
    }
    return {
      model: this.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: LABELER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(LabelWireSchema), effort: this.effort },
    };
  }

  /** Labels every shot that has a frame; shots the model does not answer for are simply left out. */
  async labelShots(input: LabelShotsInput, opts: AiCallOptions = {}): Promise<LabelShotsResult> {
    const signal = opts.signal;
    if (input.frames.length === 0) return { results: [], usage: null };
    const started = Date.now();
    const responses: StructuredResponse[] = [];
    const best = new Map<string, ShotLabelResult>();
    try {
      for (let i = 0; i < input.frames.length; i += MAX_FRAMES_PER_REQUEST) {
        if (signal?.aborted) throw new CancelledError();
        const batch = input.frames.slice(i, i + MAX_FRAMES_PER_REQUEST);
        let res = await this.client.messages.parse(await this.buildRequest(batch, input.context), signal ? { signal } : {});
        responses.push(res);
        if (res.stop_reason === 'max_tokens') {
          res = await this.client.messages.parse(await this.buildRequest(batch, input.context, LABELER_MAX_TOKENS * 2), signal ? { signal } : {});
          responses.push(res);
        }
        if (res.stop_reason === 'refusal') {
          throw new AppError('UNSUPPORTED', 'The vision model declined to describe these frames.', { details: { category: res.stop_details?.category ?? null } });
        }
        const parsed = LabelWireSchema.safeParse(res.parsed_output);
        if (!parsed.success) throw new AppError('PROCESSING_FAILED', 'The vision model returned an unreadable answer.');
        const allowed = new Set(batch.map((f) => f.shotId));
        for (const r of normaliseLabels(parsed.data, allowed)) {
          const prev = best.get(r.shotId);
          if (!prev || r.confidence > prev.confidence) best.set(r.shotId, r);
        }
      }
    } catch (err) {
      throw mapAnthropicError(err, 'identify the shots', signal);
    }
    const usage = usageFrom(responses, this.model, Date.now() - started, this.rates);
    this.logger?.debug({ frames: input.frames.length, shots: best.size, usage }, 'vision labelling done');
    return { results: [...best.values()], usage };
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Cleans the model's answer: only shots that were asked about, confidence and focus clamped to 0–1, short
 * descriptions and issues, and low-confidence labels (or unsure before/reaction) turned into "unknown".
 */
export function normaliseLabels(wire: LabelWire, allowedShotIds: ReadonlySet<string>): ShotLabelResult[] {
  const out: ShotLabelResult[] = [];
  for (const f of wire.frames) {
    if (!allowedShotIds.has(f.shotId)) continue;
    const confidence = clamp01(f.confidence);
    let label: SegmentLabel = (SEGMENT_LABELS as readonly string[]).includes(f.label) ? (f.label as SegmentLabel) : 'unknown';
    if (confidence < MIN_CONFIDENCE) label = 'unknown';
    if (SENSITIVE_LABELS.includes(label) && confidence < SENSITIVE_MIN_CONFIDENCE) label = 'unknown';
    const words = f.description.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const description = words.slice(0, MAX_DESCRIPTION_WORDS).join(' ').slice(0, 400);
    out.push({
      shotId: f.shotId,
      label,
      confidence: label === 'unknown' ? 0 : Math.round(confidence * 1000) / 1000,
      description,
      framing: (FRAMING_VALUES as readonly string[]).includes(f.framing) ? (f.framing as ShotFraming) : 'unknown',
      focus: f.focus ? { x: clamp01(f.focus.x), y: clamp01(f.focus.y) } : null,
      issues: f.issues.map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 6),
    });
  }
  return out;
}
