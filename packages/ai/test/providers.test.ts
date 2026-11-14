import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, validateEditPlan, type PlanValidationResult } from '@studio/core';
import {
  AnthropicPlanner,
  AnthropicVisionLabeler,
  DEFAULT_MODEL_RATES,
  HeuristicLabeler,
  NoneTranscriber,
  OpenAiTranscriber,
  RulesPlanner,
  createAiProviders,
  estimateCost,
  estimateCostUsdCents,
  mergeRates,
  planWithRepair,
  type AiEnv,
  type AnthropicMessagesClient,
  type EditPlanner,
  type PlannerInput,
} from '../src/index.js';
import { labelledProject, plannerInput } from './fixtures.js';

describe('pricing', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };

  it('prices the current models per million tokens', () => {
    expect(estimateCostUsdCents(usage, 'claude-opus-5-5')).toBeCloseTo((4 + 20 + 0.2 + 5) * 100, 6);
    expect(estimateCostUsdCents(usage, 'claude-sonnet-5-5')).toBeCloseTo((2 + 10 + 0.2 + 2.5) * 100, 6);
    expect(estimateCostUsdCents(usage, 'claude-haiku-5-5')).toBeCloseTo((0.1 + 0.5 + 0.01 + 0.125) * 100, 6);
    expect(estimateCostUsdCents({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'claude-opus-5-5')).toBeCloseTo(1.4, 6);
  });

  it('reports unknown models as unpriced with zero cost', () => {
    expect(estimateCost(usage, 'some-other-model')).toEqual({ estimatedCostUsdCents: 0, priced: false });
    expect(estimateCost(usage, 'claude-opus-5-5').priced).toBe(true);
  });

  it('accepts platform suffixes and overriding tables', () => {
    expect(estimateCost(usage, 'claude-haiku-5-5@20261101').priced).toBe(true);
    const table = mergeRates({ 'claude-opus-5-5': { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 } });
    expect(estimateCostUsdCents(usage, 'claude-opus-5-5', table)).toBeCloseTo(400, 6);
    expect(DEFAULT_MODEL_RATES['claude-opus-5-5']!.inputPerMTok).toBe(4);
  });
});

describe('HeuristicLabeler', () => {
  it('never guesses a label', async () => {
    const res = await new HeuristicLabeler().labelShots({
      frames: [
        { assetId: 'a', shotId: 's0', timeSec: 1, jpegPath: '/nowhere.jpg', width: 1, height: 1 },
        { assetId: 'a', shotId: 's0', timeSec: 2, jpegPath: '/nowhere.jpg', width: 1, height: 1 },
        { assetId: 'a', shotId: 's1', timeSec: 3, jpegPath: '/nowhere.jpg', width: 1, height: 1 },
      ],
      context: { clipName: 'x', clipDurationSec: 4, projectNotes: '', clipIndex: 0, clipCount: 1 },
    });
    expect(res.usage).toBeNull();
    expect(res.results).toEqual([
      { shotId: 's0', label: 'unknown', confidence: 0, description: '', framing: 'unknown', focus: null, issues: [] },
      { shotId: 's1', label: 'unknown', confidence: 0, description: '', framing: 'unknown', focus: null, issues: [] },
    ]);
  });
});

