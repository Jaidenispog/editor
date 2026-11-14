#!/usr/bin/env node
/**
 * Stage C website and search check in a real browser (Chromium through Playwright), against local fakes only: the
 * worker's fixture website with a WordPress REST fake on the same host, and one Google fake for sign-in, Search Console
 * and Business Profile (apps/web/e2e/fake-stage-c-website.ts). It drives the running web app and worker the way the
 * owner would: the honest set-up state, a refused check of a private address, a real check of the fixture site, a
 * prepared change shown, edited, applied once through WordPress and refused when the page changed, Search Console and
 * Business Profile connected through the real OAuth routes, the Google reviews list, the quota-0 waiting state and the
 * Performance numbers, then the layout at 390 and 1440 px.
 *
 * The database is read only where the UI cannot show something (stored metrics, job rows, the audit's request count)
 * and written once, to move the previous check's finish time back past the five-minute pause between checks instead of
 * waiting it out. The fakes are read through `GET /__fake/state`.
 *
 * Needs a web app and a worker that share one database, both started with NODE_ENV=test, WEBSITE_FIXTURE_BASE_URL and
 * GOOGLE_API_BASE_URL pointing at the fakes. `bash apps/web/e2e/run-stage-c-website.sh` sets all of that up.
 *
 * Settings (environment variables):
 *   E2E_BASE_URL          web app address                  (default http://localhost:3900)
 *   E2E_FAKE_GOOGLE_URL   the Google fake (also the fakes' control endpoint)  (required)
 *   E2E_FIXTURE_SITE      the fixture website's address    (default http://ivanhoe-studio.test)
 *   E2E_WP_USER / E2E_WP_PASSWORD  the WordPress Application Password the fake accepts  (required)
 *   E2E_DATABASE_URL      the app's database               (required)
 *   E2E_OUT_DIR           failure screenshots              (default <os tmp>/studio-e2e-c-website)
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD                    (default e2e-owner@example.com / a fixed test password)
 *
 * Exit code 0 when every check passed, 1 otherwise. Plain node + playwright + pg; no test runner.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error('Playwright is not installed. Install it with "npm i -g playwright@1.65.0" (and its Chromium), or add it to apps/web.');
    process.exit(2);
  }
}

const { chromium } = loadPlaywright();
const pg = require('pg');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3900').replace(/\/$/, '');
const FAKE_URL = (process.env.E2E_FAKE_GOOGLE_URL ?? '').replace(/\/$/, '');
const SITE = (process.env.E2E_FIXTURE_SITE ?? 'http://ivanhoe-studio.test').replace(/\/$/, '');
const SITE_HOST = new URL(SITE).hostname;
const WP_USER = process.env.E2E_WP_USER ?? 'studio-assistant';
const WP_PASSWORD = process.env.E2E_WP_PASSWORD ?? '';
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const OUT_DIR = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'studio-e2e-c-website');
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@example.com';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'clipper guard number two';
const OWNER_NAME = 'E2E Owner';
const BUSINESS_NAME = 'Ivanhoe Barber Co';
const PHONE = '03 9499 1234';
const TSX = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'tsx');
const DESKTOP = { width: 1440, height: 1000 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
/** The address of the refused check: loopback, where the fixture really runs, but not the fixture's host name. */
const PRIVATE_SITE = 'http://127.0.0.1/';
/** Raw job type names that must never reach the owner. */
const RAW_JOB_TYPES = /\b(website\.audit|website\.edit_apply|website\.connection_check|search\.sync|reviews\.gbp\.sync|google\.disconnect)\b/;
/** Check ids the fixture site is built to trigger (apps/worker/test/helpers/fixture-site.ts; same list as website-db.test.ts). */
const FIXTURE_ISSUES = [
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
];
const SEVERITY_RANK = { Urgent: 4, Important: 3, 'Worth doing': 2, Minor: 1, Note: 0 };

const failures = [];
const passes = [];
const started = Date.now();

function log(message) {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[${t}s] ${message}`);
}

/** Records one check; failed checks make the run exit with 1 but do not stop the remaining steps. */
function check(condition, message, detail) {
  if (condition) {
    passes.push(message);
    log(`  ok   ${message}`);
  } else {
    failures.push(detail ? `${message} (${detail})` : message);
    log(`  FAIL ${message}${detail ? ` (${detail})` : ''}`);
  }
  return condition;
}

/** An error that ends a {@link waitFor} at once instead of being retried (a failed job will not recover). */
class FatalError extends Error {}
const fatal = (message) => new FatalError(message);

/** Polls `fn` until it returns a truthy value or the time runs out. A {@link FatalError} stops the wait at once. */
async function waitFor(description, fn, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      if (err instanceof FatalError) throw new Error(`${description}: ${err.message}`);
      last = err;
    }
    if (Date.now() > deadline) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${description}${why}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A load the browser cancelled itself: a Next.js route prefetch (`?_rsc=`) cut short by navigating. */
function abortedLoadWeIgnore(e) {
  if (!/Failed to load resource: net::ERR_(ABORTED|FAILED)/.test(e.text)) return false;
  try {
    const u = new URL(e.url);
    return u.origin === new URL(BASE_URL).origin && u.searchParams.has('_rsc');
  } catch {
    return false;
  }
}

async function failureScreenshot(page, name) {
  try {
    await mkdir(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `failure-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`  saved ${file}`);
  } catch {
    // The page may already be closed; the failure itself is what matters.
  }
}

async function apiGet(page, urlPath) {
  const res = await page.request.get(`${BASE_URL}${urlPath}`);
  if (!res.ok()) throw new Error(`${urlPath} answered ${res.status()}`);
  return res.json();
}

/** A same-origin request made by the page itself (the app's CSRF rule only accepts those). */
async function pageFetch(page, urlPath, init) {
  return page.evaluate(
    async ({ urlPath, init }) => {
      const res = await fetch(urlPath, { ...init, headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) } });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },
    { urlPath, init },
  );
}

async function fakeState() {
  const res = await fetch(`${FAKE_URL}/__fake/state`);
  if (!res.ok) throw new Error(`the fakes answered ${res.status}`);
  return res.json();
}

async function fakePost(pathname, body) {
  const res = await fetch(`${FAKE_URL}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${pathname} answered ${res.status}`);
}

/** Visible text of a locator with whitespace collapsed. */
async function textOf(locator) {
  return ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();
}

