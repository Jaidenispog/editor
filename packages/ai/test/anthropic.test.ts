import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, SEGMENT_LABELS, TRANSITION_TYPES, validateEditPlan } from '@studio/core';
import { AnthropicPlanner, PLANNER_RETRY_MAX_TOKENS } from '../src/anthropic/planner.js';
import { AnthropicVisionLabeler } from '../src/anthropic/labeler.js';
import type { AnthropicMessagesClient, StructuredResponse } from '../src/anthropic/client.js';
import { LabelWireSchema, PlannerWireSchema } from '../src/anthropic/schemas.js';
import { RulesPlanner } from '../src/rules/planner.js';
import type { FrameForLabelling } from '../src/types.js';
import { ASSET_A, ASSET_B, clickTrack, labelledProject, plannerInput } from './fixtures.js';

type Params = Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageStreamParams;

/** A stand-in for the SDK client: records every request and replays canned responses. */
function fakeClient(replies: Array<StructuredResponse | Error>, streamReplies: Array<StructuredResponse | Error> = []) {
  const calls: Array<{ kind: 'parse' | 'stream'; params: Params; options?: { signal?: AbortSignal } }> = [];
  const next = (queue: Array<StructuredResponse | Error>) => {
    const r = queue.shift();
    if (!r) throw new Error('no fake reply left');
    if (r instanceof Error) throw r;
    return r;
  };
  const client: AnthropicMessagesClient = {
    messages: {
      parse: async (params, options) => {
        calls.push({ kind: 'parse', params, ...(options ? { options } : {}) });
        return next(replies);
      },
      stream: (params, options) => {
        calls.push({ kind: 'stream', params, ...(options ? { options } : {}) });
        return { finalMessage: async () => next(streamReplies) };
      },
    },
  };
  return { client, calls };
}

function reply(parsed: unknown, stop: string = 'end_turn', usage: Partial<StructuredResponse['usage']> = {}): StructuredResponse {
  return {
    parsed_output: parsed,
    stop_reason: stop,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, ...usage },
  };
}

/** A real, valid plan in the wire shape (built by the rules planner, minus the fields the code fills in). */
function wirePlanFor(input: ReturnType<typeof plannerInput>) {
  const plan = new RulesPlanner().plan(input);
  const { version: _v, output: _o, targetDurationSec: _t, ...wire } = plan;
  return PlannerWireSchema.parse(wire);
}

describe('structured-output schemas', () => {
  it('compile with the SDK helper', () => {
    expect(() => zodOutputFormat(PlannerWireSchema)).not.toThrow();
    expect(() => zodOutputFormat(LabelWireSchema)).not.toThrow();
    const planner = zodOutputFormat(PlannerWireSchema);
    expect(planner.type).toBe('json_schema');
    const text = JSON.stringify(planner.schema);
    // Allowed values reach the model through the descriptions (the helper keeps no enum keyword).
    for (const t of TRANSITION_TYPES) expect(text).toContain(t);
    for (const l of SEGMENT_LABELS) expect(JSON.stringify(zodOutputFormat(LabelWireSchema).schema)).toContain(l);
  });

  it('accept an off-list value instead of failing the whole reply', () => {
    const format = zodOutputFormat(LabelWireSchema);
    const parsed = format.parse(JSON.stringify({ frames: [{ shotId: 'x', label: 'haircut', confidence: 0.9, description: '', framing: 'tight', focus: null, issues: [] }] }));
    expect(parsed.frames[0]!.label).toBe('haircut');
  });
});

