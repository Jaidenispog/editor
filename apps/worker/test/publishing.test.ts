import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ALL_JOB_TYPES } from '@studio/core';
import { QUEUE_SETTINGS } from '@studio/queue';
import { GraphApiError, appSecretProof } from '../src/lib/meta/graph.js';
import { HttpTimeoutError } from '../src/lib/http.js';
import { DISCOVERY_HINT, mapGraphError } from '../src/publishing/errors.js';
import { publishingModule } from '../src/modules/publishing/index.js';
import { isDue } from '../src/handlers/publish-prepare.js';
import { postIsLive } from '../src/handlers/publish-target.js';

const g = (status: number, code: number | null, subcode: number | null = null) => new GraphApiError(status, code, subcode, `Meta message ${code}/${subcode}`, null);

describe('mapGraphError (memo §4 third-party meanings; Meta message always kept)', () => {
  it.each([
    [g(400, 190), 'reauth', false],
    [g(400, 190, 463), 'reauth', false],
    [g(400, 10), 'permission', false],
    [g(403, 200), 'permission', false],
    [g(400, 4), 'transient', true],
    [g(400, 17), 'transient', true],
    [g(400, 32), 'transient', true],
    [g(400, 613), 'transient', true],
    [g(400, 9007), 'not_ready', true],
    [g(400, 100, 2207027), 'not_ready', true],
    [g(400, 100, 2207042), 'quota', true],
    [g(400, 100, 2207026), 'permanent', false],
    [g(400, 100, 2207050), 'permanent', false],
    [g(400, 100, 2207051), 'permanent', false],
    [g(400, 100, 2207003), 'transient', true],
    [g(400, 100, 33), 'discovery', false],
    [g(500, 1), 'transient', true],
    [g(502, null), 'transient', true],
    [g(400, 100), 'permanent', false],
  ] as const)('%s → %s', (err, kind, retryable) => {
    const m = mapGraphError(err);
    expect(m.kind).toBe(kind);
    expect(m.retryable).toBe(retryable);
    if (kind !== 'not_ready' && kind !== 'discovery') expect(m.message).toContain(err.message);
  });
  it('treats time-outs and network failures as transient, and uses the discovery hint', () => {
    expect(mapGraphError(new HttpTimeoutError('meta.rupload', 1000)).kind).toBe('transient');
    expect(mapGraphError(new Error('socket hang up')).kind).toBe('transient');
    expect(mapGraphError(g(400, 100, 33)).message).toBe(DISCOVERY_HINT);
  });
});

describe('Graph hardening', () => {
  it('computes appsecret_proof as HMAC-SHA256(app secret, token)', () => {
    expect(appSecretProof('secret', 'token')).toBe(createHmac('sha256', 'secret').update('token').digest('hex'));
  });
});

describe('publishing worker module', () => {
  it('registers one handler, queue setting and ref id for each publishing job type, and two keyed crons', () => {
    const types = ALL_JOB_TYPES.filter((t) => t.startsWith('publish.') || t === 'social.check');
    expect(types.sort()).toEqual(['publish.dispatch', 'publish.poll', 'publish.prepare', 'publish.target', 'social.check']);
    expect((publishingModule.handlers ?? []).map((h) => h.type).sort()).toEqual(types);
    for (const t of types) expect(QUEUE_SETTINGS[t]).toBeTruthy();
    expect(QUEUE_SETTINGS['publish.target'].policy).toBe('stately');
    expect(publishingModule.crons).toEqual([
      { type: 'publish.dispatch', cron: '* * * * *', payload: {}, key: 'every-minute' },
      { type: 'social.check', cron: '23 4 * * *', payload: { connectionId: null, reason: 'daily' }, key: 'daily' },
    ]);
    expect(publishingModule.refIdFor?.('publish.target', { targetId: 't1' })).toBe('t1');
    expect(publishingModule.refIdFor?.('publish.prepare', { postId: 'p1' })).toBe('p1');
    expect(publishingModule.refIdFor?.('render.export', { editVersionId: 'v' })).toBeUndefined();
    expect(publishingModule.exportReadyHooks).toHaveLength(1);
  });
  it('decides when a post is due and whether it is still live', () => {
    const now = new Date('2026-11-14T00:00:00Z');
    expect(isDue({ mode: 'now', scheduledFor: null }, now)).toBe(true);
    expect(isDue({ mode: 'scheduled', scheduledFor: new Date('2026-11-14T00:01:00Z') }, now)).toBe(false);
    expect(isDue({ mode: 'scheduled', scheduledFor: new Date('2026-11-13T23:59:00Z') }, now)).toBe(true);
    expect(postIsLive({ approvedAt: null, status: 'draft' })).toBe(false);
    expect(postIsLive({ approvedAt: now, status: 'cancelled' })).toBe(false);
    expect(postIsLive({ approvedAt: now, status: 'partial' })).toBe(true);
  });
});
