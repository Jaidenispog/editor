import { describe, expect, it } from 'vitest';
import { describeCapabilities, loadEnv, testOnlyBaseUrl } from '../src/index.js';

const base = {
  DATABASE_URL: 'postgres://localhost/studio',
  APP_SECRET: 'test-secret-test-secret-test-secret-0123',
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('keeps transcription off and pool sizes unset by default', () => {
    const env = loadEnv({ ...base });
    expect(env.TRANSCRIPTION_PROVIDER).toBe('none');
    expect(env.DEEPGRAM_MODEL).toBe('nova-3');
    expect(env.DB_POOL_MAX).toBeUndefined();
    expect(env.QUEUE_POOL_MAX).toBeUndefined();
    expect(describeCapabilities(env).ai.transcription).toBeNull();
  });

  it('accepts Deepgram with a key and reports it without the key', () => {
    const env = loadEnv({ ...base, TRANSCRIPTION_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg-secret' });
    const caps = describeCapabilities(env);
    expect(caps.ai.transcription).toEqual({ provider: 'deepgram', model: 'nova-3' });
    expect(JSON.stringify(caps)).not.toContain('dg-secret');
  });

  it('refuses Deepgram without a key', () => {
    expect(() => loadEnv({ ...base, TRANSCRIPTION_PROVIDER: 'deepgram' })).toThrow(/DEEPGRAM_API_KEY/);
  });

  it('leaves every Stage B/C integration off by default with plain defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.META_GRAPH_VERSION).toBe('v26.0');
    expect(env.TIKTOK_PUBLISH_PROVIDER).toBe('none');
    expect(env.EMAIL_PROVIDER).toBe('none');
    expect(env.POSTMARK_TRANSACTIONAL_STREAM).toBe('outbound');
    expect(env.POSTMARK_BROADCAST_STREAM).toBe('broadcast');
    expect(env.AI_WEBSITE_MODEL).toBe('claude-haiku-5-5');
    const caps = describeCapabilities(env);
    expect(caps.integrations).toEqual({ instagram: false, tiktok: false, square: false, email: false, google: false });
    expect(caps.modules.trends.youtubeChart).toBe(false);
    expect(caps.modules.website.aiWordingModel).toBeNull();
  });

  it('reports configured modules without secret values', () => {
    const env = loadEnv({
      ...base,
      META_APP_ID: 'app',
      META_APP_SECRET: 'meta-secret',
      META_LOGIN_CONFIG_ID: 'cfg',
      EMAIL_PROVIDER: 'postmark',
      POSTMARK_SERVER_TOKEN: 'pm-secret',
      EMAIL_FROM: 'Studio <hello@example.com.au>',
      YOUTUBE_API_KEY: 'yt-secret',
      ZERNIO_API_BASE_URL: '',
    });
    const caps = describeCapabilities(env);
    expect(caps.integrations.instagram).toBe(true);
    expect(caps.integrations.email).toBe(true);
    expect(caps.modules.trends.youtubeChart).toBe(true);
    expect(env.ZERNIO_API_BASE_URL).toBeUndefined();
    const text = JSON.stringify(caps);
    for (const secret of ['meta-secret', 'pm-secret', 'yt-secret']) expect(text).not.toContain(secret);
  });

  it('refuses Postmark without a token or sender, and malformed URLs and versions', () => {
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'postmark', EMAIL_FROM: 'a@b.co' })).toThrow(/POSTMARK_SERVER_TOKEN/);
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'postmark', POSTMARK_SERVER_TOKEN: 't' })).toThrow(/EMAIL_FROM/);
    expect(() => loadEnv({ ...base, SQUARE_WEBHOOK_NOTIFICATION_URL: 'not a url' })).toThrow(/SQUARE_WEBHOOK_NOTIFICATION_URL/);
    expect(() => loadEnv({ ...base, META_GRAPH_VERSION: '26' })).toThrow(/META_GRAPH_VERSION/);
  });

  it('honours test-only base URLs only under NODE_ENV=test', () => {
    expect(testOnlyBaseUrl({ NODE_ENV: 'test' }, 'http://127.0.0.1:4010/')).toBe('http://127.0.0.1:4010');
    expect(testOnlyBaseUrl({ NODE_ENV: 'production' }, 'http://127.0.0.1:4010')).toBeNull();
    expect(testOnlyBaseUrl({ NODE_ENV: 'development' }, 'http://127.0.0.1:4010')).toBeNull();
    expect(testOnlyBaseUrl({ NODE_ENV: 'test' }, undefined)).toBeNull();
    // The login dialog host follows the same rule (Stage B browser test only).
    expect(loadEnv({ ...base, META_DIALOG_BASE_URL: 'http://127.0.0.1:4555' }).META_DIALOG_BASE_URL).toBe('http://127.0.0.1:4555');
    expect(loadEnv({ ...base, META_DIALOG_BASE_URL: '' }).META_DIALOG_BASE_URL).toBeUndefined();
    expect(() => loadEnv({ ...base, META_DIALOG_BASE_URL: 'not a url' })).toThrow(/META_DIALOG_BASE_URL/);
  });

  it('reads optional pool sizes as whole numbers', () => {
    const env = loadEnv({ ...base, DB_POOL_MAX: '4', QUEUE_POOL_MAX: '3' });
    expect(env.DB_POOL_MAX).toBe(4);
    expect(env.QUEUE_POOL_MAX).toBe(3);
    const blank = loadEnv({ ...base, DB_POOL_MAX: '', QUEUE_POOL_MAX: ' ' });
    expect(blank.DB_POOL_MAX).toBeUndefined();
    expect(blank.QUEUE_POOL_MAX).toBeUndefined();
    expect(() => loadEnv({ ...base, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
    expect(() => loadEnv({ ...base, QUEUE_POOL_MAX: '2.5' })).toThrow(/QUEUE_POOL_MAX/);
  });
});