describe('AnthropicPlanner', () => {
  const input = plannerInput(labelledProject(), { styleId: 'cinematic_reveal', targetDurationSec: 20 });

  it('builds a cached, structured request without sampling or thinking overrides', () => {
    const { client } = fakeClient([]);
    const req = new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'high' }).buildRequest(input);
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.max_tokens).toBe(16000);
    const system = req.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.text).toMatch(/Never invent a before shot/);
    expect(req.output_config?.effort).toBe('high');
    expect(req.output_config?.format?.type).toBe('json_schema');
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools']) expect(req).not.toHaveProperty(key);
    const content = req.messages[0]!.content as Anthropic.TextBlockParam[];
    const job = JSON.parse(content[0]!.text.replace(/^Job description \(JSON\):\n/, ''));
    expect(job.style.id).toBe('cinematic_reveal');
    expect(job.target.durationSec).toBe(20);
    expect(job.shots.length).toBeGreaterThan(5);
    expect(job.shots.length).toBeLessThanOrEqual(60);
    expect(job.transcripts[0].assetId).toBe(ASSET_B);
    expect(job.constraints.allowedTransitions).toEqual(['dissolve', 'fadeblack']);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
  });

  it("passes the owner's music start as a fixed, beat-snapped constraint and keeps it in the plan", async () => {
    const music = clickTrack();
    const withStart = plannerInput(labelledProject(), { styleId: 'cinematic_reveal', targetDurationSec: 20, music, musicStartSec: 7.2 });
    const { client } = fakeClient([]);
    const req = new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).buildRequest(withStart);
    const content = req.messages[0]!.content as Anthropic.TextBlockParam[];
    const job = JSON.parse(content[0]!.text.replace(/^Job description \(JSON\):\n/, ''));
    expect(job.music.fixedStartOffsetSec).toBe(7.55);
    expect((req.system as Anthropic.TextBlockParam[])[0]!.text).toMatch(/fixedStartOffsetSec/);

    const wire = wirePlanFor(withStart);
    wire.audio = { ...wire.audio, music: { ...wire.audio.music!, startOffsetSec: 2 } };
    const { client: replying } = fakeClient([reply(wire)]);
    const res = await new AnthropicPlanner({ client: replying, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(withStart);
    expect((res.plan as { audio: { music: { startOffsetSec: number } } }).audio.music.startOffsetSec).toBe(7.55);

    const auto = new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).buildRequest({ ...withStart, musicStartSec: null });
    const autoJob = JSON.parse((auto.messages[0]!.content as Anthropic.TextBlockParam[])[0]!.text.replace(/^Job description \(JSON\):\n/, ''));
    expect(autoJob.music).not.toHaveProperty('fixedStartOffsetSec');
  });

  it('returns the parsed plan with usage and cost', async () => {
    const wire = wirePlanFor(input);
    const { client, calls } = fakeClient([reply(wire)]);
    const planner = new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' });
    const controller = new AbortController();
    const res = await planner.planEdit(input, { signal: controller.signal });
    expect(res.source).toBe('ai');
    expect(calls[0]!.options?.signal).toBe(controller.signal);
    const validation = validateEditPlan(res.plan, {
      assets: input.assets,
      music: null,
      transcripts: { [ASSET_B]: input.analyses[1]!.transcript!.segments },
      durationBounds: { min: 17, max: 23 },
    });
    expect(validation.errors).toEqual([]);
    expect(res.usage).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 });
    // (1000×4 + 500×20 + 2000×0.2 + 100×5) / 1e6 USD = 0.0149 USD = 1.49 cents
    expect(res.usage!.estimatedCostUsdCents).toBeCloseTo(1.49, 6);
  });

  it('forces the job facts the model does not decide', async () => {
    const wire = { ...wirePlanFor(input), styleId: 'beat_montage' as const, title: 'x'.repeat(120) };
    wire.audio = { ...wire.audio, music: { trackId: 'made-up', startOffsetSec: 0, volume: 0.8, fadeInSec: 0.3, fadeOutSec: 1, duckUnderOriginal: true } };
    const { client } = fakeClient([reply(wire)]);
    const res = await new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input);
    const plan = res.plan as { styleId: string; title: string; version: number; audio: { music: unknown }; output: { width: number } };
    expect(plan.styleId).toBe('cinematic_reveal');
    expect(plan.version).toBe(1);
    expect(plan.output.width).toBe(1080);
    expect(plan.title.length).toBeLessThanOrEqual(80);
    expect(plan.audio.music).toBeNull();
  });

  it('includes the validator errors and the revision in a repair request', () => {
    const { client } = fakeClient([]);
    const previousPlan = new RulesPlanner().plan(input);
    const req = new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).buildRequest({
      ...input,
      previousPlan,
      revisionInstruction: 'Make this 15 seconds',
      previousErrors: [{ code: 'DURATION_OUT_OF_RANGE', message: 'Edit runs 21.0s; it must be between 14s and 16s' }],
    });
    const content = req.messages[0]!.content as Anthropic.TextBlockParam[];
    const job = JSON.parse(content[0]!.text.replace(/^Job description \(JSON\):\n/, ''));
    expect(job.fixThese[0].code).toBe('DURATION_OUT_OF_RANGE');
    expect(job.revision.request).toBe('Make this 15 seconds');
    expect(job.revision.parsedHints.targetDurationSec).toBe(15);
    expect(job.target.durationSec).toBe(15);
    expect(job.revision.previousPlan.segments.length).toBe(previousPlan.segments.length);
    expect(content[1]!.text).toMatch(/failed validation/);
  });

  it('turns a refusal into UNSUPPORTED with the explanation', async () => {
    const refusal: StructuredResponse = { ...reply(null, 'refusal'), stop_details: { category: 'general_harms', explanation: 'This request is outside what I can help with.' } };
    const { client } = fakeClient([refusal]);
    const err = await new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('UNSUPPORTED');
    expect((err as AppError).message).toMatch(/outside what I can help with/);
  });

  it('retries a cut-off reply once as a stream with a larger limit', async () => {
    const wire = wirePlanFor(input);
    const { client, calls } = fakeClient([reply(null, 'max_tokens')], [reply(wire, 'end_turn', { input_tokens: 1200 })]);
    const res = await new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input);
    expect(calls.map((c) => c.kind)).toEqual(['parse', 'stream']);
    expect(calls[1]!.params.max_tokens).toBe(PLANNER_RETRY_MAX_TOKENS);
    expect(res.usage!.inputTokens).toBe(2200);
    expect(res.usage!.outputTokens).toBe(1000);
  });

  it('maps API errors to app error codes', async () => {
    const headers = new Headers();
    const cases: Array<[Error, string]> = [
      [new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', headers), 'INTEGRATION_NOT_CONFIGURED'],
      [new Anthropic.RateLimitError(429, { error: { message: 'slow down' } }, 'slow down', headers), 'RATE_LIMITED'],
      [new Anthropic.BadRequestError(400, { error: { message: 'bad' } }, 'bad', headers), 'PROCESSING_FAILED'],
      [new Anthropic.InternalServerError(500, { error: { message: 'oops' } }, 'oops', headers), 'PROCESSING_FAILED'],
    ];
    for (const [error, code] of cases) {
      const { client } = fakeClient([error]);
      const err = await new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(code);
    }
  });

  it('reports an unreadable reply and a cancelled call', async () => {
    const { client } = fakeClient([reply({ nonsense: true })]);
    await expect(new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    const controller = new AbortController();
    controller.abort();
    await expect(new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'medium' }).planEdit(input, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('AnthropicVisionLabeler', () => {
  let dir: string;
  const frames: FrameForLabelling[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ai-labeler-'));
    for (let i = 0; i < 20; i++) {
      const jpegPath = path.join(dir, `f${i}.jpg`);
      await writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, i]));
      frames.push({ assetId: ASSET_A, shotId: `shot-${Math.floor(i / 2)}`, timeSec: i * 0.5, jpegPath, width: 432, height: 768 });
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const context = { clipName: 'IMG_0042.MOV', clipDurationSec: 10, projectNotes: 'Skin fade, number 1 on the sides', clipIndex: 0, clipCount: 3 };
  const answer = (shotId: string, label: string, confidence: number, extra: Record<string, unknown> = {}) => ({
    shotId,
    label,
    confidence,
    description: 'Clippers blending the sides of a short fade with a guard on, close to the ear and temple area',
    framing: 'closeup',
    focus: { x: 0.4, y: 1.3 },
    issues: [],
    ...extra,
  });

  it('sends images with frame captions in batches of 16 and merges results per shot', async () => {
    const first = reply({
      frames: [
        answer('shot-0', 'cutting', 0.6),
        answer('shot-0', 'fade_detail', 0.9),
        answer('shot-1', 'before', 0.6),
        answer('shot-2', 'reaction', 0.95),
        answer('shot-3', 'result', 0.2),
        answer('not-asked', 'result', 0.99),
        answer('shot-4', 'haircut', 0.9, { framing: 'tight' }),
      ],
    });
    const second = reply({ frames: [answer('shot-8', 'styling', 0.8), answer('shot-9', 'environment', 0.7)] }, 'end_turn', { cache_read_input_tokens: 0 });
    const { client, calls } = fakeClient([first, second]);
    const labeler = new AnthropicVisionLabeler({ client, model: 'claude-haiku-5-5' });
    const res = await labeler.labelShots({ frames, context });

    expect(calls).toHaveLength(2);
    const firstReq = calls[0]!.params as Anthropic.MessageCreateParamsNonStreaming;
    expect(firstReq.model).toBe('claude-haiku-5-5');
    expect((firstReq.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(firstReq.output_config?.format?.type).toBe('json_schema');
    const blocks = firstReq.messages[0]!.content as Anthropic.ContentBlockParam[];
    const images = blocks.filter((b) => b.type === 'image') as Anthropic.ImageBlockParam[];
    expect(images).toHaveLength(16);
    expect(images[0]!.source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]).toString('base64') });
    expect(blocks[1]!.type).toBe('image');
    expect((blocks[2] as Anthropic.TextBlockParam).text).toBe('Frame 1: shot shot-0, t=0.00s');
    expect((blocks[0] as Anthropic.TextBlockParam).text).toContain('IMG_0042.MOV');
    const secondReq = calls[1]!.params as Anthropic.MessageCreateParamsNonStreaming;
    expect((secondReq.messages[0]!.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === 'image')).toHaveLength(4);

    const byShot = new Map(res.results.map((r) => [r.shotId, r]));
    expect(byShot.get('shot-0')).toMatchObject({ label: 'fade_detail', confidence: 0.9, framing: 'closeup', focus: { x: 0.4, y: 1 } });
    expect(byShot.get('shot-0')!.description.split(' ').length).toBeLessThanOrEqual(20);
    expect(byShot.get('shot-1')!.label).toBe('unknown');
    expect(byShot.get('shot-2')!.label).toBe('reaction');
    expect(byShot.get('shot-3')).toMatchObject({ label: 'unknown', confidence: 0 });
    expect(byShot.get('shot-4')).toMatchObject({ label: 'unknown', framing: 'unknown' });
    expect(byShot.has('not-asked')).toBe(false);
    expect(byShot.get('shot-9')!.label).toBe('environment');
    expect(res.usage).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 2000 });
    // (2000×0.10 + 1000×0.50 + 2000×0.01 + 200×0.125) / 1e6 USD
    expect(res.usage!.estimatedCostUsdCents).toBeCloseTo(0.0745, 6);
  });

  it('reports a refusal as UNSUPPORTED so the worker keeps the heuristic labels', async () => {
    const { client } = fakeClient([{ ...reply(null, 'refusal'), stop_details: { category: null, explanation: null } }]);
    await expect(new AnthropicVisionLabeler({ client, model: 'claude-haiku-5-5' }).labelShots({ frames: frames.slice(0, 2), context })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('returns nothing (and calls nothing) without frames', async () => {
    const { client, calls } = fakeClient([]);
    expect(await new AnthropicVisionLabeler({ client, model: 'claude-haiku-5-5' }).labelShots({ frames: [], context })).toEqual({ results: [], usage: null });
    expect(calls).toHaveLength(0);
  });
});
