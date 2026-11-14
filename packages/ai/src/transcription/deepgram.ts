import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError, CancelledError, type TranscriptSegment } from '@studio/core';
import type { Logger } from 'pino';
import type { TranscribeOptions, Transcriber, TranscriptionResult } from '../types.js';
import { audioMimeType } from './audio-mime.js';

/** Deepgram's pre-recorded speech-to-text endpoint (one synchronous request per clip). */
export const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';
/** Default Deepgram model. */
export const DEEPGRAM_DEFAULT_MODEL = 'nova-3';

/** Caption limits the transcript is split to: two lines of at most 42 characters, on screen for at least 0.7 s. */
export const CAPTION_MAX_LINE_CHARS = 42;
export const CAPTION_MAX_LINES = 2;
export const CAPTION_MIN_SECONDS = 0.7;
/** A silence at least this long between two words always starts a new caption. */
export const CAPTION_PAUSE_SPLIT_SECONDS = 0.8;
/**
 * Segments whose average word confidence is below this are dropped rather than captioned. A starting point to tune
 * on real clips (clippers and music in the background), not a documented Deepgram value.
 */
export const DEEPGRAM_MIN_SEGMENT_CONFIDENCE = 0.4;

const WordSchema = z
  .object({
    word: z.string(),
    punctuated_word: z.string().optional(),
    start: z.number(),
    end: z.number(),
    confidence: z.number().optional(),
  })
  .passthrough();

const UtteranceSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    transcript: z.string().optional(),
    confidence: z.number().optional(),
    words: z.array(WordSchema).optional(),
  })
  .passthrough();

const ListenResponseSchema = z
  .object({
    results: z
      .object({
        channels: z
          .array(
            z
              .object({
                detected_language: z.string().optional(),
                alternatives: z
                  .array(z.object({ transcript: z.string().optional(), words: z.array(WordSchema).optional() }).passthrough())
                  .optional(),
              })
              .passthrough(),
          )
          .optional(),
        utterances: z.array(UtteranceSchema).optional(),
      })
      .passthrough()
      .optional(),
    // Some documentation shows utterances beside `results` rather than inside it, so both places are read.
    utterances: z.array(UtteranceSchema).optional(),
  })
  .passthrough();

/** One timed word from the transcript. */
export interface TimedWord {
  text: string;
  startSec: number;
  endSec: number;
  confidence: number | null;
}

/** Settings for DeepgramTranscriber. */
export interface DeepgramTranscriberOptions {
  apiKey: string;
  /** Deepgram model (DEEPGRAM_MODEL). Defaults to nova-3. */
  model?: string;
  /** Language sent when the caller gives none. Defaults to `en`. */
  defaultLanguage?: string;
  /** Segments with a lower average word confidence are dropped. */
  minSegmentConfidence?: number;
  logger?: Logger;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  url?: string;
}

/**
 * Speech-to-text through Deepgram's pre-recorded API (Nova-3 by default) with punctuation, smart formatting and
 * utterances. Word timings come straight from Deepgram; long utterances are split at word boundaries into
 * caption-sized segments, so every caption is verbatim speech with its real timing. Nothing is reworded.
 */
export class DeepgramTranscriber implements Transcriber {
  readonly name = 'deepgram';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultLanguage: string;
  private readonly minSegmentConfidence: number;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(opts: DeepgramTranscriberOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEEPGRAM_DEFAULT_MODEL;
    this.defaultLanguage = opts.defaultLanguage ?? 'en';
    this.minSegmentConfidence = opts.minSegmentConfidence ?? DEEPGRAM_MIN_SEGMENT_CONFIDENCE;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.url = opts.url ?? DEEPGRAM_LISTEN_URL;
  }