async function openSettings(page, tab) {
  await page.goto(`${BASE_URL}/settings?tab=${tab}`);
  await page.getByRole('tab', { selected: true }).waitFor({ timeout: 30_000 });
}

/** A Card (components/ui/card.tsx) by its title. */
function cardByTitle(page, title) {
  return page.locator('div[class*="radius-card"]', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
}

async function openWebsite(page) {
  await page.goto(`${BASE_URL}/website`);
  await page.getByRole('heading', { level: 2, name: 'Website check', exact: true }).waitFor({ timeout: 30_000 });
}

const overview = (page) => apiGet(page, '/api/website');
const openEdits = async (page) => (await apiGet(page, '/api/website/edits?status=open')).edits;

/** Saves the given Settings → Business fields through the form. */
async function saveBusiness(page, fields) {
  await openSettings(page, 'business');
  for (const [label, value] of Object.entries(fields)) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save business details' }).click();
  await waitFor('the business details to be saved', async () => {
    const { settings } = await apiGet(page, '/api/settings');
    return settings.business.website === (fields.Website ?? settings.business.website) ? settings : null;
  }, { timeoutMs: 15_000, intervalMs: 500 });
}

/** Waits for the newest website check to finish and returns the overview. */
async function waitForCheck(page, previousId) {
  return waitFor(
    'the website check to finish',
    async () => {
      const o = await overview(page);
      const a = o.latestAudit;
      if (!a || a.id === previousId) return null;
      if (a.status === 'failed') throw fatal(a.error ?? 'the check failed');
      return a.status === 'complete' || a.status === 'partial' ? o : null;
    },
    { timeoutMs: 240_000, intervalMs: 2000 },
  );
}

/** The prepared change's card on the Website page, by its id. */
const changeCard = (page, id) => page.locator(`article#change-${id}`);

/** Waits until a website change reaches one of the given statuses (through the API) and returns it. */
async function waitForEdit(page, id, statuses, description) {
  return waitFor(
    description,
    async () => {
      for (const status of ['open', 'done', 'dismissed']) {
        const { edits } = await apiGet(page, `/api/website/edits?status=${status}`);
        const e = edits.find((x) => x.id === id);
        if (e && statuses.includes(e.status)) return e;
      }
      return null;
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );
}

/** Asserts the page has no horizontal overflow and no truncated card or connection titles. */
async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const titles = [...document.querySelectorAll('h2, h3')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const s = getComputedStyle(el);
        return { text: el.textContent?.trim() ?? '', cut: el.scrollWidth > el.clientWidth + 1 || s.textOverflow === 'ellipsis' };
      });
    const connectionTitles = [...document.querySelectorAll('ul > li.rounded-xl h3')].map((el) => ({ text: el.textContent?.trim() ?? '', cut: el.scrollWidth > el.clientWidth + 1, height: el.getBoundingClientRect().height }));
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, cut: titles.filter((t) => t.cut).map((t) => t.text), connectionTitles };
  });
  check(layout.scrollWidth <= layout.clientWidth, `${label}: no horizontal overflow`, `${layout.scrollWidth} > ${layout.clientWidth}`);
  check(layout.cut.length === 0, `${label}: no card title is cut short`, layout.cut.join(' | '));
  return layout;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (!FAKE_URL || !DATABASE_URL || !WP_PASSWORD) throw new Error('E2E_FAKE_GOOGLE_URL, E2E_DATABASE_URL and E2E_WP_PASSWORD are required (run apps/web/e2e/run-stage-c-website.sh).');
  const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`The web app at ${BASE_URL} is not healthy (${JSON.stringify(health)}). Start it and the worker first.`);
  const fakeData = (await fakeState()).data;

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (text, params = []) => (await db.query(text, params)).rows;

  const browser = await chromium.launch();
  /** Every page error and console error, with the address of the resource when the browser gives one. */
  const consoleErrors = [];
  /** Console errors this test causes on purpose (each must actually appear, and is listed at the end). */
  const expectedErrors = [];
  const expectError = (pattern, why) => expectedErrors.push({ pattern, why, seen: 0 });
  /** Text of every response from the app, to prove the WordPress Application Password never comes back. */
  const appResponses = [];
  const watch = (p) => {
    p.on('pageerror', (err) => consoleErrors.push({ text: `pageerror: ${err.message}`, url: '' }));
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ text: `console: ${msg.text()}`, url: msg.location()?.url ?? '' });
    });
    p.on('response', (res) => {
      if (!res.url().startsWith(BASE_URL)) return;
      const type = res.headers()['content-type'] ?? '';
      if (!/json|html|text\/x-component/.test(type) || res.status() < 200 || (res.status() >= 300 && res.status() < 400) || res.status() === 204) return;
      // A streamed body that never completes (a page left mid-stream) must not hold the run up: 10 s at most.
      const body = res
        .text()
        .then((text) => ({ url: res.url(), text, read: true }))
        .catch(() => ({ url: res.url(), text: '', read: false }));
      const timeout = new Promise((r) => setTimeout(() => r({ url: res.url(), text: '', read: false }), 10_000).unref());
      appResponses.push(Promise.race([body, timeout]));
    });
  };
  let page;
  try {
    // ---- 0. Owner account and sign-in. ----------------------------------------------------------------------
    log('First-run setup and sign-in');
    const setupContext = await browser.newContext({ viewport: DESKTOP });
    const setupPage = await setupContext.newPage();
    watch(setupPage);
    await setupPage.goto(`${BASE_URL}/setup`);
    if (setupPage.url().includes('/setup')) {
      await setupPage.getByLabel('Your name').fill(OWNER_NAME);
      await setupPage.getByLabel('Email').fill(OWNER_EMAIL);
      await setupPage.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
      await setupPage.getByLabel('Confirm password').fill(OWNER_PASSWORD);
      await setupPage.getByRole('button', { name: 'Create account and sign in' }).click();
      await setupPage.waitForURL((u) => !u.pathname.startsWith('/setup'), { timeout: 30_000 });
    }
    await setupContext.close();
    const context = await browser.newContext({ viewport: DESKTOP });
    page = await context.newPage();
    watch(page);
    await page.goto(`${BASE_URL}/website`);
    await page.waitForURL(/\/login/);
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
    check(true, 'owner signed in');

    // ---- a. The Website page before setup. -------------------------------------------------------------------
    log('Website page before setup');
    await openWebsite(page);
    const checklist = cardByTitle(page, 'Before your first check');
    await checklist.waitFor({ timeout: 30_000 });
    const checklistText = await textOf(checklist);
    check(/Website address/.test(checklistText) && /Add your website address in Settings → Business/.test(checklistText) && /This is my website/.test(checklistText), 'the checklist asks for the website address first', checklistText.slice(0, 200));
    const ownBox = checklist.getByRole('checkbox', { name: /This is my business's own website/ });
    check(await ownBox.isDisabled(), '"This is my business\'s own website" cannot be ticked before an address is saved');
    const checkButton = page.getByRole('button', { name: 'Check my website', exact: true });
    check(await checkButton.isDisabled(), '"Check my website" is disabled before setup');
    const checkCard = cardByTitle(page, 'Website check');
    check(/Add your website address in Settings → Business first\./.test(await textOf(checkCard)), 'the check card says why it cannot start');
    const searchCard = cardByTitle(page, 'Google search performance');
    await searchCard.getByRole('link', { name: 'Connect Search Console' }).waitFor({ timeout: 15_000 });
    const searchBefore = await textOf(searchCard);
    check(!/\d/.test(searchBefore) && !/—/.test(searchBefore), 'before Search Console is connected the card shows no numbers at all (no zeros, no placeholders)', searchBefore.slice(0, 200));
    const profileCard = cardByTitle(page, 'Google Business Profile performance');
    const profileBefore = await textOf(profileCard);
    check(!/\d/.test(profileBefore) && !/—/.test(profileBefore), 'before Business Profile is connected its performance card shows no numbers at all', profileBefore.slice(0, 200));
    check((await q('select count(*)::int as n from search_metrics'))[0].n === 0, 'no search numbers are stored before connecting');
    await page.goto(`${BASE_URL}/reviews`);
    await page.getByRole('tab', { name: 'Reviews on Google' }).click();
    const googleTab = cardByTitle(page, 'Reviews on Google');
    await googleTab.getByRole('link', { name: 'Connect Google Business Profile' }).waitFor({ timeout: 15_000 });
    check(/Not connected/.test(await textOf(googleTab)) && (await googleTab.locator('li').count()) === 0, 'Reviews on Google says "Not connected" and lists no reviews before connecting');

    // ---- c. A check of an address that is not the fixture site is refused without any request. ----------------
    log(`Refused check of ${PRIVATE_SITE}`);
    await openSettings(page, 'branding');
    await page.getByLabel('Business name', { exact: true }).fill(BUSINESS_NAME);
    await page.getByRole('button', { name: 'Save branding' }).click();
    await waitFor('the business name to be saved', async () => (await apiGet(page, '/api/settings')).settings.brand.businessName === BUSINESS_NAME, { timeoutMs: 15_000, intervalMs: 500 });
    await saveBusiness(page, { 'Street address': '12 Upper Heidelberg Rd', Suburb: 'Ivanhoe', State: 'VIC', Postcode: '3079', Phone: PHONE, Website: PRIVATE_SITE });
    await openWebsite(page);
    check(await checkButton.isDisabled(), '"Check my website" stays disabled until "This is my business\'s own website" is ticked');
    check(/Confirm that this is your own website first\./.test(await textOf(checkCard)), 'the check card asks for the ownership confirmation');
    await checklist.getByRole('checkbox', { name: /This is my business's own website/ }).check();
    await checkButton.waitFor({ state: 'visible' });
    await waitFor('"Check my website" to be enabled', async () => checkButton.isEnabled(), { timeoutMs: 15_000, intervalMs: 300 });
    check(true, 'ticking the ownership box enables "Check my website"');
    const siteBeforeRefused = (await fakeState()).site.requests.length;
    await checkButton.click();
    const refused = await waitForCheck(page, null);
    const refusedFindings = refused.latestResult?.findings ?? [];
    const unreachable = refusedFindings.find((f) => f.checkId === 'site_unreachable');
    check(Boolean(unreachable) && /private or reserved address/.test(`${unreachable?.detail ?? ''} ${unreachable?.title ?? ''}`), 'the check of a private address ends with "site unreachable: private or reserved address"', JSON.stringify(unreachable ?? refusedFindings.map((f) => f.checkId)));
    check(refused.latestAudit.summary.pagesChecked === 0, 'no page was read from the private address', String(refused.latestAudit.summary.pagesChecked));
    const refusedRow = (await q('select result from website_audits where id = $1', [refused.latestAudit.id]))[0];
    check((refusedRow?.result?.limits?.requests ?? -1) === 0, 'the refused check made no request at all (its request count is 0)', JSON.stringify(refusedRow?.result?.limits ?? null));
    check((await fakeState()).site.requests.length === siteBeforeRefused, 'the fixture site (which really runs on 127.0.0.1) received nothing');
    await page.reload();
    await checkCard.getByText("We couldn't check your pages this time.").first().waitFor({ timeout: 15_000 });
    check(true, 'the Website page says the pages could not be checked (no "nothing to fix")');

    // The app pauses five minutes between checks so it never loads a site unnecessarily; move the refused check's
    // finish time back instead of waiting it out.
    await q("update website_audits set finished_at = finished_at - interval '6 minutes', created_at = created_at - interval '6 minutes' where id = $1", [refused.latestAudit.id]);

    // ---- b. The check of the fixture site. ---------------------------------------------------------------------
    log(`Check of the fixture site ${SITE}/`);
    await saveBusiness(page, { Website: `${SITE}/` });
    await openWebsite(page);
    check(await checkButton.isDisabled(), 'a new website address needs the ownership confirmation again');
    await checklist.getByRole('checkbox', { name: /This is my business's own website/ }).check();
    await waitFor('"Check my website" to be enabled', async () => checkButton.isEnabled(), { timeoutMs: 15_000, intervalMs: 300 });
    await checkButton.click();
    const progress = page.getByRole('progressbar', { name: 'Checking your website progress' });
    await progress.waitFor({ timeout: 30_000 });
    const runningText = await textOf(checkCard);
    check(/Checking your website/.test(runningText), 'progress shows "Checking your website"', runningText.slice(0, 200));
    check(!RAW_JOB_TYPES.test(await page.locator('body').innerText()), 'no raw job type name is shown while the check runs');
    const done = await waitForCheck(page, refused.latestAudit.id);
    const result = done.latestResult;
    const ids = (result?.findings ?? []).map((f) => f.checkId);
    const missing = FIXTURE_ISSUES.filter((id) => !ids.includes(id));
    check(missing.length === 0, "the check found the fixture site's known issues", `missing ${missing.join(', ')}; found ${[...new Set(ids)].join(', ')}`);
    const fetched = (result?.pages ?? []).filter((p) => p.skipped === null);
    check(fetched.length <= 25 && done.latestAudit.summary.pagesChecked <= 25 && result?.limits?.hitPageLimit === true, 'the check read at most 25 pages (and stopped at the limit)', `${fetched.length} fetched, ${done.latestAudit.summary.pagesChecked} checked`);
    const afterCheck = await fakeState();
    const siteReqs = afterCheck.site.requests.slice(siteBeforeRefused);
    check(siteReqs.length > 0 && !siteReqs.some((r) => r.path.startsWith('/private/')), 'robots.txt-disallowed /private/ was never requested', `${siteReqs.length} requests`);
    check(siteReqs.length <= 400 && (result?.limits?.requests ?? 0) <= 400, 'the check stayed within its 400-request budget', String(siteReqs.length));
    check((result?.robots?.blockedForUs ?? []).some((u) => u.includes('/private/')), 'the result records /private/ as blocked for the check by robots.txt');
    await page.reload();
    await checkCard.getByText(/^Checked \d+ pages? on /).waitFor({ timeout: 15_000 });
    const doneText = await textOf(checkCard);
    const checkedN = Number(/Checked (\d+) page/.exec(doneText)?.[1] ?? '99');
    check(checkedN <= 25 && checkedN === done.latestAudit.summary.pagesChecked, 'the card says how many pages were checked (at most 25)', doneText.slice(0, 160));
    check(/We stopped at 25 pages/.test(doneText), 'the card says the check stopped at 25 pages');
    check(!RAW_JOB_TYPES.test(await page.locator('body').innerText()), 'no raw job type name is shown after the check');
    // Priority order: "Everything we found" lists findings from most to least urgent.
    const allFindings = checkCard.locator('section[aria-labelledby="all-findings"] button[aria-expanded]');
    const severities = await allFindings.evaluateAll((els) => els.map((el) => el.querySelector('span.rounded-full')?.textContent?.trim() ?? ''));
    const ranks = severities.map((s) => SEVERITY_RANK[s] ?? -1);
    const shownTitles = await allFindings.evaluateAll((els) => els.map((el) => el.querySelector('p')?.textContent?.trim() ?? ''));
    // The order of website design §6.4, computed here independently: severity weight + quick-fix bonus + pages (up to
    // five), then category order, then check id. (A quick "Note" may outrank a slow "Minor"; Urgent, Important and
    // Worth doing never mix.)
    const SPEC_SEVERITY = { critical: 100, high: 60, medium: 30, low: 10, info: 0 };
    const SPEC_EFFORT = { quick: 10, moderate: 5, developer: 0 };
    const CATEGORY_ORDER = ['indexing', 'business_info', 'content', 'structured_data', 'mobile', 'performance', 'links'];
    const score = (f) => SPEC_SEVERITY[f.severity] + SPEC_EFFORT[f.effort] + Math.min(f.pages.length, 5);
    const specOrder = [...(result?.findings ?? [])]
      .sort((a, b) => score(b) - score(a) || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.checkId.localeCompare(b.checkId) || a.key.localeCompare(b.key))
      .map((f) => f.title);
    check(shownTitles.length === specOrder.length && shownTitles.every((t, i) => t === specOrder[i]), 'every finding is listed in priority order (design §6.4)', shownTitles.map((t, i) => (t === specOrder[i] ? '=' : `${t} ≠ ${specOrder[i]}`)).join(' | '));
    const bands = ranks.filter((r) => r >= 2);
    check(bands.length > 0 && bands.every((r, i) => i === 0 || r <= bands[i - 1]) && ranks.slice(0, bands.length).every((r) => r >= 2), 'urgent, important and worth-doing findings come first, most urgent first', severities.join(', '));
    const knownTitles = (result?.findings ?? []).filter((f) => FIXTURE_ISSUES.includes(f.checkId)).map((f) => f.title);
    check(knownTitles.length > 0 && knownTitles.every((t) => shownTitles.includes(t)), 'the known issues are listed on the page by their titles', knownTitles.filter((t) => !shownTitles.includes(t)).join(' | '));
    const firstFive = checkCard.locator('section[aria-labelledby="do-these-first"] button[aria-expanded]');
    const topSeverities = await firstFive.evaluateAll((els) => els.map((el) => el.querySelector('span.rounded-full')?.textContent?.trim() ?? ''));
    check(topSeverities.length > 0 && topSeverities.length <= 5 && SEVERITY_RANK[topSeverities[0]] === Math.max(...ranks), '"Do these first" starts with the most urgent finding (five at most)', topSeverities.join(', '));

    // ---- e. Without WordPress: copy-paste steps only. ----------------------------------------------------------
    log('Prepared changes without WordPress');
    const edits = await openEdits(page);
    const contactChange = edits.find((e) => e.change.kind === 'text_replace' && e.pageUrl === `${SITE}/contact/`);
    const homeChange = edits.find((e) => e.change.kind === 'text_replace' && e.pageUrl === `${SITE}/`);
    check(Boolean(contactChange && homeChange), 'the check prepared the phone number corrections for the contact and home pages', edits.map((e) => `${e.change.kind} ${e.pageUrl}`).join(' | '));
    if (!contactChange || !homeChange) throw new Error('No phone number changes were prepared.');
    const contactCard = changeCard(page, contactChange.id);
    await contactCard.waitFor({ timeout: 15_000 });
    const pres = contactCard.locator('pre');
    check((await pres.nth(0).innerText()) === '(03) 9876 5432' && (await pres.nth(1).innerText()) === PHONE, 'the prepared change shows the exact before and after', `${await pres.nth(0).innerText()} → ${await pres.nth(1).innerText()}`);
    const applyButton = contactCard.getByRole('button', { name: 'Apply to website', exact: true });
    check(await applyButton.isDisabled(), 'without WordPress "Apply to website" is disabled');
    const reasonText = await textOf(contactCard);
    check(/WordPress/.test(contactChange.applyAvailable.reason ?? '') && reasonText.includes(contactChange.applyAvailable.reason ?? '\u0000'), 'the card says why: WordPress is not connected', contactChange.applyAvailable.reason ?? '');
    await contactCard.getByRole('button', { name: 'Copy steps', exact: true }).click();
    const stepsDialog = page.getByRole('dialog');
    await stepsDialog.getByRole('heading', { name: 'Steps to make this change' }).waitFor();
    const steps = await textOf(stepsDialog);
    check(steps.includes('(03) 9876 5432') && steps.includes(PHONE) && steps.includes(`${SITE}/contact/`), 'the copy-paste steps name the page and the exact old and new text', steps.slice(0, 240));
    await stepsDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await stepsDialog.waitFor({ state: 'hidden' });
    check((await fakeState()).wordpress.calls.length === 0, 'nothing has contacted WordPress yet');

    // ---- d. WordPress connected: edit, approve, apply once, refuse a changed page. -----------------------------
    log('Connect WordPress (Settings → Integrations → Website editing)');
    const responsesBeforeWp = appResponses.length;
    await openSettings(page, 'integrations');
    const wpSection = page.locator('section', { has: page.getByRole('heading', { level: 3, name: 'Website editing (WordPress)' }) });
    await wpSection.waitFor({ timeout: 30_000 });
    await wpSection.getByLabel('WordPress site address').fill(SITE);
    await wpSection.getByLabel('WordPress username').fill(WP_USER);
    await wpSection.getByLabel('Application Password').fill(WP_PASSWORD);
    await wpSection.getByRole('button', { name: 'Save and check' }).click();
    const wpConn = await waitFor(
      'WordPress to be checked and connected',
      async () => {
        const row = (await q("select status, capabilities, last_error from integration_connections where provider = 'website'"))[0];
        if (row?.status === 'error') throw fatal(row.last_error ?? 'error');
        return row?.status === 'connected' ? row : null;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    check(wpConn.capabilities?.environment === 'live' && /text_replace/.test(String(wpConn.capabilities?.supportedKinds ?? '')), 'the read-only check connected WordPress as the live site', JSON.stringify(wpConn.capabilities));
    const wpAfterCheck = await fakeState();
    check(wpAfterCheck.wordpress.calls.length > 0 && wpAfterCheck.wordpress.calls.every((c) => c.method === 'GET') && wpAfterCheck.wordpress.writeCount === 0, 'the connection check only read from WordPress');
    await page.reload();
    await wpSection.waitFor({ timeout: 30_000 });
    check((await wpSection.getByLabel('Application Password').inputValue()) === '', 'the Application Password field is empty after saving');
    check(!(await page.content()).includes(WP_PASSWORD), 'the Application Password is not in the Settings page');
    for (const p of ['/api/integrations/status', '/api/website', '/api/settings', '/api/website/edits?status=open']) {
      const res = await page.request.get(`${BASE_URL}${p}`);
      check(!(await res.text()).includes(WP_PASSWORD), `the Application Password is not in ${p}`);
    }

    await openWebsite(page);
    await contactCard.waitFor({ timeout: 15_000 });
    await waitFor('"Apply to website" to be enabled', async () => contactCard.getByRole('button', { name: 'Apply to website', exact: true }).isEnabled(), { timeoutMs: 15_000, intervalMs: 500 });
    check(true, 'with WordPress connected the change can be applied');
    const EDITED = `${PHONE} (call or text)`;
    await contactCard.getByRole('button', { name: 'Edit wording', exact: true }).click();
    await contactCard.getByLabel('New wording').fill(EDITED);
    await contactCard.getByRole('button', { name: 'Save wording', exact: true }).click();
    await waitFor('the edited wording to be saved', async () => (await openEdits(page)).find((e) => e.id === contactChange.id)?.change.after === EDITED, { timeoutMs: 15_000, intervalMs: 500 });
    const editedCard = changeCard(page, contactChange.id);
    await editedCard.locator('pre').nth(1).getByText(EDITED, { exact: true }).waitFor({ timeout: 15_000 });
    check(/Written by you/.test(await textOf(editedCard)), 'the edited change is marked "Written by you"');
    await editedCard.getByRole('button', { name: 'Apply to website', exact: true }).click();
    const applyDialog = page.getByRole('dialog');
    await applyDialog.getByRole('heading', { name: 'Apply this change to your website?' }).waitFor();
    const dialogPres = applyDialog.locator('pre');
    const dialogText = await textOf(applyDialog);
    check(
      (await dialogPres.nth(0).innerText()) === '(03) 9876 5432' && (await dialogPres.nth(1).innerText()) === EDITED && dialogText.includes(`WordPress at ${SITE_HOST} — your public website.`) && dialogText.includes(`Page: ${SITE}/contact/`),
      'the confirmation shows the destination, the page and exactly the edited before/after',
      dialogText.slice(0, 300),
    );
    check((await fakeState()).wordpress.writeCount === 0, 'nothing is written before the owner confirms');
    await applyDialog.getByRole('button', { name: 'Apply now', exact: true }).click();
    await applyDialog.waitFor({ state: 'hidden', timeout: 15_000 });
    const applied = await waitForEdit(page, contactChange.id, ['applied', 'apply_failed'], 'the change to be applied');
    check(applied.status === 'applied' && applied.appliedVia === 'wordpress', 'the worker applied the change through WordPress', `${applied.status}: ${applied.statusMessage}`);
    const wpAfterApply = await fakeState();
    const contactItem = wpAfterApply.wordpress.items.find((i) => i.id === 12);
    check(wpAfterApply.wordpress.writeCount === 1 && wpAfterApply.wordpress.writes[0]?.id === 12, 'exactly one write reached WordPress, to the contact page', JSON.stringify(wpAfterApply.wordpress.writes));
    check(contactItem?.raw === `<h1>Contact</h1><p>Find us in Ivanhoe. Phone ${EDITED}.</p>`, "the fake's contact page now has the new text and nothing else changed", contactItem?.raw);
    check(applied.verification === 'confirmed_public', 'the change was confirmed on the public page', String(applied.verification));
    const appliedDone = await apiGet(page, '/api/website/edits?status=done');
    check(appliedDone.edits.some((e) => e.id === contactChange.id), 'the applied change moved to "Done"');

    // A second apply does nothing more: the API refuses it, and a re-delivered job claims nothing.
    expectError(/status of 409/, 'a second "Apply" of the applied change (POST /api/website/edits/:id/apply → 409)');
    const second = await pageFetch(page, `/api/website/edits/${contactChange.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, expectedAfter: EDITED, expectedBefore: '(03) 9876 5432', expectedDestination: applied.destination }),
    });
    check(second.status === 409, 'a second apply of the applied change is refused', `${second.status} ${JSON.stringify(second.body)}`);
    const { stdout } = await execFileAsync(TSX, [path.join(HERE, 'enqueue-job.ts'), 'website.edit_apply', JSON.stringify({ editId: contactChange.id })], { env: { ...process.env, DATABASE_URL } });
    const { bossJobId } = JSON.parse(stdout.trim().split('\n').pop());
    const rerun = await waitFor(
      'the re-delivered apply job to finish',
      async () => (await q("select status, message from jobs where boss_job_id = $1 and status in ('succeeded', 'failed', 'cancelled')", [bossJobId]))[0] ?? null,
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    check(rerun.status === 'succeeded' && /not waiting to be applied/.test(rerun.message ?? ''), 'a re-delivered apply job claims nothing', `${rerun.status}: ${rerun.message}`);
    check((await fakeState()).wordpress.writeCount === 1, 'WordPress still received exactly one write');

    // Someone edits the home page in WordPress after the owner approved and before the worker writes.
    log('A page changed in WordPress between approval and apply');
    const THIRD_PARTY = '<p>Fades, tapers and beard trims in Ivanhoe. Call (03) 9876 5432 or message us to book.</p>';
    await openWebsite(page);
    const homeCard = changeCard(page, homeChange.id);
    await homeCard.waitFor({ timeout: 15_000 });
    await fakePost('/__fake/wordpress/edit-on-next-read', { id: 2, raw: THIRD_PARTY });
    await homeCard.getByRole('button', { name: 'Apply to website', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply now', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 15_000 });
    const conflict = await waitForEdit(page, homeChange.id, ['applied', 'apply_failed'], 'the home page change to finish');
    check(conflict.status === 'apply_failed' && /changed in WordPress while we were applying/.test(conflict.statusMessage), 'the change is refused because the page changed', `${conflict.status}: ${conflict.statusMessage}`);
    const wpAfterConflict = await fakeState();
    check(wpAfterConflict.wordpress.writeCount === 1 && wpAfterConflict.wordpress.items.find((i) => i.id === 2)?.raw === THIRD_PARTY, 'nothing was written: the home page keeps the other edit', wpAfterConflict.wordpress.items.find((i) => i.id === 2)?.raw);
    await page.reload();
    await homeCard.getByText(/changed in WordPress while we were applying/).first().waitFor({ timeout: 15_000 });
    check(/Not applied/.test(await textOf(homeCard)), 'the card shows "Not applied" with the reason');

    // ---- f. Search Console through the real OAuth routes. -------------------------------------------------------
    log('Connect Search Console');
    await openWebsite(page);
    await searchCard.getByRole('link', { name: 'Connect Search Console' }).click();
    await page.waitForURL((u) => u.pathname === '/settings', { timeout: 30_000 });
    const auth = (await fakeState()).google.authorize.at(-1);
    check(
      auth?.product === 'search_console' && auth.scope === 'https://www.googleapis.com/auth/webmasters.readonly' && auth.accessType === 'offline' && auth.pkce === 'S256' && auth.redirectUri === `${BASE_URL}/api/integrations/google/callback`,
      'the consent screen was asked for read-only Search Console access only (offline, PKCE)',
      JSON.stringify(auth),
    );
    await openWebsite(page);
    await waitFor('the Search Console properties', async () => (await apiGet(page, '/api/website/search-performance?range=28d')).state === 'choose_property', { timeoutMs: 60_000, intervalMs: 1000 });
    await page.reload();
    const ourProperty = searchCard.locator('li', { hasText: `${SITE}/ · Owner` });
    await ourProperty.waitFor({ timeout: 15_000 });
    check((await searchCard.getByRole('button', { name: 'Use this one' }).count()) === 2, 'only readable properties can be chosen (two of three)');
    check(!/\d+ clicks|Impressions/.test(await textOf(searchCard)), 'no numbers are shown before a property is chosen');
    await ourProperty.getByRole('button', { name: 'Use this one' }).click();
    const sc = await waitFor(
      'Search Console numbers',
      async () => {
        const d = await apiGet(page, '/api/website/search-performance?range=28d');
        if (d.state === 'error') throw fatal(d.message ?? 'error');
        return d.state === 'connected' ? d : null;
      },
      { timeoutMs: 180_000, intervalMs: 2000 },
    );
    const stored = await q("select kind, count(*)::int as n from search_metrics where source = 'search_console' and property = $1 group by kind", [`${SITE}/`]);
    const storedOf = (k) => stored.find((r) => r.kind === k)?.n ?? 0;
    check(storedOf('total') === fakeData.scTotals.length && storedOf('query') === fakeData.scQueries.length, 'the sync stored exactly the rows the fake returned', JSON.stringify(stored));
    const lastDay = fakeData.scDays.at(-1);
    const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
    const local = fakeData.scQueries.filter((r) => r.query === 'barber ivanhoe');
    check(sc.property === `${SITE}/` && sc.dataThrough === lastDay, 'the numbers are for the chosen property, up to the last day Google reported', `${sc.property} ${sc.dataThrough}`);
    check(sc.groups?.local?.clicks === sum(local, 'clicks') && sc.groups?.local?.impressions === sum(local, 'impressions'), 'local searches add up to what the fake returned', JSON.stringify(sc.groups?.local));
    await page.reload();
    await searchCard.getByText(/^Source: Google Search Console/).waitFor({ timeout: 15_000 });
    const scText = await textOf(searchCard);
    const lastDayLabel = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium' }).format(new Date(`${lastDay}T12:00:00Z`));
    check(scText.includes(`Source: Google Search Console (${SITE}/). Data up to ${lastDayLabel}`), 'the card labels the numbers as Google Search Console with the property and "data up to" date', scText.slice(0, 260));
    check((await searchCard.getByRole('button', { name: 'Last 28 days' }).getAttribute('aria-pressed')) === 'true', 'the date range shown is "Last 28 days"');
    const localTile = searchCard.locator('div.rounded-lg', { has: page.getByText('Local searches', { exact: true }) }).first();
    const fmt = (n) => new Intl.NumberFormat('en-AU').format(n);
    const localText = await textOf(localTile);
    check(localText.includes(`Clicks ${fmt(sum(local, 'clicks'))}`) && localText.includes(`Impressions ${fmt(sum(local, 'impressions'))}`), "the local searches tile shows the fake's numbers", localText);
    const row = searchCard.locator('tr', { has: page.getByRole('cell', { name: 'barber ivanhoe', exact: true }) });
    check((await row.count()) === 1 && (await textOf(row)).startsWith(`barber ivanhoe ${sum(local, 'clicks')} ${sum(local, 'impressions')}`), '"barber ivanhoe" is listed with its clicks and impressions', (await row.count()) ? await textOf(row) : 'no row');

    // ---- g. Google Business Profile: waiting for approval, reviews, Performance. ---------------------------------
    log('Connect Google Business Profile (quota 0 first)');
    await page.goto(`${BASE_URL}/reviews`);
    await page.getByRole('tab', { name: 'Reviews on Google' }).click();
    await googleTab.getByRole('link', { name: 'Connect Google Business Profile' }).click();
    await page.waitForURL((u) => u.pathname === '/settings', { timeout: 30_000 });
    const bpAuth = (await fakeState()).google.authorize.at(-1);
    check(bpAuth?.product === 'business_profile' && bpAuth.scope === 'https://www.googleapis.com/auth/business.manage', 'the consent screen was asked for the Business Profile scope only', JSON.stringify(bpAuth));
    const firstSync = await waitFor(
      'the first Business Profile sync to finish',
      async () => (await q("select status, message, attempts from jobs where type = 'reviews.gbp.sync' and status in ('succeeded', 'failed', 'cancelled') order by created_at desc limit 1"))[0] ?? null,
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    check(firstSync.status === 'succeeded', 'quota 0 ends the sync normally (no failure, no retry)', `${firstSync.status}: ${firstSync.message}`);
    await page.goto(`${BASE_URL}/reviews`);
    await page.getByRole('tab', { name: 'Reviews on Google' }).click();
    await googleTab.getByText('Waiting for Google', { exact: true }).waitFor({ timeout: 15_000 });
    const waitingText = await textOf(googleTab);
    check(/Google hasn't approved API access for this project yet/.test(waitingText) && !/Problem|couldn't be read|error/i.test(waitingText), 'Reviews on Google shows "Waiting for Google approval", not an error', waitingText.slice(0, 240));
    const quotaCalls = (await fakeState()).google.businessProfile;
    check(quotaCalls.length === 1 && quotaCalls[0].status === 429, 'Google was asked once and answered quota 0 (429)', JSON.stringify(quotaCalls));
    await openWebsite(page);
    const profileWaiting = await textOf(profileCard);
    check(!/\d/.test(profileWaiting.replace(/14 days/g, '')) && !/—/.test(profileWaiting), 'the Performance card shows no numbers while Google has not approved access', profileWaiting.slice(0, 240));
    // No retry storm: nothing else was sent to Google, and no sync is waiting to run again.
    const pendingRetries = await q("select count(*)::int as n from jobs where type in ('reviews.gbp.sync', 'website.connection_check', 'search.sync') and status in ('queued', 'running')");
    const stillOne = (await fakeState()).google.businessProfile.length;
    check(stillOne === 1 && pendingRetries[0].n === 0, 'no retries: still one call to Google and nothing queued to try again', `${stillOne} calls, ${pendingRetries[0].n} queued`);

    log('Google approves access; reviews and Performance');
    await fakePost('/__fake/business-profile', { quotaZero: false });
    await page.goto(`${BASE_URL}/reviews`);
    await page.getByRole('tab', { name: 'Reviews on Google' }).click();
    await googleTab.getByRole('button', { name: 'Check again' }).click();
    await waitFor('the Google reviews', async () => (await apiGet(page, '/api/reviews/google')).profile.state === 'connected', { timeoutMs: 60_000, intervalMs: 1000 });
    await page.reload();
    await page.getByRole('tab', { name: 'Reviews on Google' }).click();
    const reviewItems = googleTab.locator('ul > li');
    await reviewItems.first().waitFor({ timeout: 15_000 });
    const shown = await reviewItems.allInnerTexts();
    const stars = await reviewItems.locator('[aria-label$="out of 5 stars"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const RATING = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 };
    const dateLabel = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'medium' }).format(new Date(iso));
    const expected = [...fakeData.reviews].sort((a, b) => b.createTime.localeCompare(a.createTime));
    check(shown.length === expected.length, "every one of the fake's reviews is listed", `${shown.length} of ${expected.length}`);
    for (const r of expected) {
      const i = shown.findIndex((t) => t.includes(r.displayName));
      const text = i >= 0 ? shown[i].replace(/\s+/g, ' ') : '';
      check(i >= 0 && text.includes(r.comment) && text.includes(dateLabel(r.createTime)) && stars[i] === `${RATING[r.starRating]} out of 5 stars`, `the review by ${r.displayName} is shown as written (rating, text, date)`, text.slice(0, 200));
    }
    check(shown.some((t) => t.includes('Your reply on Google') && t.includes('Thanks Josh, see you next time!')), "Google's own reply is shown as the studio's reply on Google");
    const googleText = await textOf(googleTab);
    check(googleText.includes(`From Google Business Profile (${fakeData.location.title})`) && /we never match the two/.test(googleText), 'the list is labelled as from Google Business Profile and kept apart from requests', googleText.slice(0, 200));
    check(!/Review request:|Waiting for approval|Scheduled\b/.test(googleText), "Google's reviews never use the review-request status words");
    await page.getByRole('tab', { name: /^Requests/ }).click();
    const requestsPanel = page.getByRole('tabpanel', { name: /^Requests/ });
    await requestsPanel.waitFor();
    const requestsText = await textOf(requestsPanel);
    check(
      expected.every((r) => !requestsText.includes(r.displayName) && !requestsText.includes(r.comment)),
      'the Requests tab shows none of the Google reviews',
      requestsText.slice(0, 300),
    );

    const perf = await waitFor(
      'Business Profile Performance numbers',
      async () => {
        const d = await apiGet(page, '/api/website/business-profile-performance?range=28d');
        if (d.state === 'error' || d.state === 'api_disabled') throw fatal(d.message ?? d.state);
        return d.state === 'connected' ? d : null;
      },
      { timeoutMs: 180_000, intervalMs: 2000 },
    );
    const series = fakeData.perfSeries;
    const total = (...metrics) => metrics.reduce((s, m) => s + series[m].reduce((a, b) => a + b, 0), 0);
    const expectTiles = {
      Calls: total('CALL_CLICKS'),
      'Direction requests': total('BUSINESS_DIRECTION_REQUESTS'),
      'Website clicks': total('WEBSITE_CLICKS'),
      'Views on Google Search': total('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'),
      'Views on Google Maps': total('BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'),
    };
    check(perf.totals?.bookings === null && perf.totals?.messages === null && perf.totals?.calls === expectTiles.Calls, 'a metric Google sent without values stays empty, not 0', JSON.stringify(perf.totals));
    const nullRows = await q("select count(*)::int as n from search_metrics where source = 'business_profile' and kind = 'metric' and key = 'BUSINESS_BOOKINGS' and value is null");
    const zeroRows = await q("select count(*)::int as n from search_metrics where source = 'business_profile' and kind = 'metric' and key in ('BUSINESS_BOOKINGS', 'MESSAGING_CLICKS') and value is not null");
    check(nullRows[0].n === fakeData.perfDays.length && zeroRows[0].n === 0, 'bookings are stored as NULL for each day Google listed, and no message clicks were made up', `${nullRows[0].n} null rows, ${zeroRows[0].n} with a number`);
    await openWebsite(page);
    await profileCard.getByText(/^Source: Google Business Profile/).waitFor({ timeout: 15_000 });
    const tiles = await profileCard.locator('dl > div').evaluateAll((els) => els.map((el) => [el.querySelector('dt')?.textContent?.trim(), el.querySelectorAll('dd')[0]?.textContent?.trim()]));
    const tileMap = Object.fromEntries(tiles);
    const fmtNum = (n) => new Intl.NumberFormat('en-AU').format(n);
    check(Object.entries(expectTiles).every(([k, v]) => tileMap[k] === fmtNum(v)), "the Performance tiles show the fake's numbers", JSON.stringify(tileMap));
    check(tileMap.Bookings === '—' && tileMap['Message clicks'] === '—', 'missing metrics show as "—" (Google sent no number), never 0', JSON.stringify(tileMap));
    const profileText = await textOf(profileCard);
    check(profileText.includes(`Source: Google Business Profile (${fakeData.location.title})`) && profileText.includes('“—” means Google sent no number'), 'the Performance card names its source and explains "—"', profileText.slice(0, 260));

    // ---- h. Layout at 390 and 1440 px. --------------------------------------------------------------------------
    for (const viewport of [PHONE_VIEWPORT, DESKTOP]) {
      await page.setViewportSize(viewport);
      await openWebsite(page);
      await profileCard.getByText(/^Source: Google Business Profile/).waitFor({ timeout: 15_000 });
      const w = await checkLayout(page, `Website at ${viewport.width} px`);
      check(w.connectionTitles.length === 2 && w.connectionTitles.every((t) => !t.cut && t.height < 30), `Website at ${viewport.width} px: connection card titles fit on one line`, JSON.stringify(w.connectionTitles));
      await page.goto(`${BASE_URL}/reviews`);
      await page.getByRole('tab', { name: 'Reviews on Google' }).click();
      await reviewItems.first().waitFor({ timeout: 15_000 });
      await checkLayout(page, `Reviews at ${viewport.width} px`);
    }

    // ---- No retry storm, over the whole run: Google answered quota 0 exactly once. --------------------------------
    const bpCalls = (await fakeState()).google.businessProfile;
    check(bpCalls.filter((c) => c.status === 429).length === 1, 'over the whole run Google answered quota 0 only once (nothing retried it)', `${bpCalls.length} calls: ${bpCalls.map((c) => c.status).join(',')}`);

    // ---- Credentials never reached the browser. -----------------------------------------------------------------
    const bodies = await Promise.all(appResponses.slice(responsesBeforeWp));
    const leaks = bodies.filter((b) => b.text.includes(WP_PASSWORD) || /sc-access-|business_profile-refresh|search_console-refresh|access-\d+\b/.test(b.text));
    const read = bodies.filter((b) => b.read);
    log(`  (read ${read.length} of ${bodies.length} app responses after connecting WordPress)`);
    check(read.length > 50 && leaks.length === 0, 'no app response after connecting carried the Application Password or a Google token', leaks.map((b) => b.url).join(', '));

    // ---- Console. -------------------------------------------------------------------------------------------------
    const unexpected = consoleErrors.filter((e) => {
      const match = expectedErrors.find((x) => x.pattern.test(`${e.text} ${e.url}`));
      if (match) match.seen++;
      return !match && !abortedLoadWeIgnore(e);
    });
    const ignored = consoleErrors.filter(abortedLoadWeIgnore);
    if (ignored.length) log(`  (ignored ${ignored.length} cancelled prefetch loads)`);
    check(unexpected.length === 0, 'no unexpected page errors or console errors', unexpected.slice(0, 5).map((e) => `${e.text} ${e.url}`).join(' | '));
    for (const x of expectedErrors) check(x.seen >= 1, `the deliberate error appeared: ${x.why}`, `${x.seen} seen`);
    await context.close();
  } catch (err) {
    failures.push(`stopped early: ${err instanceof Error ? err.message : String(err)}`);
    log(`STOPPED: ${err instanceof Error ? err.stack : String(err)}`);
    if (page) await failureScreenshot(page, 'stopped');
  } finally {
    await browser.close();
    await db.end();
  }

  console.log('');
  console.log(`${passes.length} checks passed, ${failures.length} failed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  for (const f of failures) console.log(`  - ${f}`);
  if (expectedErrors.length) {
    console.log('Console errors caused on purpose:');
    for (const x of expectedErrors) console.log(`  ${x.why} (${x.seen} seen)`);
  }
  if (consoleErrors.length) {
    console.log('Browser console errors seen:');
    for (const e of consoleErrors.slice(0, 20)) console.log(`  ${e.text} ${e.url}`);
  }
  process.exit(failures.length ? 1 : 0);
}

await main();
