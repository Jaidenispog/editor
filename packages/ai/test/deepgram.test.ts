import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPTION_MAX_LINE_CHARS,
  CAPTION_MAX_LINES,
  CAPTION_MIN_SECONDS,
  DeepgramTranscriber,
  createAiProviders,
  deepgramToSegments,
  wrapCaptionLines,
} from '../src/index.js';

/** Builds Deepgram-style words with real-looking timings from "text@start-end" tokens. */
function words(spec: string): Array<{ word: string; punctuated_word: string; start: number; end: number; confidence: number }> {
  return spec
    .trim()
    .split(/\s+/)
    .map((token) => {
      const [text, times] = token.split('@') as [string, string];
      const [start, end] = times.split('-').map(Number) as [number, number];
      return { word: text.toLowerCase().replace(/[^a-z0-9']/g, ''), punctuated_word: text.replace(/_/g, ' '), start, end, confidence: 0.95 };
    });
}

/** Evenly timed words for a sentence, 0.3 s per word starting at `from`. */
function sentence(text: string, from: number): ReturnType<typeof words> {
  return text.split(' ').map((w, i) => ({
    word: w.toLowerCase().replace(/[^a-z0-9']/g, ''),
    punctuated_word: w,
    start: Math.round((from + i * 0.3) * 1000) / 1000,
    end: Math.round((from + i * 0.3 + 0.25) * 1000) / 1000,
    confidence: 0.9,
  }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('DeepgramTranscriber', () => {
  let dir: string;
  let audio: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ai-deepgram-'));
    audio = path.join(dir, 'speech.m4a');
    await writeFile(audio, Buffer.from('fake-audio-bytes'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('posts the audio bytes to the pre-recorded endpoint and maps utterances', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return json({
        metadata: { request_id: 'r1' },
        results: {
          channels: [{ alternatives: [{ transcript: 'Keep the top long. Looks sharp.', words: [] }] }],
          utterances: [
            { start: 0.2, end: 1.9, confidence: 0.97, transcript: 'Keep the top long.', words: words('Keep@0.2-0.5 the@0.5-0.7 top@0.7-1.1 long.@1.1-1.9') },
            { start: 4.2, end: 5.0, confidence: 0.95, transcript: 'Looks sharp.', words: words('Looks@4.2-4.6 sharp.@4.6-5.0') },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const t = new DeepgramTranscriber({ apiKey: 'dg-test', fetchImpl });
    const res = await t.transcribe(audio);
    expect(res).toEqual({
      provider: 'deepgram',
      language: 'en',
      segments: [
        { startSec: 0.2, endSec: 1.9, text: 'Keep the top long.' },
        { startSec: 4.2, endSec: 5, text: 'Looks sharp.' },
      ],
    });
    const url = new URL(seen!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({ model: 'nova-3', language: 'en', smart_format: 'true', punctuate: 'true', utterances: 'true' });
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Token dg-test');
    expect(headers['Content-Type']).toBe('audio/mp4');
    expect(seen!.init.method).toBe('POST');
    expect(Buffer.from(seen!.init.body as Uint8Array).toString()).toBe('fake-audio-bytes');
  });

  it('uses the configured model and language and reports a detected language', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return json({ results: { channels: [{ detected_language: 'en', alternatives: [{ words: [] }] }], utterances: [] } });
    }) as unknown as typeof fetch;
    const res = await new DeepgramTranscriber({ apiKey: 'k', model: 'nova-3-general', fetchImpl }).transcribe(audio, { language: 'en-AU' });
    expect(new URL(seenUrl).searchParams.get('model')).toBe('nova-3-general');
    expect(new URL(seenUrl).searchParams.get('language')).toBe('en-AU');
    expect(res).toEqual({ provider: 'deepgram', language: 'en', segments: [] });
  });

  it('reads utterances placed beside results and falls back to channel words', async () => {
    const top = deepgramToSegments({ utterances: [{ start: 1, end: 2, words: words('Fresh@1-1.4 fade.@1.4-2') }] });
    expect(top).toEqual([{ startSec: 1, endSec: 2, text: 'Fresh fade.' }]);
    const channel = deepgramToSegments({ results: { channels: [{ alternatives: [{ words: words('Nice@0.5-0.9 one.@0.9-1.5') }] }] } });
    expect(channel).toEqual([{ startSec: 0.5, endSec: 1.5, text: 'Nice one.' }]);
  });

  it('splits a long utterance at word boundaries into caption-sized segments with real timings', () => {
    const spoken = sentence(
      'So what we are doing today is a mid skin fade with a textured crop on top and we will finish it with a sharp line up and a bit of matte paste for hold',
      0.5,
    );
    const segments = deepgramToSegments({ results: { utterances: [{ start: spoken[0]!.start, end: spoken[spoken.length - 1]!.end, words: spoken }] } });
    expect(segments.length).toBeGreaterThan(1);
    const starts = new Set(spoken.map((w) => w.start));
    const ends = new Set(spoken.map((w) => w.end));
    for (const s of segments) {
      const lines = wrapCaptionLines(s.text.split(' '));
      expect(lines.length).toBeLessThanOrEqual(CAPTION_MAX_LINES);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(CAPTION_MAX_LINE_CHARS);
      expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(CAPTION_MIN_SECONDS);
      // Every boundary is a real word timing from the response.
      expect(starts.has(s.startSec)).toBe(true);
      expect(ends.has(s.endSec)).toBe(true);
    }
    // Nothing is lost, added or reordered.
    expect(segments.map((s) => s.text).join(' ')).toBe(spoken.map((w) => w.punctuated_word).join(' '));
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.startSec).toBeGreaterThanOrEqual(segments[i - 1]!.endSec);
  });

  it('starts a new caption after a pause and prefers to break after a comma', () => {
    const first = sentence('Right, so we are going to take the sides down nice and tight with a number one guard', 0);
    const later = sentence('Looks good mate', 8);
    const segments = deepgramToSegments({ results: { utterances: [{ start: 0, end: 10, words: [...first, ...later] }] } });
    expect(segments[segments.length - 1]).toEqual({ startSec: 8, endSec: 8.85, text: 'Looks good mate' });
    for (const s of segments) expect(wrapCaptionLines(s.text.split(' ')).length).toBeLessThanOrEqual(2);
  });

  it('keeps a very short word on screen for at least 0.7 s without overlapping the next caption', () => {
    const segments = deepgramToSegments({
      results: {
        utterances: [
          { start: 1, end: 1.2, words: words('Yep.@1-1.2') },
          { start: 1.5, end: 2.6, words: words('Love@1.5-1.9 it.@1.9-2.6') },
          { start: 6, end: 6.25, words: words('Cheers.@6-6.25') },
        ],
      },
    });
    expect(segments).toEqual([
      { startSec: 1, endSec: 1.5, text: 'Yep.' },
      { startSec: 1.5, endSec: 2.6, text: 'Love it.' },
      { startSec: 6, endSec: 6.7, text: 'Cheers.' },
    ]);
  });

  it('merges a short fragment into its neighbour when it fits', () => {
    const segments = deepgramToSegments({ results: { utterances: [{ start: 0, end: 2, words: words('Wow.@0-0.3 That@0.4-0.7 looks@0.7-1.1 unreal.@1.1-2') }] } });
    expect(segments).toEqual([{ startSec: 0, endSec: 2, text: 'Wow. That looks unreal.' }]);
  });

  it('drops low-confidence segments and keeps an utterance without word timings whole', () => {
    const low = words('mumble@0-1 noise@1-2').map((w) => ({ ...w, confidence: 0.1 }));
    const segments = deepgramToSegments({
      results: {
        utterances: [
          { start: 0, end: 2, words: low },
          { start: 3, end: 5, confidence: 0.9, transcript: 'Clean fade.' },
        ],
      },
    });
    expect(segments).toEqual([{ startSec: 3, endSec: 5, text: 'Clean fade.' }]);
  });

  it('maps HTTP failures to plain app errors', async () => {
    const respond = (status: number) => (async () => new Response('{"err_code":"x"}', { status })) as unknown as typeof fetch;
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(401) }).transcribe(audio)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(403) }).transcribe(audio)).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(429) }).transcribe(audio)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(402) }).transcribe(audio)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(500) }).transcribe(audio)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    const garbage = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: garbage }).transcribe(audio)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: unreachable }).transcribe(audio)).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl: respond(200) }).transcribe(path.join(dir, 'missing.m4a'))).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    });
  });

  it('treats an aborted request as a cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl }).transcribe(audio, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const already = new AbortController();
    already.abort();
    await expect(new DeepgramTranscriber({ apiKey: 'k', fetchImpl }).transcribe(audio, { signal: already.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('createAiProviders with Deepgram', () => {
  const base = {
    AI_PROVIDER: 'none' as const,
    AI_PLANNER_MODEL: 'claude-opus-5-5',
    AI_PLANNER_EFFORT: 'medium' as const,
    AI_VISION_MODEL: 'claude-haiku-5-5',
    OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
  };
  it('selects Deepgram when it is the provider and has a key', () => {
    const ai = createAiProviders({ ...base, TRANSCRIPTION_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg', DEEPGRAM_MODEL: 'nova-3' });
    expect(ai.transcriber).toBeInstanceOf(DeepgramTranscriber);
    expect(ai.describe().transcriberName).toBe('deepgram');
  });
  it('turns transcription off when the Deepgram key is missing', () => {
    const ai = createAiProviders({ ...base, TRANSCRIPTION_PROVIDER: 'deepgram' });
    expect(ai.transcriber).toBeNull();
    expect(ai.describe().transcriberName).toBe('none');
  });
});
