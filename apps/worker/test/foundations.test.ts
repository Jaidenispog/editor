import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ALL_JOB_TYPES } from '@studio/core';
import { allHandlers, assertHandlersCoverJobTypes, coreHandlers } from '../src/main.js';
import { HttpTimeoutError, hashEmail, httpRequest, redact, redactHeaders, redactUrl } from '../src/lib/http.js';
import { AUDIT_TEXT_MAX, sanitiseAuditData } from '../src/lib/audit.js';
import { refIdFor } from '../src/lib/jobs.js';
import { decryptCredential, encryptCredential } from '../src/lib/credentials.js';
import { WORKER_MODULES, defineHandler, moduleCrons, moduleHandlers, runExportReadyHooks, webhookHandlerFor, type WorkerModule } from '../src/modules/index.js';
import type { WorkerContext } from '../src/context.js';
import { fakeFetch, json } from './helpers/fakes.js';

const logger = pino({ level: 'silent' });
const noop = async () => undefined;

describe('handler registry', () => {
  it('covers every registered job type exactly once with the module stubs in place', () => {
    const handlers = allHandlers(1);
    expect(() => assertHandlersCoverJobTypes(handlers)).not.toThrow();
    expect(handlers.map((h) => h.type).sort()).toEqual([...ALL_JOB_TYPES].sort());
    expect(WORKER_MODULES.map((m) => m.name)).toEqual(['music', 'preferences', 'trends', 'publishing', 'square', 'email', 'website', 'business_profile']);
  });

  it('refuses to start when a registered type has no handler', () => {
    const withoutCleanup = coreHandlers(1).filter((h) => h.type !== 'maintenance.cleanup');
    expect(() => assertHandlersCoverJobTypes(withoutCleanup)).toThrow(/No handler registered for: maintenance.cleanup/);
    expect(() => assertHandlersCoverJobTypes(coreHandlers(1), [...ALL_JOB_TYPES, 'square.sync'])).toThrow(/No handler registered for: square.sync/);
  });

  it('refuses duplicate handlers and handlers for unknown types', () => {
    const dup: WorkerModule = { name: 'dup', handlers: [defineHandler('render.export', noop)] };
    expect(() => assertHandlersCoverJobTypes(allHandlers(1, [dup]))).toThrow(/More than one handler registered for: render.export/);
    const stray = { type: 'nope.never', handler: noop } as unknown as ReturnType<typeof defineHandler>;
    expect(() => assertHandlersCoverJobTypes([...coreHandlers(1), stray])).toThrow(/unknown job types: nope.never/);
    expect(() => moduleHandlers([dup, { ...dup, name: 'dup2' }])).toThrow(/both the dup and dup2 modules/);
  });

  it('collects keyed crons, refusing a repeated key on one queue', () => {
    const m: WorkerModule = {
      name: 'm',
      crons: [
        { type: 'maintenance.cleanup', cron: '0 3 * * *', payload: {}, key: 'daily' },
        { type: 'maintenance.cleanup', cron: '0 4 * * 1', payload: {}, key: 'weekly' },
      ],
    };
    expect(moduleCrons([m])).toHaveLength(2);
    expect(() => moduleCrons([m, { name: 'n', crons: [{ type: 'maintenance.cleanup', cron: '* * * * *', payload: {}, key: 'daily' }] }])).toThrow(/daily/);
  });

  it('finds webhook handlers by provider and none for others', () => {
    const handler = vi.fn(noop);
    const m: WorkerModule = { name: 'square', webhookHandlers: { square: handler } };
    expect(webhookHandlerFor('square', [m])).toBe(handler);
    expect(webhookHandlerFor('postmark', [m])).toBeNull();
    expect(webhookHandlerFor('toString', [m])).toBeNull();
    expect(webhookHandlerFor('square')).toBeNull();
  });

  it('runs every export-ready hook even when one fails', async () => {
    const calls: string[] = [];
    const ctx = { logger } as unknown as WorkerContext;
    const event = { editVersionId: 'v1', editId: 'e1', projectId: 'p1', variant: 'standard', storageKey: 'k', byteSize: 1 };
    await runExportReadyHooks(ctx, event, [
      async () => {
        calls.push('a');
        throw new Error('boom');
      },
      async (_c, e) => {
        calls.push(`b:${e.editVersionId}`);
      },
    ]);
    expect(calls).toEqual(['a', 'b:v1']);
  });

  it('gives shared jobs a ref id', () => {
    expect(refIdFor('webhook.process', { webhookEventId: 'w1' })).toBe('w1');
    expect(refIdFor('google.disconnect', { connectionId: 'c1' })).toBe('c1');
    expect(refIdFor('render.export', { editVersionId: 'v1', projectId: 'p' })).toBe('v1');
  });
});

