'use client';

import { ApiClientError, apiRequest } from './api-client.js';
import { PART_MAX_ATTEMPTS, checkUploadFile, missingParts, partRange, receivedBytes, resumeStorageKey, retryDelayMs, type UploadKind } from '../shared/upload-math.js';

/** Where one file is in its upload. */
export type UploadState = 'queued' | 'uploading' | 'paused' | 'finishing' | 'done' | 'failed' | 'cancelled';

/** One file in the upload list, as rendered by the drop zone. */
export interface UploadItem {
  key: string;
  name: string;
  size: number;
  kind: UploadKind;
  state: UploadState;
  uploadedBytes: number;
  /** Plain message for failed uploads, or a note such as "Trying again (2 of 3)…". */
  message: string;
  /** Clip or track id once finished. */
  resultId: string | null;
  /** False when the file itself cannot be accepted (wrong type, empty, too large). */
  canRetry: boolean;
}

interface InternalItem extends UploadItem {
  file: File;
  projectId: string;
  uploadId: string | null;
  partSize: number;
  received: Set<number>;
  completeBody: Record<string, unknown>;
  controller: AbortController | null;
}

interface SessionResponse {
  uploadId: string;
  size: number;
  partSize: number;
  partCount: number;
  receivedParts: number[];
  status: 'open' | 'completed' | 'aborted' | 'expired';
  assetId: string | null;
}