  /** Sends the audio file and returns caption-sized, timed transcript segments. */
  async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const { signal } = opts;
    if (signal?.aborted) throw new CancelledError();
    let bytes: Buffer;
    try {
      bytes = await readFile(audioPath);
    } catch (err) {
      throw new AppError('PROCESSING_FAILED', 'The audio prepared for transcription could not be read.', { cause: err });
    }
    const language = opts.language ?? this.defaultLanguage;
    const query = new URLSearchParams({
      model: this.model,
      language,
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}?${query.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': audioMimeType(audioPath) },
        body: new Uint8Array(bytes),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw new CancelledError();
      throw new AppError('PROCESSING_FAILED', 'The transcription service could not be reached. Please try again shortly.', { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger?.warn({ status: res.status, body: body.slice(0, 300) }, 'deepgram transcription request failed');
      if (res.status === 401 || res.status === 403) {
        throw new AppError('INTEGRATION_NOT_CONFIGURED', 'The Deepgram API key was not accepted. Check the transcription settings.');
      }
      if (res.status === 429) throw new AppError('RATE_LIMITED', 'The transcription service is busy right now. Please try again in a few minutes.');
      if (res.status === 402) {
        throw new AppError('PROCESSING_FAILED', 'The Deepgram account has run out of credit, so this clip was not transcribed.', { details: { status: res.status } });
      }
      throw new AppError('PROCESSING_FAILED', 'The transcription service could not process this clip.', { details: { status: res.status } });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AppError('PROCESSING_FAILED', 'The transcription service returned an unreadable answer.', { cause: err });
    }
    const parsed = ListenResponseSchema.safeParse(json);
    if (!parsed.success) throw new AppError('PROCESSING_FAILED', 'The transcription service returned an unexpected answer.');
    const detected = parsed.data.results?.channels?.[0]?.detected_language;
    return {
      provider: 'deepgram',
      language: detected ?? language,
      segments: deepgramToSegments(parsed.data, { minSegmentConfidence: this.minSegmentConfidence }),
    };
  }
}

/** The parsed Deepgram response, as far as segment mapping needs it. */
type ListenResponse = z.infer<typeof ListenResponseSchema>;
type DeepgramWord = z.infer<typeof WordSchema>;

/**
 * Maps a Deepgram response to caption-sized transcript segments. Utterances (with their words) are preferred;
 * without them the first channel's words are used. Only timings Deepgram returned are used: an utterance without
 * word timings is kept whole rather than split at guessed times.
 */
export function deepgramToSegments(response: ListenResponse, opts: { minSegmentConfidence?: number } = {}): TranscriptSegment[] {
  const minConfidence = opts.minSegmentConfidence ?? DEEPGRAM_MIN_SEGMENT_CONFIDENCE;
  const utterances = response.results?.utterances ?? response.utterances ?? [];
  const groups: TimedWord[][] = [];
  const whole: Array<{ segment: TranscriptSegment; confidence: number | null }> = [];

  if (utterances.length > 0) {
    for (const u of utterances) {
      const words = toTimedWords(u.words ?? []);
      if (words.length > 0) groups.push(words);
      else if (u.transcript && u.transcript.trim()) {
        whole.push({ segment: { startSec: Math.max(0, u.start), endSec: u.end, text: u.transcript.trim() }, confidence: u.confidence ?? null });
      }
    }
  } else {
    const words = toTimedWords(response.results?.channels?.[0]?.alternatives?.[0]?.words ?? []);
    if (words.length > 0) groups.push(words);
  }

  const chunks: Array<{ words: TimedWord[] } | { segment: TranscriptSegment; confidence: number | null }> = [];
  for (const g of groups) for (const c of mergeShortChunks(splitIntoCaptionChunks(g))) chunks.push({ words: c });
  chunks.push(...whole);

  const kept: TranscriptSegment[] = [];
  for (const c of chunks) {
    if ('words' in c) {
      const confidence = averageConfidence(c.words);
      if (confidence !== null && confidence < minConfidence) continue;
      const first = c.words[0]!;
      const last = c.words[c.words.length - 1]!;
      kept.push({ startSec: first.startSec, endSec: last.endSec, text: joinWords(c.words) });
    } else {
      if (c.confidence !== null && c.confidence < minConfidence) continue;
      kept.push(c.segment);
    }
  }
  const valid = kept
    .filter((s) => s.text.length > 0 && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec && s.endSec > 0)
    .sort((a, b) => a.startSec - b.startSec);
  return holdShortSegments(valid);
}

function toTimedWords(raw: DeepgramWord[]): TimedWord[] {
  return raw
    .map((w) => ({ text: (w.punctuated_word ?? w.word).trim(), startSec: Math.max(0, w.start), endSec: w.end, confidence: w.confidence ?? null }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && w.endSec >= w.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

function joinWords(words: TimedWord[]): string {
  return words.map((w) => w.text).join(' ').trim();
}

function averageConfidence(words: TimedWord[]): number | null {
  const known = words.map((w) => w.confidence).filter((c): c is number => c !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/** Greedy word wrap into lines of at most CAPTION_MAX_LINE_CHARS; a single longer word gets its own line. */
export function wrapCaptionLines(words: string[], maxChars = CAPTION_MAX_LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line = `${line} ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitsCaption(words: TimedWord[]): boolean {
  return wrapCaptionLines(words.map((w) => w.text)).length <= CAPTION_MAX_LINES;
}

const SENTENCE_END = /[.!?…]["'’”)]*$/;
const CLAUSE_END = /[,;:–—]["'’”)]*$/;

/**
 * Splits one utterance's words into chunks that fit two caption lines. A new chunk starts after a pause, after a
 * sentence once it has been on screen long enough, or when the next word would not fit; on overflow the split
 * moves back to a comma in the second half of the chunk when there is one, so lines break at natural points.
 */
export function splitIntoCaptionChunks(words: TimedWord[]): TimedWord[][] {
  const chunks: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.startSec - prev.endSec >= CAPTION_PAUSE_SPLIT_SECONDS) {
      chunks.push(cur);
      cur = [];
    } else if (prev && !fitsCaption([...cur, w])) {
      let cut = -1;
      for (let i = cur.length - 2; i >= Math.ceil(cur.length / 2) - 1 && i >= 0; i--) {
        if (CLAUSE_END.test(cur[i]!.text) || SENTENCE_END.test(cur[i]!.text)) {
          cut = i;
          break;
        }
      }
      if (cut >= 0) {
        chunks.push(cur.slice(0, cut + 1));
        cur = cur.slice(cut + 1);
        if (!fitsCaption([...cur, w])) {
          chunks.push(cur);
          cur = [];
        }
      } else {
        chunks.push(cur);
        cur = [];
      }
    }
    cur.push(w);
    const first = cur[0]!;
    if (SENTENCE_END.test(w.text) && w.endSec - first.startSec >= CAPTION_MIN_SECONDS) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks.filter((c) => c.length > 0);
}

function chunkSeconds(c: TimedWord[]): number {
  return c[c.length - 1]!.endSec - c[0]!.startSec;
}

/** Joins chunks shorter than CAPTION_MIN_SECONDS onto a neighbour when the result still fits and no long pause separates them. */
export function mergeShortChunks(chunks: TimedWord[][]): TimedWord[][] {
  const out = chunks.map((c) => [...c]);
  let i = 0;
  while (i < out.length) {
    const c = out[i]!;
    if (chunkSeconds(c) >= CAPTION_MIN_SECONDS) {
      i++;
      continue;
    }
    const next = out[i + 1];
    const prev = out[i - 1];
    const gapNext = next ? next[0]!.startSec - c[c.length - 1]!.endSec : Infinity;
    const gapPrev = prev ? c[0]!.startSec - prev[prev.length - 1]!.endSec : Infinity;
    if (next && gapNext < CAPTION_PAUSE_SPLIT_SECONDS && fitsCaption([...c, ...next]) && (gapNext <= gapPrev || !prev || !fitsCaption([...prev, ...c]))) {
      out.splice(i, 2, [...c, ...next]);
      continue;
    }
    if (prev && gapPrev < CAPTION_PAUSE_SPLIT_SECONDS && fitsCaption([...prev, ...c])) {
      out.splice(i - 1, 2, [...prev, ...c]);
      i = Math.max(0, i - 1);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Keeps each caption on screen for at least CAPTION_MIN_SECONDS by holding it past the last spoken word, but never
 * into the next caption. The start time always stays the moment the first word was spoken.
 */
export function holdShortSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((s, i) => {
    if (s.endSec - s.startSec >= CAPTION_MIN_SECONDS) return s;
    const next = segments[i + 1];
    const limit = next ? Math.max(s.endSec, next.startSec) : Infinity;
    return { ...s, endSec: round3(Math.min(s.startSec + CAPTION_MIN_SECONDS, limit)) };
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