describe('http helper', () => {
  it('redacts secrets in URLs, headers, forms and JSON, and hashes emails', () => {
    expect(redactUrl('https://graph.example.com/me?access_token=abc&fields=id&appsecret_proof=xyz')).toBe(
      'https://graph.example.com/me?access_token=%5Bredacted%5D&fields=id&appsecret_proof=%5Bredacted%5D',
    );
    expect(redactHeaders({ Authorization: 'Bearer abc', 'X-Postmark-Server-Token': 't', 'X-Goog-Api-Key': 'k', accept: 'application/json' })).toEqual({
      authorization: '[redacted]',
      'x-postmark-server-token': '[redacted]',
      'x-goog-api-key': '[redacted]',
      accept: 'application/json',
    });
    expect(redact('grant_type=authorization_code&code=4%2Fabc&client_secret=s&redirect_uri=x')).toBe('grant_type=authorization_code&code=%5Bredacted%5D&client_secret=%5Bredacted%5D&redirect_uri=x');
    const out = redact({ input_token: 'a', nested: { refresh_token: 'b', to: 'Jo <jo@example.com>' }, list: ['sam@example.com.au'] }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/jo@example|sam@example|"a"|"b"/);
    expect(JSON.stringify(out)).toContain(hashEmail('jo@example.com'));
    expect(hashEmail('Jo@Example.com ')).toBe(hashEmail('jo@example.com'));
  });

  it('passes the response through and uses the injected fetch', async () => {
    const f = fakeFetch(() => json(503, { error: 'busy' }));
    const res = await httpRequest({ fetch: f, logger }, 'https://api.example.com/x?key=secret', { method: 'POST', body: 'a=1' }, { label: 'test.call' });
    expect(res.status).toBe(503);
    expect(f.calls[0]).toMatchObject({ url: 'https://api.example.com/x?key=secret', method: 'POST', body: 'a=1' });
  });

  it('times out with a plain error and honours the run signal', async () => {
    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(httpRequest({ fetch: slow, logger }, 'https://api.example.com/slow', {}, { label: 'slow.call', timeoutMs: 50 })).rejects.toBeInstanceOf(HttpTimeoutError);
    const run = new AbortController();
    const pending = httpRequest({ fetch: slow, logger }, 'https://api.example.com/slow', {}, { label: 'slow.call', signal: run.signal, timeoutMs: 5000 });
    run.abort(new Error('owner cancelled'));
    await expect(pending).rejects.toThrow('owner cancelled');
  });
});

describe('audit and credentials', () => {
  it('keeps audit data short and free of secrets and email addresses', () => {
    const data = sanitiseAuditData({ code: 'invalid_grant', message: 'x'.repeat(500), access_token: 'secret', to: 'jo@example.com' });
    expect((data['message'] as string).length).toBe(AUDIT_TEXT_MAX);
    expect(data['access_token']).toBe('[redacted]');
    expect(data['to']).toBe(hashEmail('jo@example.com'));
  });

  it('encrypts credentials with the app key and detects tampering', () => {
    const env = { APP_SECRET: 'test-secret-test-secret-test-secret-0123', APP_ENCRYPTION_KEY: undefined };
    const stored = encryptCredential(env, 'refresh-token-value');
    expect(stored).not.toContain('refresh-token-value');
    expect(decryptCredential(env, stored)).toBe('refresh-token-value');
    expect(() => decryptCredential({ ...env, APP_SECRET: 'another-secret-another-secret-another-1' }, stored)).toThrow();
  });
});
