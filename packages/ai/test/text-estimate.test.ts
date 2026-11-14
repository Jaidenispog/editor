import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EditingPreferencesSchema, type EditPlan, type StyleId } from '@studio/core';
import { AnthropicTextEstimator, TEXT_ESTIMATE_SYSTEM_PROMPT } from '../src/anthropic/text-estimate.js';
import type { AnthropicMessagesClient, StructuredResponse } from '../src/anthropic/client.js';
import { createAiProviders } from '../src/factory.js';
import { RulesPlanner } from '../src/rules/planner.js';
import { effectiveSettings } from '../src/rules/settings.js';
import { labelledProject, plannerInput } from './fixtures.js';

function fakeClient(replies: Array<StructuredResponse | Error>) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      parse: async (params) => {
        calls.push(params);
        const r = replies.shift();
        if (!r) throw new Error('no fake reply left');
        if (r instanceof Error) throw r;
        return r;
      },
      stream: () => {
        throw new Error('not used');
      },
    },
  };
  return { client, calls };
}

const reply = (parsed: unknown, stop = 'end_turn'): StructuredResponse => ({ parsed_output: parsed, stop_reason: stop, usage: { input_tokens: 900, output_tokens: 40 } });

describe('AnthropicTextEstimator', () => {
  let dir: string;
  let frames: Array<{ jpegPath: string; width: number; height: number }>;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sa-text-'));
    frames = [];
    for (let i = 0; i < 10; i++) {
      const p = path.join(dir, `f${i}.jpg`);
      await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, i]));
      frames.push({ jpegPath: p, width: 432, height: 768 });
    }
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('sends at most eight frames with oversized_image "error", a no-people prompt and low effort', async () => {
    const { client, calls } = fakeClient([reply({ frames: Array.from({ length: 8 }, (_, i) => ({ index: i + 1, hasOnScreenText: i < 3, coverage: i < 3 ? 'small' : 'none' })) })]);
    const estimator = new AnthropicTextEstimator({ client, model: 'claude-haiku-5-5' });
    const result = await estimator.estimateOnScreenText([...frames, { jpegPath: frames[0]!.jpegPath, width: 120, height: 160 }]);
    expect(result.measurement).toEqual({ framesChecked: 8, framesWithText: 3 });
    expect(result.usage).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 40 });
    const request = calls[0]!;
    const images = (request.messages[0]!.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === 'image') as Anthropic.ImageBlockParam[];
    expect(images).toHaveLength(8);
    for (const img of images) expect(img.transformations).toEqual({ oversized_image: 'error' });
    expect(request.output_config?.effort).toBe('low');
    expect(TEXT_ESTIMATE_SYSTEM_PROMPT).toMatch(/Do not identify or describe people/);
    expect(TEXT_ESTIMATE_SYSTEM_PROMPT).toMatch(/Do not read out or transcribe/);
  });

  it('gives "not measured" for a refusal, running out of tokens, an unreadable or partial answer, but still reports usage', async () => {
    for (const r of [
      reply(null, 'refusal'),
      reply(null, 'max_tokens'),
      reply({ nope: true }),
      reply({ frames: [{ index: 1, hasOnScreenText: true, coverage: 'large' }] }),
    ]) {
      const { client } = fakeClient([r]);
      const result = await new AnthropicTextEstimator({ client, model: 'claude-haiku-5-5' }).estimateOnScreenText(frames.slice(0, 2));
      expect(result.measurement).toBeNull();
      expect(result.usage?.inputTokens).toBe(900);
    }
  });

  it('sends nothing when no frame is usable', async () => {
    const { client, calls } = fakeClient([]);
    const result = await new AnthropicTextEstimator({ client, model: 'm' }).estimateOnScreenText([{ jpegPath: '/missing.jpg', width: 432, height: 768 }]);
    expect(result).toEqual({ measurement: null, usage: null });
    expect(calls).toHaveLength(0);
  });

  it('exists only when AI is configured', () => {
    const env = {
      AI_PROVIDER: 'none' as const,
      AI_PLANNER_MODEL: 'claude-opus-5-5',
      AI_PLANNER_EFFORT: 'medium' as const,
      AI_VISION_MODEL: 'claude-haiku-5-5',
      TRANSCRIPTION_PROVIDER: 'none' as const,
      OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
    };
    expect(createAiProviders(env).textEstimator).toBeNull();
    const { client } = fakeClient([]);
    expect(createAiProviders({ ...env, AI_PROVIDER: 'anthropic' }, undefined, { anthropicClient: client }).textEstimator?.model).toBe('claude-haiku-5-5');
  });
});

describe('rules planner text density', () => {
  it('maps medium to more text, light to the style normal and none to no text', () => {
    const prefs = (textDensity: 'none' | 'light' | 'medium') => EditingPreferencesSchema.parse({ textDensity });
    const analyses = labelledProject();
    expect(effectiveSettings(plannerInput(analyses, { preferences: prefs('medium') })).text).toBe('more');
    expect(effectiveSettings(plannerInput(analyses, { preferences: prefs('light') })).text).toBe('normal');
    expect(effectiveSettings(plannerInput(analyses, { preferences: prefs('none') })).text).toBe('none');
  });

  it('puts more overlays on screen for medium than for light', async () => {
    const planner = new RulesPlanner();
    const analyses = labelledProject();
    let more = 0;
    let fewer = 0;
    for (const styleId of ['before_after', 'clean_promo', 'process_story', 'cinematic_reveal'] as StyleId[]) {
      const count = async (textDensity: 'light' | 'medium') => {
        const out = await planner.planEdit(plannerInput(analyses, { styleId, targetDurationSec: 25, preferences: EditingPreferencesSchema.parse({ textDensity }) }));
        const plan = out.plan as EditPlan;
        return plan.textOverlays.length;
      };
      const light = await count('light');
      const medium = await count('medium');
      expect(medium).toBeGreaterThanOrEqual(light);
      if (medium > light) more++;
      if (medium < light) fewer++;
    }
    expect(more).toBeGreaterThan(0);
    expect(fewer).toBe(0);
  });

  it('uses learned values unless the field is pinned', () => {
    const learned = { computedAt: '2026-11-14T00:00:00.000Z', eventsConsidered: 9, since: null, error: null, fields: { textDensity: { value: 'none', weight: 9, counts: { favourites: 3, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: '' } } };
    const base = { ...DEFAULT_SETTINGS.preferences, learned };
    expect(effectiveSettings(plannerInput(labelledProject(), { preferences: base })).text).toBe('none');
    const pinned = { ...base, learning: { ...base.learning, pinned: { textDensity: { by: 'owner' as const, at: '2026-11-14T00:00:00.000Z', referenceAssetId: null, referenceName: '' } } } };
    expect(effectiveSettings(plannerInput(labelledProject(), { preferences: pinned })).text).toBe('normal');
  });
});