describe('transcription', () => {
  let dir: string;
  let audio: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ai-stt-'));
    audio = path.join(dir, 'speech.m4a');
    await writeFile(audio, Buffer.from('fake-audio'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('posts verbose JSON with segment timestamps and maps the segments', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          language: 'english',
          text: 'Keep the top long. Yeah.',
          segments: [
            { id: 0, start: 0.2, end: 1.9, text: ' Keep the top long. ' },
            { id: 1, start: 2.5, end: 2.5, text: 'Yeah.' },
            { id: 2, start: 3.1, end: 4.0, text: '   ' },
            { id: 3, start: 4.2, end: 5.0, text: 'Looks sharp.' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const t = new OpenAiTranscriber({ apiKey: 'sk-test', fetchImpl });
    const res = await t.transcribe(audio, { language: 'en' });
    expect(res).toEqual({
      provider: 'openai',
      language: 'english',
      segments: [
        { startSec: 0.2, endSec: 1.9, text: 'Keep the top long.' },
        { startSec: 4.2, endSec: 5, text: 'Looks sharp.' },
      ],
    });
    expect(seen!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const form = seen!.init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).name).toBe('speech.m4a');
  });

  it('maps HTTP failures to plain app errors', async () => {
    const respond = (status: number) => (async () => new Response('{"error":{}}', { status })) as unknown as typeof fetch;
    await expect(new OpenAiTranscriber({ apiKey: 'k', fetchImpl: respond(401) }).transcribe(audio)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    await expect(new OpenAiTranscriber({ apiKey: 'k', fetchImpl: respond(429) }).transcribe(audio)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(new OpenAiTranscriber({ apiKey: 'k', fetchImpl: respond(500) }).transcribe(audio)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    await expect(new OpenAiTranscriber({ apiKey: 'k' }).transcribe(path.join(dir, 'missing.m4a'))).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
  });

  it('treats an aborted upload as a cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    await expect(new OpenAiTranscriber({ apiKey: 'k', fetchImpl }).transcribe(audio, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('the none transcriber reports no speech', async () => {
    expect(await new NoneTranscriber().transcribe(audio)).toEqual({ provider: 'none', language: null, segments: [] });
  });
});

describe('createAiProviders', () => {
  const base: AiEnv = {
    AI_PROVIDER: 'none',
    AI_PLANNER_MODEL: 'claude-opus-5-5',
    AI_PLANNER_EFFORT: 'medium',
    AI_VISION_MODEL: 'claude-haiku-5-5',
    TRANSCRIPTION_PROVIDER: 'none',
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
  };

  it('runs on the rules planner without keys', () => {
    const ai = createAiProviders(base);
    expect(ai.planner).toBe(ai.rulesPlanner);
    expect(ai.rulesPlanner).toBeInstanceOf(RulesPlanner);
    expect(ai.labeler).toBeNull();
    expect(ai.transcriber).toBeNull();
    expect(ai.describe()).toEqual({ plannerName: 'rules', plannerModel: null, labelerModel: null, transcriberName: 'none' });
  });

  it('uses Claude for planning and labelling when configured', () => {
    const ai = createAiProviders({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test', TRANSCRIPTION_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
    expect(ai.planner).toBeInstanceOf(AnthropicPlanner);
    expect(ai.planner).not.toBe(ai.rulesPlanner);
    expect(ai.labeler).toBeInstanceOf(AnthropicVisionLabeler);
    expect(ai.transcriber).toBeInstanceOf(OpenAiTranscriber);
    expect(ai.describe()).toEqual({ plannerName: 'anthropic', plannerModel: 'claude-opus-5-5', labelerModel: 'claude-haiku-5-5', transcriberName: 'openai' });
  });

  it('falls back to the rules planner when the key is missing', () => {
    const ai = createAiProviders({ ...base, AI_PROVIDER: 'anthropic', TRANSCRIPTION_PROVIDER: 'openai' });
    expect(ai.planner).toBe(ai.rulesPlanner);
    expect(ai.labeler).toBeNull();
    expect(ai.transcriber).toBeNull();
  });
});

describe('planWithRepair', () => {
  const input = plannerInput(labelledProject(), { styleId: 'clean_promo', targetDurationSec: 20 });
  const validate = (plan: unknown): PlanValidationResult =>
    validateEditPlan(plan, { assets: input.assets, music: null, transcripts: {}, durationBounds: { min: 17.6, max: 22.4 } });
  const rules = new RulesPlanner();
  const good = rules.plan(input);

  function scripted(results: Array<unknown | Error>): EditPlanner & { inputs: PlannerInput[] } {
    const inputs: PlannerInput[] = [];
    return {
      name: 'scripted',
      model: 'claude-opus-5-5',
      inputs,
      planEdit: async (i) => {
        inputs.push(i);
        const r = results.shift();
        if (r instanceof Error) throw r;
        return { plan: r, usage: null, source: 'ai' };
      },
    };
  }

  it('feeds validation errors back until the plan passes', async () => {
    const broken = { ...good, segments: good.segments.map((s, i) => (i === 0 ? { ...s, outSec: 999 } : s)) };
    const primary = scripted([broken, good]);
    const out = await planWithRepair(primary, rules, input, validate);
    expect(out.source).toBe('ai');
    expect(out.attempts).toBe(2);
    expect(primary.inputs[1]!.previousErrors?.[0]?.code).toBe('OUT_OF_BOUNDS');
    expect(out.fallbackReason).toBeNull();
  });

  it('falls back to the rules planner after two failed repairs', async () => {
    const primary = scripted([{}, {}, {}]);
    const out = await planWithRepair(primary, rules, input, validate, { maxRepairs: 2 });
    expect(out.source).toBe('rules');
    expect(out.attempts).toBe(4);
    expect(primary.inputs).toHaveLength(3);
    expect(out.fallbackReason).toMatch(/rules-based/);
  });

  it('skips repairs when the AI service is not available', async () => {
    const primary = scripted([new AppError('RATE_LIMITED', 'busy')]);
    const out = await planWithRepair(primary, rules, input, validate);
    expect(out.source).toBe('rules');
    expect(primary.inputs).toHaveLength(1);
    expect(out.fallbackReason).toBe('busy');
  });

  it('works with a fake Claude client end to end', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        parse: async () => ({ parsed_output: { not: 'a plan' }, stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 10 } }),
        stream: () => ({ finalMessage: async () => Promise.reject(new Error('unused')) }),
      },
    };
    const out = await planWithRepair(new AnthropicPlanner({ client, model: 'claude-opus-5-5', effort: 'low' }), rules, input, validate);
    expect(out.source).toBe('rules');
    expect(validate(out.plan).ok).toBe(true);
  });
});
