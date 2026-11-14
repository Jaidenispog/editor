import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError, CancelledError, type TranscriptSegment } from '@studio/core';
import type { Logger } from 'pino';
import type { TranscribeOptions, Transcriber, TranscriptionResult } from '../types.js';
import { audioMimeType } from './audio-mime.js';

/** OpenAI's speech-to-text endpoint. */
export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
/** The endpoint's upload limit; the worker sends a compressed mono speech track well under it. */
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const VerboseJsonSchema = z.object({
  language: z.string().nullable().optional(),
  text: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough())
    .nullable()
    .optional(),
});

/** Settings for OpenAiTranscriber. */
export interface OpenAiTranscriberOptions {
  apiKey: string;
  model?: string;
  logger?: Logger;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  url?: string;
}

/**
 * Speech-to-text through OpenAI's transcription endpoint (verbose JSON with segment timestamps).
 * Optional second provider: OpenAI has announced that whisper-1 shuts down on 26 February 2027 (deprecation notice
 * of 26 August 2026), and its newer transcription models return no documented timestamps, so they cannot time
 * captions. Deepgram (`TRANSCRIPTION_PROVIDER=deepgram`) is the recommended provider.
 * Segments come back verbatim so captions can be checked against them; nothing is reworded.
 */
export class OpenAiTranscriber implements Transcriber {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;

  constructor(opts: OpenAiTranscriberOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'whisper-1';
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.url = opts.url ?? OPENAI_TRANSCRIPTION_URL;
  }

  /** Uploads the audio file and returns timed transcript segments. */
  async transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const { signal } = opts;
    if (signal?.aborted) throw new CancelledError();
    let size: number;
    try {
      size = (await stat(audioPath)).size;
    } catch (err) {
      throw new AppError('PROCESSING_FAILED', 'The audio prepared for transcription could not be read.', { cause: err });
    }
    if (size > OPENAI_MAX_UPLOAD_BYTES) {
      throw new AppError('UNSUPPORTED', 'This clip’s speech track is too large to transcribe (over 25 MB).', { details: { size } });
    }
    const bytes = await readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: audioMimeType(audioPath) }), path.basename(audioPath));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (opts.language) form.append('language', opts.language);

    let res: Response;
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw new CancelledError();
      throw new AppError('PROCESSING_FAILED', 'The transcription service could not be reached. Please try again shortly.', { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger?.warn({ status: res.status, body: body.slice(0, 300) }, 'transcription request failed');
      if (res.status === 401 || res.status === 403) throw new AppError('INTEGRATION_NOT_CONFIGURED', 'The OpenAI API key was not accepted. Check the transcription settings.');
      if (res.status === 429) throw new AppError('RATE_LIMITED', 'The transcription service is busy right now. Please try again in a few minutes.');
      if (res.status === 413) throw new AppError('UNSUPPORTED', 'This clip’s speech track is too large to transcribe.');
      throw new AppError('PROCESSING_FAILED', 'The transcription service could not process this clip.', { details: { status: res.status } });
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AppError('PROCESSING_FAILED', 'The transcription service returned an unreadable answer.', { cause: err });
    }
    const parsed = VerboseJsonSchema.safeParse(json);
    if (!parsed.success) throw new AppError('PROCESSING_FAILED', 'The transcription service returned an unexpected answer.');
    return { provider: 'openai', language: parsed.data.language ?? null, segments: toSegments(parsed.data.segments ?? []) };
  }
}

/** Keeps non-empty segments with a valid time range, text trimmed but otherwise verbatim. */
export function toSegments(raw: Array<{ start: number; end: number; text: string }>): TranscriptSegment[] {
  return raw
    .map((s) => ({ startSec: Math.max(0, s.start), endSec: s.end, text: s.text.trim() }))
    .filter((s) => s.text.length > 0 && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec && s.endSec > 0)
    .sort((a, b) => a.startSec - b.startSec);
}
