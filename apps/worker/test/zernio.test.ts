import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HttpTimeoutError } from '../src/lib/http.js';
import { ZERNIO_CHOOSE_AGAIN_MESSAGE, ZERNIO_KEY_REFUSED_MESSAGE, ZERNIO_RECONNECT_MESSAGE, ZernioApiError, mapZernioError } from '../src/publishing/errors.js';
import { mapZernioPost, putToUploadUrl, uploadTestOrigin, zernioEnabled } from '../src/publishing/zernio.js';

/** Zernio adapter rules without a network (design §7.2.4 error mapping and step 6; publishing §11.1). */

const apiError = (status: number, code: string | null = null, details: Record<string, unknown> = {}, requiredGroup: string | null = null) => new ZernioApiError(status, null, code, 'Something went wrong', details, null, requiredGroup);

describe('mapZernioError (status, type and code only; never the error text)', () => {
  it('maps the documented answers', () => {
    expect(mapZernioError(apiError(401, 'invalid_credentials'))).toMatchObject({ kind: 'reauth_key', message: ZERNIO_KEY_REFUSED_MESSAGE });
    expect(mapZernioError(apiError(403, 'insufficient_permissions', {}, 'publishing'))).toMatchObject({ kind: 'key_scope', message: "This Zernio key can't use publishing. Create a key with Accounts and Publishing switched on." });
    expect(mapZernioError(apiError(403, 'ACCOUNT_DISCONNECTED'))).toMatchObject({ kind: 'reauth_account', message: ZERNIO_RECONNECT_MESSAGE });
    expect(mapZernioError(apiError(403))).toMatchObject({ kind: 'reauth_account', message: ZERNIO_CHOOSE_AGAIN_MESSAGE });
    expect(mapZernioError(apiError(403, 'PROFILE_OVER_LIMIT')).kind).toBe('account_blocked');
    expect(mapZernioError(apiError(409, null, { existingPostId: 'p1' })).kind).toBe('duplicate');
    expect(mapZernioError(apiError(409, 'ads_connection_required'))).toMatchObject({ kind: 'conflict', retryable: true });
    expect(mapZernioError(apiError(400, 'validation_error'))).toMatchObject({ kind: 'refused', retryable: true });
    expect(mapZernioError(apiError(422)).kind).toBe('refused');
    expect(mapZernioError(apiError(404)).kind).toBe('not_found');
  });

  it('any 402 is billing, whatever the code string', () => {
    for (const code of ['PAYMENT_REQUIRED', 'payment_required', 'insufficient_balance', null]) expect(mapZernioError(apiError(402, code)).kind).toBe('billing');
  });

  it('before a create, unclear failures are transient; after it they are unknown (never sent again)', () => {
    for (const err of [apiError(503), apiError(500), new HttpTimeoutError('zernio.create_post', 1000), new Error('socket hang up'), apiError(409, 'idempotency_conflict')]) {
      expect(mapZernioError(err).kind).toBe('transient');
      expect(mapZernioError(err, { afterCreate: true }).kind).toBe('unknown');
    }
    expect(mapZernioError(apiError(429)).kind).toBe('rate_limited');
    expect(mapZernioError(apiError(429), { afterCreate: true }).kind).toBe('unknown');
  });

  it('shows Zernio\'s own words only as text', () => {
    expect(mapZernioError(apiError(400)).message).toBe('Zernio refused this post. Zernio said: Something went wrong');
  });
});

