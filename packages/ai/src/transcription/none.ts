import { CancelledError } from '@studio/core';
import type { TranscribeOptions, Transcriber, TranscriptionResult } from '../types.js';

/** Transcriber used when no speech-to-text provider is configured: it reports no speech, never invented text. */
export class NoneTranscriber implements Transcriber {
  readonly name = 'none';

  /** Always returns an empty transcript. */
  async transcribe(_audioPath: string, opts: TranscribeOptions = {}): Promise<TranscriptionResult> {
    if (opts.signal?.aborted) throw new CancelledError();
    return { provider: 'none', language: null, segments: [] };
  }
}
