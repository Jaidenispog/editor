import { CancelledError } from '@studio/core';
import type { TrackedRun } from '../../src/lib/job-tracker.js';

/** A TrackedRun for calling handlers directly in tests; it records progress messages. */
export function fakeRun(options: { willRetry?: boolean } = {}): TrackedRun & { messages: string[]; abort: () => void } {
  const controller = new AbortController();
  const messages: string[] = [];
  return {
    jobId: 'test-job',
    signal: controller.signal,
    willRetry: options.willRetry ?? true,
    messages,
    abort: () => controller.abort(new CancelledError('Cancelled in test')),
    progress: async (_fraction, message) => {
      if (message) messages.push(message);
    },
    message: async (message) => {
      messages.push(message);
    },
    checkCancelled: () => {
      if (controller.signal.aborted) throw new CancelledError('Cancelled in test');
    },
    cancelledByOwner: async () => controller.signal.aborted,
  };
}

/** One recorded call to a fake fetch. */
export interface FakeCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

/** A fetch replacement that answers from `respond` and records every call (no network access). */
export function fakeFetch(respond: (call: FakeCall) => Response | Promise<Response>): typeof fetch & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    const call = { url: String(input instanceof Request ? input.url : input), method: (init?.method ?? 'GET').toUpperCase(), body, headers };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason;
    return respond(call);
  };
  return Object.assign(impl as typeof fetch, { calls });
}

/** JSON response helper. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
