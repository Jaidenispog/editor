import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Env } from '@studio/config';
import { gbpGet } from '../src/lib/google/business-profile.js';
import { listSites } from '../src/lib/google/search-console.js';
import { fakeFetch, json } from './helpers/fakes.js';

const logger = pino({ level: 'silent' });
const FAKE = 'http://127.0.0.1:4600';
const envOf = (NODE_ENV: Env['NODE_ENV']) => ({ NODE_ENV, GOOGLE_API_BASE_URL: FAKE }) as Env;

/** GOOGLE_API_BASE_URL (Stage C website browser test) moves Google calls to the local fake only under NODE_ENV=test. */
describe('Google addresses', () => {
  it('calls Google itself unless NODE_ENV=test and GOOGLE_API_BASE_URL are both set', async () => {
    for (const env of [undefined, envOf('production'), envOf('development')]) {
      const f = fakeFetch(() => json(200, { siteEntry: [] }));
      await listSites({ fetch: f, logger, ...(env ? { env } : {}) }, 'token');
      expect(f.calls[0]?.url).toBe('https://searchconsole.googleapis.com/webmasters/v3/sites');
    }
  });

  it('under NODE_ENV=test sends the same path to the fake, keeping the Google host as the first path segment', async () => {
    const f = fakeFetch(() => json(200, { accounts: [], siteEntry: [] }));
    const env = envOf('test');
    await gbpGet({ fetch: f, logger, env }, 'token', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20', 'google.gbp.accounts', 'API');
    await listSites({ fetch: f, logger, env }, 'token');
    expect(f.calls.map((c) => c.url)).toEqual([`${FAKE}/mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20`, `${FAKE}/searchconsole.googleapis.com/webmasters/v3/sites`]);
  });
});
