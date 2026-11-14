/**
 * Website check, prepared changes, WordPress apply and Search Console sync on a real database (TEST_DATABASE_URL),
 * against a local fixture website (test/helpers/fixture-site.ts), an in-memory fake WordPress REST API and a fake
 * Google answering through the injected fetch (design §12.2). Nothing on the internet is contacted. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicWebsiteCopywriter } from '@studio/ai';
import { loadEnv } from '@studio/config';
import { AppSettingsSchema, CancelledError, NonRetryableError, WebsiteAuditResultSchema, newId, settingsSnapshot, siteScopeFrom, type JobType, type WebsiteChange } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import type { WorkerContext } from '../src/context.js';
import { handleSearchSync } from '../src/handlers/search-sync.js';
import { handleWebsiteAudit, trimOldAuditResults } from '../src/handlers/website-audit.js';
import { handleWebsiteConnectionCheck } from '../src/handlers/website-connection-check.js';
import { DRAFTS_REJECTED_MESSAGE, handleWebsiteCopyDraft } from '../src/handlers/website-copy-draft.js';
import { handleWebsiteEditApply } from '../src/handlers/website-edit-apply.js';
import { encryptCredential } from '../src/lib/credentials.js';
import { GOOGLE_TOKEN_URL } from '../src/lib/google/oauth.js';
import type { TrackedRun } from '../src/lib/job-tracker.js';
import { MAX_POLITE_WAIT_SECONDS, crawlSite } from '../src/website/crawl.js';
import type { WebsiteDeps } from '../src/website/deps.js';
import { WebsiteFetcher } from '../src/website/fetcher.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';
import { fakeFetch, fakeRun, json } from './helpers/fakes.js';
import { FIXTURE_HOST, FIXTURE_ROOT, startFixtureSite, type FixtureSite } from './helpers/fixture-site.js';
import { fakeWordPress } from './fakes/wordpress.js';

const logger = pino({ level: 'silent' });
const skip = !testDatabaseUrl();
const NOW = new Date('2026-11-14T03:00:00Z');

describe.skipIf(skip)('website module on a real database with local fakes', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  let tmpRoot: string;
  let ctx: WorkerContext;
  let site: FixtureSite;
  let deps: WebsiteDeps;
  const waits: number[] = [];
  const enqueued: Array<{ type: JobType; payload: unknown }> = [];
  const ownerId = newId();

  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-website-'));
    site = await startFixtureSite();
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: t.url,
      APP_SECRET: 'test-secret-test-secret-test-secret-0123',
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      WORKER_TMP_DIR: tmpRoot,
    });
    ctx = {
      env,
      db: handle.db,
      store: {} as WorkerContext['store'],
      queue: {
        enqueue: async (type: JobType, payload: unknown) => {
          enqueued.push({ type, payload });
          return newId();
        },
      } as unknown as WorkerContext['queue'],
      ai: {} as WorkerContext['ai'],
      logger,
      workerId: 'test-worker',
      fontsDir: '',
      tmpRoot,
      fetch: fakeFetch(() => {
        throw new Error('No network access in tests');
      }),
    };
    let clock = 0;
    deps = {
      fetchPolicy: {
        ...site.policy,
        resolver: async (host) => {
          if (host === `staging.${FIXTURE_HOST}`) return [{ address: '127.0.0.1', family: 4 }];
          return site.policy.resolver!(host);
        },
      },
      copywriter: null,
      now: () => NOW,
      crawlerClock: {
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      },
    };
    await handle.db.insert(schema.users).values({
      id: ownerId,
      email: 'owner@example.com',
      displayName: 'Owner',
      passwordHash: 'x',
      role: 'owner',
    });
    const settings = AppSettingsSchema.parse({
      brand: {
        businessName: 'Ivanhoe Barber Co',
        tagline: 'Fades and beard trims',
      },
      business: {
        website: FIXTURE_ROOT,
        phone: '03 9499 1234',
        addressLine: '12 Upper Heidelberg Rd',
        suburb: 'Ivanhoe',
        postcode: '3079',
        bookingLink: `http://book.example.com/ivanhoe`,
      },
      website: {
        ownershipConfirmedHost: FIXTURE_HOST,
        ownershipConfirmedAt: NOW.toISOString(),
        profileDetailsCheckedAt: NOW.toISOString(),
      },
    });
    await handle.db.insert(schema.settings).values({ id: 'default', data: settings });
  }, 120_000);

  afterAll(async () => {
    await site?.close();
    await drop?.();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    site.onRequest = null;
  });

  async function newAudit(): Promise<string> {
    const id = newId();
    await handle.db.insert(schema.websiteAudits).values({
      id,
      url: FIXTURE_ROOT,
      status: 'queued',
      requestedBy: ownerId,
    });
    return id;
  }
  const auditRow = async (id: string) =>
    (await handle.db.query.websiteAudits.findFirst({
      where: eq(schema.websiteAudits.id, id),
    }))!;
  const edits = () => handle.db.select().from(schema.websiteEdits);

  describe('website.audit against the fixture site', () => {
    let firstEditCount = 0;

    it('crawls politely within the caps, never reads disallowed pages, and stores a valid result with the expected findings', async () => {
      const id = await newAudit();
      site.requests.length = 0;
      await handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, deps);
      const row = await auditRow(id);
      expect(row.status).toBe('partial');
      const result = WebsiteAuditResultSchema.parse(row.result);
      expect(result.limits.hitPageLimit).toBe(true);
      // 25 pages fetched; one is the sitemap's 404 page, so 24 count as checked.
      expect(result.pages.filter((p) => p.skipped === null)).toHaveLength(25);
      expect(row.summary).toMatchObject({ pagesChecked: 24 });
      expect((row.summary as { partialReasons: string[] }).partialReasons.join(' ')).toContain('We stopped at 25 pages');
      // robots.txt: the /private/ folder is never requested; Crawl-delay: 1 spaces requests to the site.
      expect(site.requests.some((r) => r.path.startsWith('/private/'))).toBe(false);
      expect(result.robots.blockedForUs.some((u) => u.includes('/private/'))).toBe(true);
      expect(result.robots.crawlDelaySec).toBe(1);
      expect(waits.length).toBeGreaterThan(20);
      expect(Math.max(...waits)).toBeLessThanOrEqual(1000);
      expect(site.requests.length).toBeLessThanOrEqual(400);
      expect(result.limits.requests).toBeLessThanOrEqual(400);
      const ids = result.findings.map((f) => f.checkId);
      for (const expected of [
        'page_noindex',
        'title_duplicate',
        'title_length',
        'jsonld_invalid',
        'nap_phone_mismatch',
        'image_large',
        'image_oversized',
        'image_missing_dimensions',
        'broken_internal_link',
        'soft_404',
        'sitemap_bad_urls',
        'redirect_chain',
        'https_missing',
        'meta_description_missing',
      ]) {
        expect(ids, expected).toContain(expected);
      }
      expect(result.sitemap).toMatchObject({
        found: true,
        invalid: false,
        homeListed: true,
      });
      expect(result.sitemap.badUrls.map((b) => b.reason).sort()).toEqual(['error', 'redirect']);
      expect(result.platformHint).toBe('unknown');
      // The page's prompt-like text is stored only as capped data.
      expect(result.pages[0]?.textSample).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
      const prepared = await edits();
      firstEditCount = prepared.length;
      const kinds = prepared.map((e) => (e.proposedChange as WebsiteChange).kind);
      expect(kinds).toEqual(expect.arrayContaining(['page_title', 'meta_description', 'text_replace', 'structured_data']));
      expect(prepared.find((e) => (e.proposedChange as WebsiteChange).kind === 'text_replace')?.proposedChange).toMatchObject({ before: '(03) 9876 5432', after: '03 9499 1234' });
      expect(prepared.every((e) => e.status === 'proposed' && e.source === 'audit_rule' && e.dedupeKey !== '')).toBe(true);
    }, 120_000);

    it('a second check refreshes the same changes instead of duplicating them, and keeps the owner’s wording', async () => {
      const title = (await edits()).find((e) => (e.proposedChange as WebsiteChange).kind === 'page_title' && e.pageUrl === FIXTURE_ROOT)!;
      const owned = {
        ...(title.proposedChange as WebsiteChange),
        after: 'Ivanhoe Barber Co | Owner wording here',
      } as WebsiteChange;
      await handle.db.update(schema.websiteEdits).set({ proposedChange: owned, source: 'owner' }).where(eq(schema.websiteEdits.id, title.id));
      const id = await newAudit();
      await handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, deps);
      expect((await auditRow(id)).status).toBe('partial');
      const after = await edits();
      expect(after).toHaveLength(firstEditCount);
      expect(after.find((e) => e.id === title.id)?.proposedChange).toMatchObject({ after: 'Ivanhoe Barber Co | Owner wording here' });
      expect(after.find((e) => e.id === title.id)?.auditId).toBe(id);
    }, 120_000);

    it('allows only one queued or running check (database guard)', async () => {
      const id = await newAudit();
      await expect(handle.db.insert(schema.websiteAudits).values({ id: newId(), url: FIXTURE_ROOT, status: 'queued' })).rejects.toThrow();
      await handle.db.update(schema.websiteAudits).set({ status: 'cancelled' }).where(eq(schema.websiteAudits.id, id));
    });

    it('cancelling mid-crawl stores "cancelled" and discards the partial result', async () => {
      const id = await newAudit();
      const run = fakeRun();
      let n = 0;
      site.onRequest = () => {
        if (++n === 6) run.abort();
      };
      await expect(handleWebsiteAudit(ctx, run, { auditId: id }, deps)).rejects.toBeInstanceOf(CancelledError);
      const row = await auditRow(id);
      expect(row.status).toBe('cancelled');
      expect(row.result).toBeNull();
      expect(row.error).toBe('Check cancelled. Nothing was changed.');
    }, 60_000);

    it('a worker killed mid-crawl leaves the check running; the retry starts again and overwrites cleanly', async () => {
      const id = await newAudit();
      const controller = new AbortController();
      const interrupted: TrackedRun = {
        jobId: 'j',
        signal: controller.signal,
        willRetry: true,
        progress: async () => {},
        message: async () => {},
        checkCancelled: () => {
          if (controller.signal.aborted) throw new CancelledError('Interrupted');
        },
        cancelledByOwner: async () => false,
      };
      let n = 0;
      site.onRequest = () => {
        if (++n === 8) controller.abort(new CancelledError('Interrupted'));
      };
      await expect(handleWebsiteAudit(ctx, interrupted, { auditId: id }, deps)).rejects.toBeInstanceOf(CancelledError);
      expect((await auditRow(id)).status).toBe('running');
      site.onRequest = null;
      await handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, deps);
      const row = await auditRow(id);
      expect(row.status).toBe('partial');
      expect(WebsiteAuditResultSchema.safeParse(row.result).success).toBe(true);
      expect(await edits()).toHaveLength(firstEditCount);
    }, 120_000);

    it('refuses to check a site whose ownership is not confirmed (no request is made)', async () => {
      const row = await handle.db.query.settings.findFirst({
        where: eq(schema.settings.id, 'default'),
      });
      const data = AppSettingsSchema.parse(row!.data);
      await handle.db
        .update(schema.settings)
        .set({
          data: {
            ...data,
            website: {
              ...data.website,
              ownershipConfirmedHost: 'someone-else.example',
            },
          },
        })
        .where(eq(schema.settings.id, 'default'));
      const id = await newAudit();
      site.requests.length = 0;
      await expect(handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, deps)).rejects.toBeInstanceOf(NonRetryableError);
      expect((await auditRow(id)).status).toBe('failed');
      expect(site.requests).toEqual([]);
      await handle.db.update(schema.settings).set({ data }).where(eq(schema.settings.id, 'default'));
    });

    it('a site that cannot be reached at all is a complete check with one critical "site unreachable" finding', async () => {
      // A port nothing listens on (connection refused) and a host name that does not resolve.
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const closedPort = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const cases = [
        { policy: { ...deps.fetchPolicy, testHttpPort: closedPort }, error: /refused the connection/ },
        {
          policy: {
            ...deps.fetchPolicy,
            resolver: async () => {
              throw new Error('ENOTFOUND');
            },
          },
          error: /could not be found/,
        },
      ];
      for (const c of cases) {
        const id = await newAudit();
        await handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, { ...deps, fetchPolicy: c.policy });
        const row = await auditRow(id);
        expect(row.status).toBe('complete');
        const result = WebsiteAuditResultSchema.parse(row.result);
        expect(result.findings.map((f) => f.checkId)).toEqual(['site_unreachable']);
        expect(result.findings[0]?.severity).toBe('critical');
        expect(result.findings[0]?.detail).toMatch(c.error);
        expect(result.findings.some((f) => f.checkId.startsWith('robots'))).toBe(false);
        expect((row.summary as { partialReasons: string[] }).partialReasons).toEqual([]);
        // Later tests read the newest check's pages: keep this one out of their way.
        await handle.db.delete(schema.websiteAudits).where(eq(schema.websiteAudits.id, id));
      }
    });

    it('robots.txt answering 503 stops the crawl (RFC 9309) and says so with the robots finding', async () => {
      const seen: string[] = [];
      const down = http.createServer((req, res) => {
        seen.push(req.url ?? '');
        if (req.url === '/robots.txt') {
          res.writeHead(503, { 'content-type': 'text/plain' }).end('Service unavailable');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html><title>Home</title></html>');
      });
      await new Promise<void>((resolve) => down.listen(0, '127.0.0.1', resolve));
      try {
        const id = await newAudit();
        await handleWebsiteAudit(ctx, fakeRun(), { auditId: id }, { ...deps, fetchPolicy: { ...deps.fetchPolicy, testHttpPort: (down.address() as AddressInfo).port } });
        const row = await auditRow(id);
        expect(row.status).toBe('partial');
        const result = WebsiteAuditResultSchema.parse(row.result);
        expect(result.findings.map((f) => f.checkId)).toEqual(['robots_unreachable']);
        expect((row.summary as { partialReasons: string[] }).partialReasons.join(' ')).toMatch(/robots.txt answered with a server error/);
        expect(seen).toEqual(['/robots.txt']);
        await handle.db.delete(schema.websiteAudits).where(eq(schema.websiteAudits.id, id));
      } finally {
        await new Promise<void>((resolve) => down.close(() => resolve()));
      }
    });

    it('a long Crawl-delay keeps the total polite waiting under 12 minutes (later requests are cut, not the cap)', async () => {
      const settings = AppSettingsSchema.parse((await handle.db.query.settings.findFirst({ where: eq(schema.settings.id, 'default') }))!.data);
      const scope = siteScopeFrom(settings.business.website)!;
      let clock = 0;
      const slept: number[] = [];
      const fetcher = new WebsiteFetcher(deps.fetchPolicy, [scope.host, scope.twinHost], () => clock, async (ms) => {
        slept.push(ms);
        clock += ms;
      });
      // As if robots.txt said `Crawl-delay: 20` (the fixture says 1; the gap only ever grows). This site needs over 50
      // requests to the owner's host, which would be more than 17 minutes of waiting without the budget.
      fetcher.setCrawlDelay(20);
      const out = await crawlSite({
        scope,
        snapshot: settingsSnapshot(settings),
        checkExternalLinks: true,
        watchTexts: new Map(),
        fetcher,
        signal: new AbortController().signal,
        progress: async () => {},
        checkCancelled: () => {},
      });
      const total = slept.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(MAX_POLITE_WAIT_SECONDS * 1000);
      expect(total).toBeGreaterThan(10 * 60_000);
      expect(out.partialReasons.join(' ')).toMatch(/slow crawl \(Crawl-delay\)/);
      expect(out.facts.pages.filter((p) => p.skipped === null && p.status !== null).length).toBeGreaterThan(0);
    });

    it('cleanup keeps full results only for the newest checks', async () => {
      expect(await trimOldAuditResults(ctx)).toBe('website: nothing to trim');
    });
  });

  describe('WordPress apply (fake REST API through the injected fetch)', () => {
    const BASE = `https://staging.${FIXTURE_HOST}`;
    const contactUrl = `${FIXTURE_ROOT}contact/`;
    let wp: ReturnType<typeof fakeWordPress>;
    const withWp = (): WorkerContext => ({ ...ctx, fetch: wp.fetch });

    async function connect(password = 'abcd efgh ijkl mnop') {
      await handle.db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.provider, 'website'));
      await handle.db.insert(schema.integrationConnections).values({
        id: newId(),
        provider: 'website',
        status: 'connected',
        accessTokenEncrypted: encryptCredential(ctx.env, `studio-assistant:${password}`),
        config: { baseUrl: BASE },
      });
    }
    async function approvedEdit(change: WebsiteChange, extra: Partial<typeof schema.websiteEdits.$inferInsert> = {}): Promise<string> {
      const id = newId();
      await handle.db.insert(schema.websiteEdits).values({
        id,
        title: 'Correct text',
        pageUrl: change.pageUrl,
        proposedChange: change,
        status: 'approved',
        source: 'owner',
        approvedBy: ownerId,
        approvedAt: NOW,
        ...extra,
      });
      return id;
    }
    const edit = async (id: string) =>
      (await handle.db.query.websiteEdits.findFirst({
        where: eq(schema.websiteEdits.id, id),
      }))!;

    beforeEach(() => {
      wp = fakeWordPress({
        base: BASE,
        items: [
          {
            id: 12,
            type: 'pages',
            slug: 'contact',
            link: `${BASE}/contact/`,
            raw: '<h1>Contact</h1><p>Find us in Ivanhoe. Phone (03) 9876 5432.</p>',
          },
        ],
      });
    });

    it('the read-only check connects and labels a different host as a staging site', async () => {
      await connect();
      await handleWebsiteConnectionCheck(withWp(), fakeRun(), { provider: 'website', reason: 'manual' }, deps);
      const conn = (await handle.db.query.integrationConnections.findFirst({
        where: eq(schema.integrationConnections.provider, 'website'),
      }))!;
      expect(conn.status).toBe('connected');
      expect(conn.displayName).toBe('studio-assistant');
      expect(conn.capabilities).toMatchObject({
        environment: 'staging',
        supportedKinds: 'text_replace,image_alt_text',
        editPublishedPages: true,
      });
      expect(wp.calls.every((c) => c.method === 'GET')).toBe(true);
    });

    it('applies a replacement once; a retry after a crash between the write and the status update reports already_applied', async () => {
      await connect();
      const id = await approvedEdit({
        kind: 'text_replace',
        pageUrl: contactUrl,
        before: '(03) 9876 5432',
        after: '03 9499 1234',
      });
      wp.state.crashAfterWrite = true;
      await expect(handleWebsiteEditApply(withWp(), fakeRun({ willRetry: true }), { editId: id }, deps)).rejects.toThrow();
      expect((await edit(id)).status).toBe('applying');
      expect(wp.state.writes).toHaveLength(1);
      await handleWebsiteEditApply(withWp(), fakeRun(), { editId: id }, deps);
      const row = await edit(id);
      expect(row.status).toBe('applied');
      expect(row.appliedVia).toBe('wordpress');
      expect(row.applyResult).toMatchObject({
        outcome: 'already_applied',
        adapter: 'wordpress',
        resourceId: '12',
      });
      // The public fixture page still shows the old number, so it is "not visible yet" (a cache), not a failure.
      expect(row.applyResult.verification).toBe('not_visible');
      expect(wp.state.writes).toHaveLength(1);
      expect(wp.state.items[0]?.raw).toContain('Phone 03 9499 1234.');
      const audit = await handle.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, 'website.edit.applied'), eq(schema.auditLog.entityId, id)));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]?.data)).not.toContain('abcd efgh');
    });

    it('an undo is a new change that applies through the same path', async () => {
      await connect();
      wp.state.items[0]!.raw = '<p>Phone 03 9499 1234.</p>';
      const original = await approvedEdit(
        {
          kind: 'text_replace',
          pageUrl: contactUrl,
          before: '(03) 9876 5432',
          after: '03 9499 1234',
        },
        { status: 'applied', appliedVia: 'wordpress' },
      );
      const undo = await approvedEdit(
        {
          kind: 'text_replace',
          pageUrl: contactUrl,
          before: '03 9499 1234',
          after: '(03) 9876 5432',
        },
        { source: 'undo', revertsEditId: original },
      );
      await handleWebsiteEditApply(withWp(), fakeRun(), { editId: undo }, deps);
      expect((await edit(undo)).status).toBe('applied');
      expect(wp.state.items[0]?.raw).toBe('<p>Phone (03) 9876 5432.</p>');
    });

    it('a conflict and a refused password are recorded without writing; the connection then needs reconnecting', async () => {
      await connect();
      const conflict = await approvedEdit({
        kind: 'text_replace',
        pageUrl: contactUrl,
        before: 'text that is not there',
        after: 'x',
      });
      await handleWebsiteEditApply(withWp(), fakeRun(), { editId: conflict }, deps);
      expect(await edit(conflict)).toMatchObject({
        status: 'apply_failed',
        statusReason: 'conflict',
      });
      await connect('wrong password');
      const auth = await approvedEdit({
        kind: 'text_replace',
        pageUrl: contactUrl,
        before: '(03) 9876 5432',
        after: '03 9499 1234',
      });
      await handleWebsiteEditApply(withWp(), fakeRun(), { editId: auth }, deps);
      expect(await edit(auth)).toMatchObject({
        status: 'apply_failed',
        statusReason: 'auth',
      });
      expect(
        (
          await handle.db.query.integrationConnections.findFirst({
            where: eq(schema.integrationConnections.provider, 'website'),
          })
        )?.status,
      ).toBe('needs_reauth');
      expect(wp.state.writes).toEqual([]);
    });

    it('never applies a change without the owner’s approval', async () => {
      await connect();
      const id = await approvedEdit(
        {
          kind: 'text_replace',
          pageUrl: contactUrl,
          before: '(03) 9876 5432',
          after: '03 9499 1234',
        },
        { approvedBy: null, approvedAt: null },
      );
      await expect(handleWebsiteEditApply(withWp(), fakeRun(), { editId: id }, deps)).rejects.toBeInstanceOf(NonRetryableError);
      expect((await edit(id)).status).toBe('apply_failed');
      expect(wp.calls).toEqual([]);
      const proposed = await approvedEdit(
        {
          kind: 'text_replace',
          pageUrl: contactUrl,
          before: 'a',
          after: 'b',
        },
        { status: 'proposed' },
      );
      await handleWebsiteEditApply(withWp(), fakeRun(), { editId: proposed }, deps);
      expect((await edit(proposed)).status).toBe('proposed');
    });
  });

  describe('AI wording (fake Anthropic client)', () => {
    it('stores only options that pass the checks and logs usage', async () => {
      const calls: Array<{ messages: Array<{ content: unknown }> }> = [];
      const writer = new AnthropicWebsiteCopywriter({
        model: 'claude-haiku-5-5',
        client: {
          messages: {
            parse: async (p) => {
              calls.push(p as unknown as { messages: Array<{ content: unknown }> });
              return {
                parsed_output: {
                  options: ['Best barber in Ivanhoe | Ivanhoe Barber Co', 'Ivanhoe Barber Co | Fades and beard trims, Ivanhoe'],
                },
                stop_reason: 'end_turn',
                usage: { input_tokens: 1500, output_tokens: 300 },
              };
            },
            stream: () => {
              throw new Error('not used');
            },
          },
        },
      });
      const id = newId();
      await handle.db.insert(schema.websiteEdits).values({
        id,
        title: 'Rewrite the home page title',
        pageUrl: FIXTURE_ROOT,
        proposedChange: {
          kind: 'page_title',
          pageUrl: FIXTURE_ROOT,
          before: 'Home',
          after: 'Ivanhoe Barber Co | Barber in Ivanhoe, VIC',
        },
      });
      await handleWebsiteCopyDraft(ctx, fakeRun(), { editId: id }, { ...deps, copywriter: writer });
      const row = (await handle.db.query.websiteEdits.findFirst({
        where: eq(schema.websiteEdits.id, id),
      }))!;
      expect(row.aiOptions).toEqual(['Ivanhoe Barber Co | Fades and beard trims, Ivanhoe']);
      const userText = (calls[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text;
      expect(JSON.parse(userText).page.textSample).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
      const usage = await handle.db.select().from(schema.aiUsage).where(eq(schema.aiUsage.purpose, 'website_copy'));
      expect(usage).toHaveLength(1);
      // Without AI configured the job skips with a message and changes nothing.
      const run = fakeRun();
      await handleWebsiteCopyDraft(ctx, run, { editId: id }, { ...deps, copywriter: null });
      expect(run.messages).toContain('AI is not configured');
      expect(DRAFTS_REJECTED_MESSAGE).toContain("didn't pass our checks");
    });
  });

  describe('Search Console (fake Google through the injected fetch)', () => {
    const SITE = `sc-domain:${FIXTURE_HOST}`;
    let queries = 0;
    let refreshes = 0;
    let grant: 'ok' | 'invalid' = 'ok';
    const google = fakeFetch((call) => {
      if (call.url === GOOGLE_TOKEN_URL) {
        refreshes++;
        return grant === 'ok'
          ? json(200, {
              access_token: `access-${refreshes}`,
              expires_in: 3600,
              scope: 'https://www.googleapis.com/auth/webmasters.readonly',
            })
          : json(400, { error: 'invalid_grant' });
      }
      if (call.url.endsWith('/webmasters/v3/sites'))
        return json(200, {
          siteEntry: [
            { siteUrl: SITE, permissionLevel: 'siteOwner' },
            {
              siteUrl: 'https://unrelated.example/',
              permissionLevel: 'siteFullUser',
            },
          ],
        });
      if (call.url.includes('/searchAnalytics/query')) {
        queries++;
        const body = JSON.parse(call.body) as {
          startDate: string;
          dimensions: string[];
        };
        if (body.dimensions.length === 1)
          return json(200, {
            rows: [
              {
                keys: [body.startDate],
                clicks: 10,
                impressions: 300,
                ctr: 0.03,
                position: 8.5,
              },
            ],
          });
        return json(200, {
          rows: [
            {
              keys: [body.startDate, 'barber ivanhoe'],
              clicks: 4,
              impressions: 90,
              ctr: 0.04,
              position: 5.2,
            },
            {
              keys: [body.startDate, 'ivanhoe barber co'],
              clicks: 5,
              impressions: 20,
              ctr: 0.25,
              position: 1.1,
            },
          ],
        });
      }
      return json(404, {});
    });
    const withGoogle = (): WorkerContext => ({ ...ctx, fetch: google });

    beforeAll(async () => {
      await handle.db.insert(schema.integrationConnections).values({
        id: newId(),
        provider: 'google_search_console',
        status: 'connected',
        accessTokenEncrypted: encryptCredential(ctx.env, 'expired'),
        refreshTokenEncrypted: encryptCredential(ctx.env, 'refresh-1'),
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
    });

    it('the check refreshes the token, lists properties, auto-selects the Domain property and queues the first sync', async () => {
      enqueued.length = 0;
      await handleWebsiteConnectionCheck(withGoogle(), fakeRun(), { provider: 'google_search_console', reason: 'connect' }, deps);
      const conn = (await handle.db.query.integrationConnections.findFirst({
        where: eq(schema.integrationConnections.provider, 'google_search_console'),
      }))!;
      expect(conn.status).toBe('connected');
      expect(conn.config).toMatchObject({
        siteUrl: SITE,
        properties: [
          { siteUrl: SITE, permissionLevel: 'siteOwner' },
          {
            siteUrl: 'https://unrelated.example/',
            permissionLevel: 'siteFullUser',
          },
        ],
      });
      expect(refreshes).toBe(1);
      expect(enqueued).toEqual([
        {
          type: 'search.sync',
          payload: { source: 'search_console', reason: 'connect' },
        },
      ]);
    });

    it('backfills 16 months in windows and upserts idempotently', async () => {
      queries = 0;
      await handleSearchSync(withGoogle(), fakeRun(), { source: 'search_console', reason: 'connect' }, deps, async () => {});
      const rows = await handle.db.select().from(schema.searchMetrics);
      expect(queries).toBeGreaterThanOrEqual(32);
      expect(rows.filter((r) => r.kind === 'total').length).toBe(queries / 2);
      expect(rows.every((r) => r.source === 'search_console' && r.property === SITE && r.granularity === 'day')).toBe(true);
      const snapshot = rows.map((r) => `${r.periodStart}|${r.kind}|${r.key}|${r.clicks}|${r.impressions}|${r.position}`).sort();
      await handleSearchSync(withGoogle(), fakeRun(), { source: 'search_console', reason: 'connect' }, deps, async () => {});
      const again = await handle.db.select().from(schema.searchMetrics);
      expect(again.map((r) => `${r.periodStart}|${r.kind}|${r.key}|${r.clicks}|${r.impressions}|${r.position}`).sort()).toEqual(snapshot);
      queries = 0;
      await handleSearchSync(withGoogle(), fakeRun(), { source: 'search_console', reason: 'daily' }, deps, async () => {});
      expect(queries).toBe(2);
    });

    it('invalid_grant marks the connection needs_reauth and stops without retrying', async () => {
      grant = 'invalid';
      await handle.db
        .update(schema.integrationConnections)
        .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.integrationConnections.provider, 'google_search_console'));
      await expect(handleSearchSync(withGoogle(), fakeRun(), { source: 'search_console', reason: 'manual' }, deps, async () => {})).rejects.toBeInstanceOf(NonRetryableError);
      expect(
        (
          await handle.db.query.integrationConnections.findFirst({
            where: eq(schema.integrationConnections.provider, 'google_search_console'),
          })
        )?.status,
      ).toBe('needs_reauth');
      grant = 'ok';
    });
  });
});