class PartError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function readResume(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeResume(key: string, uploadId: string | null): void {
  try {
    if (uploadId) window.localStorage.setItem(key, uploadId);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing or full storage: uploads still work, they just cannot resume after a reload.
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Chunked, resumable uploader used by the Video Studio. Files are sent in 8 MiB parts (two files at a time),
 * each part retried up to three times with back-off. The upload id is remembered in localStorage under the
 * file's name, size and last-modified time, so dropping the same file after a reload continues where it
 * stopped. Pause aborts the part in flight; resume asks the server which parts it already has.
 */
export class ChunkedUploader {
  private items: InternalItem[] = [];
  private snapshot: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private readonly concurrency: number;
  private readonly onFinished: (item: UploadItem) => void;

  constructor(options: { concurrency?: number; onFinished: (item: UploadItem) => void }) {
    this.concurrency = options.concurrency ?? 2;
    this.onFinished = options.onFinished;
  }

  /** Subscribe to list changes (for useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Current list of uploads (stable reference between changes). */
  getSnapshot = (): UploadItem[] => this.snapshot;

  private emit(): void {
    this.snapshot = this.items.map(({ key, name, size, kind, state, uploadedBytes, message, resultId, canRetry }) => ({ key, name, size, kind, state, uploadedBytes, message, resultId, canRetry }));
    for (const l of this.listeners) l();
  }

  private update(item: InternalItem, patch: Partial<InternalItem>): void {
    Object.assign(item, patch);
    this.emit();
  }

  /**
   * Adds files to the queue. Files of the wrong type or over the size limit are listed as failed with a plain
   * reason instead of being sent. `completeBody` is sent when finishing (music licence details).
   */
  add(files: File[], options: { projectId: string; kind: UploadKind; maxBytes: number; completeBody?: Record<string, unknown> }): void {
    for (const file of files) {
      const key = resumeStorageKey(options.projectId, file);
      const existing = this.items.find((i) => i.key === key && (i.state === 'uploading' || i.state === 'queued' || i.state === 'finishing'));
      if (existing) continue;
      this.items = this.items.filter((i) => i.key !== key);
      const check = checkUploadFile({ filename: file.name, mimeType: file.type, kind: options.kind });
      let message = '';
      if (!check.ok) message = check.reason;
      else if (file.size === 0) message = 'This file is empty.';
      else if (file.size > options.maxBytes) message = `This file is too large (limit ${(options.maxBytes / 1024 ** 3).toFixed(1)} GB).`;
      this.items.push({
        key,
        name: file.name,
        size: file.size,
        kind: options.kind,
        state: message ? 'failed' : 'queued',
        uploadedBytes: 0,
        message,
        resultId: null,
        canRetry: !message,
        file,
        projectId: options.projectId,
        uploadId: null,
        partSize: 0,
        received: new Set(),
        completeBody: options.completeBody ?? {},
        controller: null,
      });
    }
    this.emit();
    this.pump();
  }

  /** Pauses a file; the part in flight is abandoned and sent again on resume. */
  pause(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (!item || (item.state !== 'uploading' && item.state !== 'queued')) return;
    item.controller?.abort();
    this.update(item, { state: 'paused', message: 'Paused', controller: null });
    this.pump();
  }

  /** Resumes a paused or failed file from the parts the server already has. */
  resume(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (!item || (item.state !== 'paused' && item.state !== 'failed') || !item.canRetry) return;
    this.update(item, { state: 'queued', message: '' });
    this.pump();
  }

  /** Cancels a file and deletes anything already sent. */
  async cancel(key: string): Promise<void> {
    const item = this.items.find((i) => i.key === key);
    if (!item || item.state === 'done' || item.state === 'cancelled') return;
    item.controller?.abort();
    const uploadId = item.uploadId ?? readResume(item.key);
    this.update(item, { state: 'cancelled', message: 'Cancelled', controller: null });
    writeResume(item.key, null);
    if (uploadId) {
      try {
        await apiRequest(`/api/uploads/${uploadId}`, { method: 'DELETE' });
      } catch {
        // The server removes abandoned uploads when they expire; nothing more to do here.
      }
    }
    this.pump();
  }

  /** Removes finished, failed or cancelled rows from the list. */
  dismiss(key: string): void {
    this.items = this.items.filter((i) => !(i.key === key && (i.state === 'done' || i.state === 'failed' || i.state === 'cancelled')));
    this.emit();
  }

  /** Stops everything in flight (when the page unmounts); progress stays resumable. */
  dispose(): void {
    for (const item of this.items) item.controller?.abort();
    this.listeners.clear();
  }

  private pump(): void {
    const active = this.items.filter((i) => i.state === 'uploading' || i.state === 'finishing').length;
    let slots = this.concurrency - active;
    for (const item of this.items) {
      if (slots <= 0) break;
      if (item.state !== 'queued') continue;
      slots--;
      void this.run(item);
    }
  }

  private async openSession(item: InternalItem, signal: AbortSignal): Promise<SessionResponse> {
    const remembered = readResume(item.key);
    if (remembered) {
      try {
        const s = await apiRequest<SessionResponse>(`/api/uploads/${remembered}`, { signal });
        if ((s.status === 'open' || s.status === 'completed') && s.size === item.size) return s;
      } catch (err) {
        if (isAbort(err)) throw err;
      }
      writeResume(item.key, null);
    }
    const created = await apiRequest<SessionResponse>(`/api/projects/${item.projectId}/uploads`, {
      method: 'POST',
      body: { filename: item.name, size: item.size, mimeType: item.file.type, kind: item.kind },
      signal,
    });
    writeResume(item.key, created.uploadId);
    return created;
  }

  private async sendPart(item: InternalItem, n: number, signal: AbortSignal): Promise<void> {
    const range = partRange(n, item.size, item.partSize);
    if (!range || !item.uploadId) throw new PartError('Part of the file could not be read.', false);
    let res: Response;
    try {
      res = await fetch(`/api/uploads/${item.uploadId}/parts/${n}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
        body: item.file.slice(range.start, range.end),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new PartError('The connection dropped.', true);
    }
    if (res.ok) return;
    let message = 'Part of the file could not be sent.';
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      // Keep the generic message.
    }
    if (res.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new PartError(message, res.status >= 500 || res.status === 408 || res.status === 429 || res.status === 400);
  }

  private async run(item: InternalItem): Promise<void> {
    const controller = new AbortController();
    const { signal } = controller;
    this.update(item, { state: 'uploading', message: '', controller });
    try {
      const session = await this.openSession(item, signal);
      item.uploadId = session.uploadId;
      item.partSize = session.partSize;
      item.received = new Set(session.receivedParts);
      if (session.status === 'completed' && session.assetId) {
        writeResume(item.key, null);
        this.update(item, { state: 'done', uploadedBytes: item.size, resultId: session.assetId, message: '', controller: null });
        this.onFinished(this.snapshot.find((s) => s.key === item.key) ?? item);
        return;
      }
      this.update(item, { uploadedBytes: receivedBytes(item.size, [...item.received], item.partSize) });
      for (const n of missingParts(session.partCount, [...item.received])) {
        for (let attempt = 1; ; attempt++) {
          try {
            await this.sendPart(item, n, signal);
            break;
          } catch (err) {
            if (isAbort(err)) throw err;
            const retryable = err instanceof PartError ? err.retryable : true;
            if (!retryable || attempt >= PART_MAX_ATTEMPTS) throw err;
            this.update(item, { message: `Connection trouble, trying again (${attempt + 1} of ${PART_MAX_ATTEMPTS})…` });
            await wait(retryDelayMs(attempt), signal);
          }
        }
        item.received.add(n);
        this.update(item, { uploadedBytes: receivedBytes(item.size, [...item.received], item.partSize), message: '' });
      }
      this.update(item, { state: 'finishing', message: 'Finishing…' });
      const done = await apiRequest<{ assetId: string }>(`/api/uploads/${item.uploadId}/complete`, { method: 'POST', body: item.completeBody, signal });
      writeResume(item.key, null);
      this.update(item, { state: 'done', resultId: done.assetId, uploadedBytes: item.size, message: '', controller: null });
      this.onFinished(this.snapshot.find((s) => s.key === item.key) ?? item);
    } catch (err) {
      if (isAbort(err)) return;
      let message = err instanceof Error && err.message ? err.message : 'The upload stopped.';
      if (err instanceof ApiClientError && err.code === 'CONFLICT' && /cancelled|expired|add the file again/i.test(err.message)) {
        writeResume(item.key, null);
        item.uploadId = null;
      }
      if (err instanceof PartError && err.retryable) message = `${message} Press Retry to continue from where it stopped.`;
      if (item.state === 'uploading' || item.state === 'finishing') this.update(item, { state: 'failed', message, controller: null });
    } finally {
      if (item.controller === controller) item.controller = null;
      this.pump();
    }
  }
}