describe('mapZernioPost (design §7.2.4 step 6)', () => {
  const post = (status: string, entry: Record<string, unknown>) => ({ _id: 'p', status, platforms: [{ platform: 'tiktok', ...entry }] });

  it('published with and without a link; a link is only a real TikTok post link', () => {
    expect(mapZernioPost(post('published', { status: 'published', platformPostUrl: 'https://www.tiktok.com/@shop/video/7311111111111111111' }), 'publish')).toMatchObject({ kind: 'published', url: 'https://www.tiktok.com/@shop/video/7311111111111111111' });
    expect(mapZernioPost(post('published', { status: 'published', platformPostUrl: null }), 'publish')).toMatchObject({ kind: 'published', url: null });
    expect(mapZernioPost(post('published', { status: 'published', platformPostUrl: 'https://evil.example/video/1' }), 'publish')).toMatchObject({ kind: 'published', url: null });
    expect(mapZernioPost(post('published', { status: 'published', platformPostUrl: 'https://www.tiktok.com/@shop/video/7311111111111111111', removedFromPlatformAt: '2026-11-15T00:00:00Z' }), 'publish')).toMatchObject({ kind: 'published', removed: true });
  });

  it('a delivered draft by either key, or by our own delivery', () => {
    expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: { isDraft: true } }), 'publish').kind).toBe('draft_delivered');
    expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: { tiktokSettings: { draft: true } } }), 'publish').kind).toBe('draft_delivered');
    expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: {} }), 'draft').kind).toBe('draft_delivered');
    // The creator posted the draft publicly later: the link appears and it counts as published.
    expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: { isDraft: true }, platformPostUrl: 'https://www.tiktok.com/@shop/video/7311111111111111111' }), 'draft').kind).toBe('published');
  });

  it('a draft with an address that is not a TikTok post link stays a draft, never "published"', () => {
    for (const platformPostUrl of ['https://www.tiktok.com/@shop', 'https://evil.example/@shop/video/7311111111111111111', 'not a link']) {
      expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: { isDraft: true }, platformPostUrl }), 'publish').kind).toBe('draft_delivered');
      expect(mapZernioPost(post('published', { status: 'published', platformSpecificData: {}, platformPostUrl }), 'draft').kind).toBe('draft_delivered');
    }
  });

  it('held, processing, failed, cancelled and the bug guard', () => {
    expect(mapZernioPost(post('scheduled', { status: 'pending' }), 'publish').kind).toBe('queued');
    expect(mapZernioPost(post('scheduled', { status: 'pending' }), 'publish', { dailyCapReached: true })).toMatchObject({ kind: 'queued', message: "TikTok's daily limit is reached; Zernio will post it when allowed." });
    expect(mapZernioPost(post('publishing', { status: 'uploading' }), 'publish').kind).toBe('processing');
    expect(mapZernioPost(post('failed', { status: 'failed', errorMessage: 'x', errorSource: 'platform' }), 'publish')).toMatchObject({ kind: 'failed', retryable: true });
    expect(mapZernioPost(post('failed', { status: 'failed', errorMessage: 'x', errorSource: 'user' }), 'publish')).toMatchObject({ kind: 'failed', retryable: false });
    expect(mapZernioPost(post('failed', { status: 'failed', errorCategory: 'auth_expired' }), 'publish')).toMatchObject({ kind: 'failed', reauth: true });
    expect(mapZernioPost(post('failed', { status: 'failed', errorMessage: 'You have created too many posts in the last 24 hours via the API' }), 'publish')).toMatchObject({ kind: 'failed', message: "TikTok's own daily limit is reached. Try again tomorrow.", retryable: true });
    expect(mapZernioPost(post('failed', { status: 'failed', errorMessage: 'TikTok direct posting is at capacity right now' }), 'publish')).toMatchObject({ kind: 'failed', message: expect.stringMatching(/TikTok is busy/) });
    expect(mapZernioPost(post('cancelled', { status: 'cancelled' }), 'publish')).toMatchObject({ kind: 'failed', message: 'Cancelled inside Zernio.', retryable: false });
    expect(mapZernioPost(post('draft', { status: 'pending' }), 'publish')).toMatchObject({ kind: 'failed', retryable: false });
    expect(mapZernioPost(post('pending_approval', { status: 'pending' }), 'publish').kind).toBe('failed');
  });
});

describe('the upload transport (the upload address comes from a response, so it is untrusted)', () => {
  const body = () => Readable.from([Buffer.from('x')]);

  it('refuses plain http, odd ports, credentials and private addresses before connecting', async () => {
    await expect(putToUploadUrl('http://storage.example/u', body(), 1)).rejects.toThrow(/not https/);
    await expect(putToUploadUrl('https://storage.example:8443/u', body(), 1)).rejects.toThrow(/unexpected port/);
    await expect(putToUploadUrl('https://user:pw@storage.example/u', body(), 1)).rejects.toThrow(/unexpected port/);
    await expect(putToUploadUrl('https://storage.example/u', body(), 1, { resolver: async () => [{ address: '10.0.0.5', family: 4 }] })).rejects.toThrow(/private or reserved/);
    await expect(putToUploadUrl('https://127.0.0.1/u', body(), 1)).rejects.toThrow(/private or reserved/);
    await expect(putToUploadUrl('not a url', body(), 1)).rejects.toThrow(/not a valid link/);
  });

  it('allows the local fake only under NODE_ENV=test, and only its exact origin', () => {
    expect(uploadTestOrigin({ NODE_ENV: 'test', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'http://127.0.0.1:4567/api' })).toBe('http://127.0.0.1:4567');
    expect(uploadTestOrigin({ NODE_ENV: 'production', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'http://127.0.0.1:4567/api' })).toBeNull();
    expect(uploadTestOrigin({ NODE_ENV: 'development', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'http://127.0.0.1:4567/api' })).toBeNull();
    expect(uploadTestOrigin({ NODE_ENV: 'test', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'https://zernio.com/api' })).toBeNull();
  });

  it('runs only when the flag is on and the address is set', () => {
    expect(zernioEnabled({ NODE_ENV: 'production', TIKTOK_PUBLISH_PROVIDER: 'none', ZERNIO_API_BASE_URL: 'https://zernio.com/api' })).toBe(false);
    expect(zernioEnabled({ NODE_ENV: 'production', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: undefined })).toBe(false);
    expect(zernioEnabled({ NODE_ENV: 'production', TIKTOK_PUBLISH_PROVIDER: 'zernio', ZERNIO_API_BASE_URL: 'https://zernio.com/api' })).toBe(true);
  });
});
