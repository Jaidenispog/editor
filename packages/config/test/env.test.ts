import { describe, expect, it } from 'vitest';
import { describeCapabilities, loadEnv } from '../src/index.js';

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
