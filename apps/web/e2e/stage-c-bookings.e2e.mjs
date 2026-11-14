#!/usr/bin/env node
/**
 * Stage C end-to-end check in a real browser (Chromium through Playwright) for bookings, email and reviews: Square
 * (read-only appointments, booking changes switched off), Postmark email with the consent ledger and send gate, and
 * review requests, against local fakes of Square and Postmark (apps/web/e2e/fake-stage-c.ts, built on the worker's own
 * fakes). It drives the running web app and worker the way the owner (and a barber) would and checks real outcomes in
 * the app after a reload. The database is read only where the UI cannot show something (whether a row was created at
 * all, what a webhook stored, purged sandbox rows); the fakes are read through their control port.
 *
 * Two phases, run by `bash apps/web/e2e/run-stage-c-bookings.sh` with a restart of the web app and the worker between
 * them (SQUARE_ENVIRONMENT=sandbox, then production, both pointing at the fake):
 *   sandbox     Square connect (read scopes), location, first sync, Melbourne times, sandbox label, owner-only contact
 *               details, booking changes not offered, email set-up (business identity, read-only Postmark check,
 *               review link, automations in "ask me to approve" mode), a sandbox booking marked attended creates no
 *               follow-up or review request, a signed Square webhook updates a booking and a forged one is refused.
 *   production  reconnect needed after the switch, reconnect purges the sandbox data, live bookings without the label,
 *               consent recorded at the counter, a completed live booking → review request → approve → exactly one
 *               send with the sender identification footer, unsubscribe page, campaign pause / resume / auto-pause on a
 *               spam complaint / cancel, Postmark webhooks with right and wrong credentials, no Square write at all,
 *               390 px layouts and the console.
 * The second phase loads the first phase's results from E2E_STATE_FILE and prints the total.
 *
 * Settings (environment variables): E2E_PHASE (sandbox | production), E2E_BASE_URL, E2E_FAKE_CONTROL_URL,
 * E2E_DATABASE_URL, E2E_STATE_FILE, E2E_OUT_DIR, E2E_SQUARE_SIGNATURE_KEY, E2E_POSTMARK_WEBHOOK_USERNAME,
 * E2E_POSTMARK_WEBHOOK_PASSWORD, E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD.
 *
 * Exit code 0 when every check passed, 1 otherwise. Plain node + playwright + pg; no test runner.
 */
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const PHASE = process.env.E2E_PHASE ?? 'sandbox';
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3800').replace(/\/$/, '');
const CONTROL_URL = (process.env.E2E_FAKE_CONTROL_URL ?? '').replace(/\/$/, '');
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const OUT_DIR = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'studio-e2e-c');
const STATE_FILE = process.env.E2E_STATE_FILE ?? path.join(OUT_DIR, 'phase-state.json');
const SQUARE_KEY = process.env.E2E_SQUARE_SIGNATURE_KEY ?? '';
const HOOK_USER = process.env.E2E_POSTMARK_WEBHOOK_USERNAME ?? '';
const HOOK_PASSWORD = process.env.E2E_POSTMARK_WEBHOOK_PASSWORD ?? '';
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@example.com';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'clipper guard number two';
const OWNER_NAME = 'E2E Owner';
const STAFF_EMAIL = 'e2e-barber@example.com';
const STAFF_PASSWORD = 'fade and taper forever';
const STAFF_NAME = 'E2E Barber';
const TSX = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'tsx');
const DESKTOP = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

const BUSINESS = { name: 'Ivanhoe Test Barbers', street: '1 Upper Heidelberg Road', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', country: 'Australia', phone: '03 9000 1234', email: 'hello@ivanhoe-barbers.test' };
const REVIEW_LINK = 'https://g.page/r/ivanhoe-test-barbers/review';
const TZ = 'Australia/Melbourne';
const LOCATIONS = [
  { id: 'LOC_1', name: 'Ivanhoe', timezone: TZ, status: 'ACTIVE', country: 'AU', currency: 'AUD' },
  { id: 'LOC_2', name: 'Northcote pop-up', timezone: TZ, status: 'ACTIVE', country: 'AU', currency: 'AUD' },
];
/** Words a review request may never contain (incentives or selective wording; the linter's own list is longer). */
const GATING_WORDS = /discount|% off|voucher|gift|prize|reward|5[- ]star|five star|if you (were|are) happy|if you enjoyed|positive review/i;

// ---------------------------------------------------------------------------------------------------------------
// Results, carried from the sandbox phase into the production phase
// ---------------------------------------------------------------------------------------------------------------

const carried = PHASE === 'production' && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
if (PHASE === 'production' && !carried) {
  console.error(`The production phase needs the sandbox phase's results in ${STATE_FILE}.`);
  process.exit(2);
}
const passes = carried?.passes ?? [];
const failures = carried?.failures ?? [];
const started = Date.now();
const elapsedBefore = carried?.elapsedMs ?? 0;

function log(message) {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[${PHASE.slice(0, 4)} ${t}s] ${message}`);
}

/** Records one check; failed checks make the run exit with 1 but do not stop the remaining steps. */
function check(condition, message, detail) {
  const label = `[${PHASE}] ${message}`;
  if (condition) {
    passes.push(label);
    log(`  ok   ${message}`);
  } else {
    failures.push(detail ? `${label} (${detail})` : label);
    log(`  FAIL ${message}${detail ? ` (${detail})` : ''}`);
  }
  return condition;
}

class FatalError extends Error {}
const fatal = (message) => new FatalError(message);

/** Polls `fn` until it returns a truthy value or the time runs out. A {@link FatalError} stops the wait at once. */
async function waitFor(description, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
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

async function failureScreenshot(page, name) {
  try {
    await mkdir(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `failure-${PHASE}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`  saved ${file}`);
  } catch {
    // The page may already be closed; the failure itself is what matters.
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Melbourne time (computed here independently of the app)
// ---------------------------------------------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function melbourneParts(d) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}
/** The UTC instant of a Melbourne wall-clock time (two passes cover the daylight-saving offset). */
function melbourneInstant(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted - 10 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const p = melbourneParts(new Date(guess));
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += wanted - shown;
  }
  return new Date(guess);
}
function addDays(date, n) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}
const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
/** "10:00 am", the way a Melbourne barber reads it. */
const timeLabel = (d) => timeFmt.format(d).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const dayLabel = (d) => dayFmt.format(d).replace(',', '');

// ---------------------------------------------------------------------------------------------------------------
// Fakes, jobs and small UI helpers
// ---------------------------------------------------------------------------------------------------------------

async function control(pathname, body) {
  const res = await fetch(`${CONTROL_URL}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`fake control ${pathname} answered ${res.status}`);
  return res.json();
}
const fakeState = () => control('/state');

/** Sends one job through the app's queue (apps/web/e2e/enqueue-job.ts) and waits until the worker finished it. */
async function runJob(q, type, payload = {}) {
  const { stdout } = await execFileAsync(TSX, [path.join(HERE, 'enqueue-job.ts'), type, JSON.stringify(payload)], { env: { ...process.env, DATABASE_URL }, cwd: path.join(REPO_ROOT, 'apps', 'web') });
  const { bossJobId } = JSON.parse(stdout.trim().split('\n').pop());
  if (!bossJobId) throw new Error(`${type} was not queued (a singleton may already be waiting)`);
  return waitFor(`the ${type} run to finish`, async () => {
    const row = (await q("select status, message from jobs where boss_job_id = $1 and status in ('succeeded', 'failed', 'cancelled')", [bossJobId]))[0];
    if (row && row.status !== 'succeeded') throw fatal(`${type} ended ${row.status}: ${row.message}`);
    return row ?? null;
  });
}

async function textOf(locator) {
  return ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();
}

/** A Card (components/ui/card.tsx) by its title. */
function cardByTitle(page, title) {
  return page.locator('div[class*="radius-card"]', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
}

async function openSettings(page, tab) {
  await page.goto(`${BASE_URL}/settings?tab=${tab}`);
  await page.getByRole('tab', { selected: true }).waitFor({ timeout: 30_000 });
}

async function openTab(page, url, tabName) {
  await page.goto(url);
  const tab = page.getByRole('tab', { name: tabName });
  await tab.first().waitFor({ timeout: 30_000 });
  if ((await tab.first().getAttribute('aria-selected')) !== 'true') await tab.first().click();
  await page.getByRole('tabpanel').waitFor();
  return page.getByRole('tabpanel');
}

async function toast(page, text) {
  await page.getByRole('status').filter({ hasText: text }).first().waitFor({ timeout: 20_000 });
}

/**
 * Runs a UI action and waits for the write request it sends (any method but GET whose path matches), so a toast still
 * on screen from an earlier save can never stand in for this one. Throws when the request failed.
 */
async function submit(page, action, pathRe, toastText) {
  const [res] = await Promise.all([page.waitForResponse((r) => r.request().method() !== 'GET' && pathRe.test(new URL(r.url()).pathname), { timeout: 30_000 }), action()]);
  if (!res.ok()) throw new Error(`${res.request().method()} ${new URL(res.url()).pathname} answered ${res.status()}`);
  if (toastText) await toast(page, toastText);
  return res;
}

async function apiJson(page, method, urlPath, body) {
  const res = await page.request.fetch(`${BASE_URL}${urlPath}`, { method, headers: { origin: BASE_URL, 'content-type': 'application/json' }, ...(body === undefined ? {} : { data: JSON.stringify(body) }) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON.
  }
  return { status: res.status(), json };
}

async function signIn(context, email, password) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  return page;
}

/** The booking card (`<li>`) of a client in the current Appointments tab panel. */
function bookingCard(scope, clientName) {
  return scope.locator('li', { has: scope.page().getByText(clientName, { exact: true }) }).first();
}

/** Waits until the latest square.sync is finished and the connection has synced (through the card's own API). */
async function waitForSquareSync(page, description, since) {
  return waitFor(
    description,
    async () => {
      const s = (await apiJson(page, 'GET', '/api/integrations/square')).json;
      if (s?.sync?.status === 'failed') throw fatal(`the sync failed: ${s.sync.message}`);
      const done = s && s.state === 'connected' && s.lastSyncAt && (!since || Date.parse(s.lastSyncAt) > since) && !['queued', 'running'].includes(s.sync?.status ?? '');
      return done ? s : null;
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );
}

function squareSignature(body) {
  return createHmac('sha256', SQUARE_KEY).update(`${BASE_URL}/api/webhooks/square${body}`, 'utf8').digest('base64');
}

async function postSquareWebhook(body, signature) {
  const res = await fetch(`${BASE_URL}/api/webhooks/square`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function postPostmarkWebhook(record, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  const res = await fetch(`${BASE_URL}/api/webhooks/postmark`, { method: 'POST', headers, body: JSON.stringify(record) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** No horizontal overflow at the current viewport (the page itself and every element inside the main area). */
async function overflowAt(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main') ?? document.body;
    // An element sticking out counts unless an ancestor clips or scrolls it (e.g. the swipeable tab strip).
    const clipped = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= doc.clientWidth + 1) return true;
      }
      return false;
    };
    const wide = [...main.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > doc.clientWidth + 1 && getComputedStyle(el).position !== 'fixed' && !clipped(el);
    });
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders: wide.slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} "${(el.textContent ?? '').trim().slice(0, 40)}"`) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios the fake Square serves
// ---------------------------------------------------------------------------------------------------------------

/** Start times computed once per phase (a past appointment ended about two hours ago; one tomorrow at a set time). */
function times() {
  const now = new Date();
  const past = new Date(Math.floor((now.getTime() - 3 * 3600_000) / 300_000) * 300_000);
  const today = melbourneParts(now).date;
  const tomorrow = addDays(today, 1);
  return { past, tomorrow10: melbourneInstant(tomorrow, '10:00'), tomorrow11: melbourneInstant(tomorrow, '11:00'), tomorrow12: melbourneInstant(tomorrow, '12:00') };
}

function sandboxScenario(t) {
  return {
    merchantId: 'MERCHANT_SANDBOX_1',
    accessToken: 'fake-square-sandbox-access',
    refreshToken: 'fake-square-sandbox-refresh',
    oauthCode: 'fake-square-sandbox-code',
    locations: LOCATIONS,
    customers: [
      { id: 'SB_SANDY', given: 'Sandy', family: 'Sandbox', email: 'sandy.sandbox@example.com', phone: '+61 400 111 222' },
      { id: 'SB_TESS', given: 'Tess', family: 'Tester', email: 'tess.tester@example.com', phone: '+61 400 333 444' },
      { id: 'SB_OLLY', given: 'Olly', family: 'Otherplace', email: 'olly.otherplace@example.com', phone: '+61 400 555 666' },
    ],
    bookings: [
      { id: 'SB_PAST', startAt: t.past.toISOString(), customerId: 'SB_SANDY', locationId: 'LOC_1' },
      { id: 'SB_TOMORROW', startAt: t.tomorrow10.toISOString(), customerId: 'SB_TESS', locationId: 'LOC_1' },
      { id: 'SB_OTHER_LOCATION', startAt: t.tomorrow12.toISOString(), customerId: 'SB_OLLY', locationId: 'LOC_2' },
    ],
  };
}

const LIVE = {
  riley: { id: 'LIVE_RILEY', given: 'Riley', family: 'Reviewer', email: 'riley.reviewer@example.com', phone: '+61 411 000 001' },
  casey: { id: 'LIVE_CASEY', given: 'Casey', family: 'Campbell', email: 'casey.campbell@example.com', phone: '+61 411 000 002' },
  morgan: { id: 'LIVE_MORGAN', given: 'Morgan', family: 'Mailer', email: 'morgan.mailer@example.com', phone: '+61 411 000 003' },
  jordan: { id: 'LIVE_JORDAN', given: 'Jordan', family: 'Jones', email: 'jordan.jones@example.com', phone: '+61 411 000 004' },
  noah: { id: 'LIVE_NOAH', given: 'Noah', family: 'Nopermission', email: 'noah.nopermission@example.com', phone: '+61 411 000 005' },
};
const fullName = (c) => `${c.given} ${c.family}`;

function productionScenario(t) {
  return {
    merchantId: 'MERCHANT_LIVE_1',
    accessToken: 'fake-square-live-access',
    refreshToken: 'fake-square-live-refresh',
    oauthCode: 'fake-square-live-code',
    locations: LOCATIONS,
    customers: Object.values(LIVE),
    bookings: [
      { id: 'LIVE_PAST', startAt: t.past.toISOString(), customerId: LIVE.riley.id, locationId: 'LOC_1' },
      { id: 'LIVE_TOMORROW', startAt: t.tomorrow11.toISOString(), customerId: LIVE.casey.id, locationId: 'LOC_1' },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 1: Square sandbox and email set-up
// ---------------------------------------------------------------------------------------------------------------

async function sandboxPhase({ browser, q, owner, staff, expectError, watch }) {
  const t = times();

  // ---- a. Honest states before connecting. -----------------------------------------------------------------------
  log('Integrations before connecting Square');
  await openSettings(owner, 'integrations');
  const squareCard = cardByTitle(owner, 'Square Appointments');
  await squareCard.getByRole('link', { name: 'Connect Square' }).waitFor({ timeout: 30_000 });
  const before = await textOf(squareCard);
  check(/Not connected/.test(before) && !/Last synced|Business|Sync now/.test(before), 'Square shows "Not connected" with a Connect button and no Square data before connecting', before.slice(0, 300));
  check(/Read-only permissions/.test(before), 'the Square card says it asks for read-only permissions', before.slice(0, 200));
  await owner.goto(`${BASE_URL}/appointments`);
  await owner.getByText('This section turns on once these are set up. Nothing here is simulated.').waitFor({ timeout: 30_000 });
  check((await owner.getByRole('link', { name: 'Connect Square' }).count()) > 0 && (await owner.getByRole('tab', { name: 'Upcoming' }).count()) === 0, 'Appointments shows the honest "needs setup" overview and no bookings before Square is connected');

  // ---- a. Connect Square (sandbox) through the real OAuth flow against the fake. --------------------------------
  log('Connect Square (sandbox)');
  await control('/square/scenario', sandboxScenario(t));
  await openSettings(owner, 'integrations');
  await cardByTitle(owner, 'Square Appointments').getByRole('link', { name: 'Connect Square' }).click();
  await owner.waitForURL((u) => u.pathname === '/settings' && u.origin === new URL(BASE_URL).origin, { timeout: 30_000 });
  const connected = cardByTitle(owner, 'Square Appointments');
  await connected.getByText(/Square is connected/).waitFor({ timeout: 30_000 });
  const fake1 = await fakeState();
  const auth = fake1.square.authorize.at(-1);
  const scopes = (auth?.scope ?? '').split(' ').filter(Boolean);
  check(scopes.length > 0 && scopes.every((s) => /_READ$/.test(s)) && !scopes.some((s) => /WRITE/.test(s)), 'Square was asked for read permissions only', scopes.join(' '));
  check(auth?.session === 'false' && auth?.redirectUri === `${BASE_URL}/api/integrations/square/callback`, 'the authorise request uses session=false and the registered callback address', JSON.stringify(auth));
  check((fake1.square.counts.token ?? 0) === 1, 'the code was exchanged once', JSON.stringify(fake1.square.counts));
  const tokenRow = (await q("select access_token_encrypted as a, refresh_token_encrypted as r from integration_connections where provider = 'square'"))[0];
  check(tokenRow && !String(tokenRow.a).includes('fake-square-sandbox-access') && !String(tokenRow.r).includes('fake-square-sandbox-refresh'), 'the Square tokens are stored encrypted, never in plain text');

  log('Choose the location');
  const locationSelect = owner.getByLabel('Choose your studio’s Square location');
  await waitFor('the location picker', async () => {
    if ((await locationSelect.count()) > 0) return true;
    await owner.reload();
    await owner.getByRole('tab', { selected: true }).waitFor();
    return false;
  }, { timeoutMs: 90_000, intervalMs: 3000 });
  check((await owner.getByText('No bookings are copied until you choose. Only your studio’s location is shown.').count()) === 1, 'with two Square locations nothing is copied until the owner chooses one');
  const chosenAt = Date.now();
  await submit(owner, () => locationSelect.selectOption({ label: 'Ivanhoe' }), /^\/api\/integrations\/square$/, 'Location saved');
  const synced = await waitForSquareSync(owner, 'the first sync for the chosen location', chosenAt);
  check(synced.locationId === 'LOC_1' && synced.dataEnvironment === 'sandbox', 'the sync ran for Ivanhoe in the sandbox', `${synced.locationId} / ${synced.dataEnvironment}`);
  await openSettings(owner, 'integrations');
  await cardByTitle(owner, 'Square Appointments').getByText('Last synced').waitFor({ timeout: 30_000 });
  const cardAfter = await textOf(cardByTitle(owner, 'Square Appointments'));
  check(/Sandbox \(test\)/.test(cardAfter) && /Square’s test environment: test bookings and test clients only\./.test(cardAfter), 'the Square card labels the connection as the sandbox (test)', cardAfter.slice(0, 240));
  check(!/fake-square-sandbox-access|fake-square-sandbox-refresh|fake-square-secret/.test(await owner.content()), 'no Square token or secret reaches the browser');

  // ---- a. Appointments in Melbourne time with the sandbox label. ---------------------------------------------------
  log('Appointments (sandbox)');
  const upcoming = await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  await owner.getByText('Sandbox — these are Square test bookings and test clients, not real ones.').waitFor({ timeout: 30_000 });
  check(true, 'Appointments shows the sandbox warning');
  check((await owner.getByText('Sandbox (test)', { exact: true }).count()) > 0, 'the header pill says "Sandbox (test)"');
  const tessCard = bookingCard(upcoming, 'Tess Tester');
  await tessCard.waitFor({ timeout: 30_000 });
  const tessText = await textOf(tessCard);
  const expectedRange = `${timeLabel(t.tomorrow10)} – ${timeLabel(new Date(t.tomorrow10.getTime() + 45 * 60_000))}`;
  check(tessText.includes(expectedRange) && expectedRange === '10:00 am – 10:45 am', 'tomorrow’s booking shows 10:00 am – 10:45 am Melbourne time', `${tessText.slice(0, 120)} / expected ${expectedRange}`);
  check(/Skin fade · Sam/.test(tessText), 'the booking shows the service and barber from Square', tessText.slice(0, 160));
  const dayHeading = await textOf(upcoming.locator('section', { has: owner.getByText('Tess Tester', { exact: true }) }).locator('h3'));
  check(dayHeading.toLowerCase() === `tomorrow · ${dayLabel(t.tomorrow10)}`.toLowerCase(), 'it is listed under tomorrow’s Melbourne date', `${dayHeading} / ${dayLabel(t.tomorrow10)}`);
  const upcomingText = await textOf(upcoming);
  check(!upcomingText.includes('Olly Otherplace'), 'a booking at the other Square location is not shown');

  // Contact details: owner yes, staff no.
  log('Client contact details (owner and staff)');
  const ownerClients = await openTab(owner, `${BASE_URL}/appointments`, 'Clients');
  await ownerClients.getByText('Tess Tester', { exact: true }).waitFor({ timeout: 30_000 });
  check(/tess\.tester@example\.com/.test(await textOf(ownerClients)), 'the owner sees the client’s email in Clients');
  await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  await bookingCard(owner.getByRole('tabpanel'), 'Tess Tester').getByRole('button').first().click();
  const ownerDialog = owner.getByRole('dialog');
  await ownerDialog.getByText('Square’s status').waitFor({ timeout: 15_000 });
  const ownerDialogText = await textOf(ownerDialog);
  check(/tess\.tester@example\.com/.test(ownerDialogText) && /\+61 400 333 444/.test(ownerDialogText), 'the owner sees email and phone in the booking', ownerDialogText.slice(0, 300));
  check(!/\bMove\b|Cancel booking/.test(ownerDialogText), 'the booking offers no Move or Cancel (booking changes are off)', ownerDialogText.slice(0, 300));
  await owner.keyboard.press('Escape');
  check((await owner.getByRole('button', { name: 'New booking' }).count()) === 0, 'Appointments offers no "New booking"');
  check(/Changes from here: Not available yet: booking changes are made in Square/.test(await textOf(owner.locator('main'))), 'the header says booking changes are made in Square');

  const staffClients = await openTab(staff, `${BASE_URL}/appointments`, 'Clients');
  await staffClients.getByText('Tess Tester', { exact: true }).waitFor({ timeout: 30_000 });
  const staffClientsText = await textOf(staffClients);
  check(!/@example\.com|\+61 4/.test(staffClientsText), 'a barber (staff) sees client names but no email or phone in Clients', staffClientsText.slice(0, 200));
  await openTab(staff, `${BASE_URL}/appointments`, 'Upcoming');
  await bookingCard(staff.getByRole('tabpanel'), 'Tess Tester').getByRole('button').first().click();
  const staffDialog = staff.getByRole('dialog');
  await staffDialog.getByText('Square’s status').waitFor({ timeout: 15_000 });
  check(!/@example\.com|\+61 4/.test(await textOf(staffDialog)), 'a barber sees no email or phone in the booking');
  await staff.keyboard.press('Escape');
  const staffApi = await apiJson(staff, 'GET', '/api/appointments/clients?q=');
  check(staffApi.status === 200 && staffApi.json.clients.length >= 2 && staffApi.json.clients.every((c) => c.email === null && c.phone === null), 'the clients API gives a barber no email or phone either', JSON.stringify(staffApi.json?.clients?.[0] ?? staffApi));
  const tessBooking = (await q("select id from bookings where square_booking_id = 'SB_TOMORROW'"))[0];
  const staffBooking = await apiJson(staff, 'GET', `/api/appointments/${tessBooking.id}`);
  check(staffBooking.status === 200 && staffBooking.json.clientEmail === null && staffBooking.json.clientPhone === null, 'the booking API gives a barber no email or phone', JSON.stringify({ e: staffBooking.json?.clientEmail, p: staffBooking.json?.clientPhone }));

  // ---- j. Booking changes stay off. -------------------------------------------------------------------------------
  log('Booking changes are refused');
  const refused = await apiJson(owner, 'POST', '/api/appointments/changes', { kind: 'cancel', bookingId: tessBooking.id, expectedVersion: 0 });
  const refusal = refused.json?.error?.message ?? '';
  check(refused.status >= 400 && refused.status < 500 && refusal === 'Booking changes from Studio Assistant aren’t available yet. Make changes in Square.', 'POST /api/appointments/changes is refused with a plain reason', `${refused.status}: ${refusal}`);
  check((await q('select count(*)::int as n from square_booking_changes'))[0].n === 0, 'no booking change was recorded');
  const writeTry = await apiJson(owner, 'GET', '/api/integrations/square/connect?access=write');
  check(writeTry.status >= 400 && writeTry.status < 500, 'asking Square for write permission is refused while booking changes are off', String(writeTry.status));

  // ---- e. Business identity, the read-only Postmark check, the review link and the automations. ----------------------
  log('Business identity');
  await openSettings(owner, 'branding');
  await owner.getByLabel('Business name').fill(BUSINESS.name);
  await submit(owner, () => owner.getByRole('button', { name: 'Save branding' }).click(), /^\/api\/settings$/, 'Settings saved');
  await openSettings(owner, 'business');
  const fields = { 'Street address': BUSINESS.street, Suburb: BUSINESS.suburb, State: BUSINESS.state, Postcode: BUSINESS.postcode, Country: BUSINESS.country, Phone: BUSINESS.phone, Email: BUSINESS.email };
  for (const [label, value] of Object.entries(fields)) await owner.getByLabel(label, { exact: true }).fill(value);
  await submit(owner, () => owner.getByRole('button', { name: 'Save business details' }).click(), /^\/api\/settings$/, 'Settings saved');
  await openSettings(owner, 'business');
  const savedValues = {};
  for (const label of Object.keys(fields)) savedValues[label] = await owner.getByLabel(label, { exact: true }).inputValue();
  check(Object.entries(fields).every(([k, v]) => savedValues[k] === v), 'the business address, phone and email are saved', JSON.stringify(savedValues));

  log('Read-only Postmark check');
  const pmBefore = (await fakeState()).postmark;
  await openSettings(owner, 'integrations');
  const emailCard = cardByTitle(owner, 'Email and Google rating');
  const checkClickedAt = Date.now();
  await submit(owner, () => emailCard.getByRole('button', { name: 'Check connection' }).click(), /^\/api\/email\/check$/, 'Checking Postmark');
  await waitFor('the Postmark check to finish', async () => {
    const s = (await apiJson(owner, 'GET', '/api/email/status')).json;
    return s?.lastCheckedAt && Date.parse(s.lastCheckedAt) >= checkClickedAt - 1000 && s.state === 'connected' ? s : null;
  });
  const pmAfter = (await fakeState()).postmark;
  check(pmAfter.counts.server > pmBefore.counts.server && pmAfter.counts.webhooks > pmBefore.counts.webhooks, 'the check read Postmark’s server, streams and webhooks', JSON.stringify(pmAfter.counts));
  check(pmAfter.counts.email === 0 && pmAfter.sends.length === 0, 'the check sent no email (the fake recorded zero sends)', JSON.stringify(pmAfter.counts));
  await openSettings(owner, 'integrations');
  const emailText = await textOf(cardByTitle(owner, 'Email and Google rating'));
  check(/Email \(Postmark\)/.test(emailText) && /Live/.test(emailText) && /Every email still waits for your approval or an automation you switched on/.test(emailText), 'the email card shows Postmark as live and says every email waits for approval', emailText.slice(0, 300));
  check(!/fake-postmark-token/.test(await owner.content()), 'the Postmark server token never reaches the browser');

  log('Review link');
  await owner.goto(`${BASE_URL}/reviews`);
  const linkCard = cardByTitle(owner, 'Review link');
  await linkCard.getByLabel('Your Google review link').fill('https://example.com/leave-us-a-review');
  expectError(/status of 400 .*\/api\/reviews\/link/, 'an invalid review link is refused (PUT /api/reviews/link → 400)');
  await linkCard.getByRole('button', { name: 'Save link' }).click();
  const linkRefusal = owner.getByRole('alert').filter({ hasText: 'Not saved' });
  await linkRefusal.waitFor({ timeout: 15_000 });
  check(/doesn.t look like a Google review link/.test(await textOf(linkRefusal)), 'a link that is not Google’s is refused with the reason', await textOf(linkRefusal));
  await owner.reload();
  check((await cardByTitle(owner, 'Review link').getByLabel('Your Google review link').inputValue()) === '' && (await cardByTitle(owner, 'Review link').getByText('Add your review link').count()) === 1, 'nothing was saved for the refused link');
  await cardByTitle(owner, 'Review link').getByLabel('Your Google review link').fill(REVIEW_LINK);
  await submit(owner, () => cardByTitle(owner, 'Review link').getByRole('button', { name: 'Save link' }).click(), /^\/api\/reviews\/link$/, 'Review link saved');
  await owner.reload();
  const linkAfter = cardByTitle(owner, 'Review link');
  check((await linkAfter.getByLabel('Your Google review link').inputValue()) === REVIEW_LINK && (await linkAfter.getByText('Link saved').count()) === 1, 'the Google review link is saved and shown as valid after a reload');
  const ratingText = await textOf(cardByTitle(owner, 'Google rating'));
  check(/add a Google Maps key/.test(ratingText) && !/\d\.\d|★/.test(ratingText), 'without a Google Maps key the rating card shows its setup state and no number', ratingText.slice(0, 200));

  log('Automations: sending window, follow-ups and review requests in "ask me to approve" mode');
  const automations = await openTab(owner, `${BASE_URL}/emails?tab=automations`, 'Automations');
  // The window covers the whole day so the run does not depend on the time it starts; the gate's window rule itself
  // is covered by the unit tests (packages/core email tests).
  await automations.getByLabel('Send from (Melbourne time)').fill('00:00');
  await automations.getByLabel('Send until').fill('23:59');
  await submit(owner, () => automations.getByRole('button', { name: 'Save settings' }).click(), /^\/api\/email\/settings$/, 'Saved');
  const followUp = cardByTitle(owner, 'Follow-up email');
  check((await followUp.getByLabel('Mode').inputValue()) === 'approve_each', 'the follow-up automation defaults to "Ask me to approve each one"');
  await submit(owner, () => followUp.getByRole('switch').click(), /^\/api\/email\/automations\/follow_up$/, 'Automation saved');
  await owner.goto(`${BASE_URL}/reviews`);
  const reviewAuto = cardByTitle(owner, 'Automatic requests');
  await reviewAuto.waitFor({ timeout: 30_000 });
  const ruleText = await textOf(reviewAuto);
  check(/Every client with a completed appointment and email permission gets the same request\. We never filter by how happy they seem/.test(ruleText), 'the review automation states that every client is asked the same way', ruleText.slice(0, 240));
  check((await reviewAuto.getByLabel('Mode').inputValue()) === 'approve_each', 'automatic review requests default to "Ask me to approve each one"');
  await submit(owner, () => reviewAuto.getByRole('switch').click(), /^\/api\/email\/automations\/review_request$/, 'Automation saved');
  await owner.reload();
  const autoAfter = cardByTitle(owner, 'Automatic requests');
  check((await autoAfter.getByRole('switch').getAttribute('aria-checked')) === 'true' && (await autoAfter.getByLabel('Mode').inputValue()) === 'approve_each', 'after a reload automatic review requests are on, asking for approval');
  const settingsRow = (await q("select data->'email'->'sendWindow' as w, data->'email'->'followUp'->>'enabled' as f from settings where id = 'default'"))[0];
  check(settingsRow?.w?.start === '00:00' && settingsRow?.w?.end === '23:59' && settingsRow?.f === 'true', 'the sending window and the follow-up switch were saved', JSON.stringify(settingsRow));

  // ---- b. A sandbox booking marked attended never counts as a visit. --------------------------------------------------
  log('Mark the past sandbox booking attended');
  const past = await openTab(owner, `${BASE_URL}/appointments`, 'Past');
  const sandyCard = bookingCard(past, 'Sandy Sandbox');
  await sandyCard.waitFor({ timeout: 30_000 });
  await submit(owner, () => sandyCard.getByRole('button', { name: 'Attended', exact: true }).click(), /\/attendance$/, 'Marked as attended');
  const pastAgain = await openTab(owner, `${BASE_URL}/appointments`, 'Past');
  const sandyAfter = await textOf(bookingCard(pastAgain, 'Sandy Sandbox'));
  check(new RegExp(`Attended — marked by ${OWNER_NAME}`).test(sandyAfter), 'after a reload the sandbox booking shows "Attended — marked by E2E Owner"', sandyAfter.slice(0, 200));
  const sbPast = (await q("select id, completion_source, completed_at from bookings where square_booking_id = 'SB_PAST'"))[0];
  check(sbPast.completion_source === 'none' && sbPast.completed_at === null, 'the sandbox booking is not recorded as a completed visit', JSON.stringify(sbPast));
  await runJob(q, 'email.automation.sweep');
  const created = (await q('select (select count(*)::int from review_requests where booking_id = $1) as r, (select count(*)::int from email_messages where booking_id = $1) as m', [sbPast.id]))[0];
  check(created.r === 0 && created.m === 0, 'the automation sweep created no follow-up and no review request for it', JSON.stringify(created));
  await owner.goto(`${BASE_URL}/reviews`);
  await owner.getByText('No review requests yet').waitFor({ timeout: 30_000 });
  check(true, 'Reviews shows no review request');
  const approveTab = await openTab(owner, `${BASE_URL}/emails?tab=approve`, /^To approve/);
  check(/Nothing waiting/.test(await textOf(approveTab)), 'Emails has nothing waiting for approval');

  // ---- c. Square webhooks: a signed one updates a booking from the fake, a forged one is refused. ---------------------
  log('Square webhooks');
  await control('/square/bookings/SB_TOMORROW', { status: 'CANCELLED_BY_CUSTOMER' });
  const readsBefore = (await fakeState()).square.bookingReads.length;
  const event = { merchant_id: 'MERCHANT_SANDBOX_1', type: 'booking.updated', event_id: 'e2e-event-booking-1', created_at: new Date().toISOString(), data: { type: 'booking', id: 'SB_TOMORROW', object: { booking: { id: 'SB_TOMORROW', status: 'CANCELLED_BY_CUSTOMER', customer_note: 'private note from the client' } } } };
  const body = JSON.stringify(event);
  const good = await postSquareWebhook(body, squareSignature(body));
  check(good.status === 200, 'a correctly signed Square webhook is accepted', `${good.status} ${JSON.stringify(good.json)}`);
  await waitFor('the booking to be updated from the fake', async () => (await q("select status from bookings where square_booking_id = 'SB_TOMORROW'"))[0]?.status === 'CANCELLED_BY_CUSTOMER', { timeoutMs: 60_000 });
  const readsAfter = (await fakeState()).square.bookingReads;
  check(readsAfter.length > readsBefore && readsAfter.at(-1) === '/v2/bookings/SB_TOMORROW', 'the worker re-read the booking from Square (the fake) instead of trusting the webhook body', readsAfter.slice(-2).join(', '));
  const stored = (await q("select payload from webhook_events where provider = 'square' and external_event_id = 'e2e-event-booking-1'"))[0];
  check(stored && !JSON.stringify(stored.payload).includes('private note') && stored.payload.data?.id === 'SB_TOMORROW', 'only the event envelope was stored, not the client’s data', JSON.stringify(stored?.payload));
  const upcomingAfter = await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  const tessUpdated = bookingCard(upcomingAfter, 'Tess Tester');
  await tessUpdated.waitFor({ timeout: 30_000 });
  check(/Cancelled by client/.test(await textOf(tessUpdated)), 'after a reload the booking shows "Cancelled by client"', (await textOf(tessUpdated)).slice(0, 200));
  const eventsBefore = (await q("select count(*)::int as n from webhook_events where provider = 'square'"))[0].n;
  const forgedBody = JSON.stringify({ ...event, event_id: 'e2e-event-forged', data: { type: 'booking', id: 'SB_PAST' } });
  const forged = await postSquareWebhook(forgedBody, squareSignature(body));
  const unsigned = await postSquareWebhook(forgedBody, 'bm90IGEgc2lnbmF0dXJl');
  const eventsAfter = (await q("select count(*)::int as n from webhook_events where provider = 'square'"))[0].n;
  check(forged.status === 401 && unsigned.status === 401, 'a webhook with a wrong signature is refused (401)', `${forged.status} / ${unsigned.status}`);
  check(eventsAfter === eventsBefore, 'nothing was stored for the refused webhooks', `${eventsBefore} → ${eventsAfter}`);

  // ---- k. Appointments at 390 px in the sandbox. ----------------------------------------------------------------------
  log('Appointments at 390 px (sandbox)');
  const phoneContext = await browser.newContext({ viewport: PHONE, storageState: await owner.context().storageState() });
  const phone = await phoneContext.newPage();
  watch(phone);
  await openTab(phone, `${BASE_URL}/appointments`, 'Upcoming');
  await phone.getByText('Sandbox — these are Square test bookings and test clients, not real ones.').waitFor();
  const o = await overflowAt(phone);
  check(o.scrollWidth <= o.clientWidth && o.offenders.length === 0, 'Appointments (sandbox) has no horizontal overflow at 390 px', JSON.stringify(o));
  await phoneContext.close();

  const writes = (await fakeState()).square.writes;
  check(writes.length === 0, 'the fake Square recorded no write call in the sandbox phase', JSON.stringify(writes));
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2: Square production (still the fake), review requests, unsubscribe, campaigns and Postmark webhooks
// ---------------------------------------------------------------------------------------------------------------

async function productionPhase({ browser, q, owner, staff, watch }) {
  const t = times();
  const pastStart = t.past;

  // ---- d. The switch to production asks for a reconnect; reconnecting purges the sandbox data. --------------------
  log('After the switch to production');
  await control('/square/scenario', productionScenario(t));
  await openSettings(owner, 'integrations');
  const card = cardByTitle(owner, 'Square Appointments');
  await card.getByRole('link', { name: 'Reconnect Square' }).waitFor({ timeout: 30_000 });
  const cardText = await textOf(card);
  check(/Reconnect needed/.test(cardText) && /Studio Assistant is now set to live Square\. Reconnect to load your real bookings; the test data will be removed\./.test(cardText), 'Square shows "Reconnect needed" with the reason after the switch to production', cardText.slice(0, 300));
  await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  const banner = await textOf(owner.locator('main'));
  check(/Sandbox — these are Square test bookings and test clients, not real ones\./.test(banner) && /May be out of date/.test(banner), 'Appointments still labels the old data as sandbox and says it may be out of date', banner.slice(0, 300));

  log('Reconnect to live Square');
  await openSettings(owner, 'integrations');
  await cardByTitle(owner, 'Square Appointments').getByRole('link', { name: 'Reconnect Square' }).click();
  await owner.waitForURL((u) => u.pathname === '/settings', { timeout: 30_000 });
  await cardByTitle(owner, 'Square Appointments').getByText(/Square is connected/).waitFor({ timeout: 30_000 });
  const purged = (await q("select (select count(*)::int from bookings where square_environment = 'sandbox') as b, (select count(*)::int from customers where email like '%sandbox%' or email like 'tess.tester%' or given_name in ('Sandy', 'Tess', 'Olly')) as c"))[0];
  check(purged.b === 0 && purged.c === 0, 'reconnecting removed the sandbox bookings and scrubbed the sandbox clients', JSON.stringify(purged));
  const locationSelect = owner.getByLabel('Choose your studio’s Square location');
  await waitFor('the location picker', async () => {
    if ((await locationSelect.count()) > 0) return true;
    await owner.reload();
    await owner.getByRole('tab', { selected: true }).waitFor();
    return false;
  }, { timeoutMs: 90_000, intervalMs: 3000 });
  const chosenAt = Date.now();
  await submit(owner, () => locationSelect.selectOption({ label: 'Ivanhoe' }), /^\/api\/integrations\/square$/, 'Location saved');
  const synced = await waitForSquareSync(owner, 'the first live sync', chosenAt);
  check(synced.dataEnvironment === 'production' && synced.liveMode === 'live', 'the connection is now live Square', `${synced.dataEnvironment} / ${synced.liveMode}`);
  const upcoming = await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  const caseyCard = bookingCard(upcoming, fullName(LIVE.casey));
  await caseyCard.waitFor({ timeout: 30_000 });
  const mainText = await textOf(owner.locator('main'));
  check(/11:00 am – 11:45 am/.test(await textOf(caseyCard)), 'the live booking shows 11:00 am – 11:45 am Melbourne time', (await textOf(caseyCard)).slice(0, 120));
  check(!/Sandbox/.test(mainText) && /Live Square/.test(mainText), 'live bookings appear without the sandbox label ("Live Square")', mainText.slice(0, 200));
  const clients = await openTab(owner, `${BASE_URL}/appointments`, 'Clients');
  await clients.getByText(fullName(LIVE.riley), { exact: true }).waitFor({ timeout: 30_000 });
  check(!/Sandy Sandbox|Tess Tester/.test(await textOf(clients)), 'no sandbox client is listed any more');

  // ---- e. Email permission recorded at the counter. --------------------------------------------------------------
  log('Record email permission');
  async function recordConsent(page, client, asStaff) {
    const list = await openTab(page, `${BASE_URL}/emails?tab=clients`, 'Clients');
    await list.getByRole('button', { name: new RegExp(fullName(client)) }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Record permission' }).click();
    await dialog.getByLabel('How is permission given?').selectOption('in_person_device');
    const wording = await textOf(dialog.locator('blockquote'));
    await dialog.getByRole('checkbox', { name: `Yes (${fullName(client)})` }).check();
    await submit(page, () => dialog.getByRole('button', { name: 'Save', exact: true }).click(), /\/consent$/, 'Permission recorded');
    await page.keyboard.press('Escape');
    return { wording, asStaff };
  }
  const staffConsent = await recordConsent(staff, LIVE.riley, true);
  check(new RegExp(`Yes, I'd like emails from ${BUSINESS.name}`).test(staffConsent.wording) && /unsubscribe at any time/.test(staffConsent.wording), 'the barber recorded Riley’s permission at the counter with the consent wording shown to the client', staffConsent.wording.slice(0, 160));
  for (const c of [LIVE.casey, LIVE.morgan, LIVE.jordan]) await recordConsent(owner, c, false);
  const list = await openTab(owner, `${BASE_URL}/emails?tab=clients`, 'Clients');
  const rowOf = (c) => list.locator('li', { has: owner.getByText(fullName(c), { exact: true }) });
  await rowOf(LIVE.riley).waitFor();
  const permissions = {};
  for (const [k, c] of Object.entries(LIVE)) permissions[k] = await textOf(rowOf(c));
  check(['riley', 'casey', 'morgan', 'jordan'].every((k) => /Permission recorded/.test(permissions[k])) && /No permission/.test(permissions.noah), 'Emails → Clients shows permission for the four who gave it and "No permission" for Noah', JSON.stringify(permissions));
  const ledger = (await q("select email_lower, method, basis from consent_events where kind = 'granted' order by occurred_at"))[0];
  check(ledger?.email_lower === LIVE.riley.email && ledger.method === 'in_person_device', 'the ledger kept the permission with how it was given', JSON.stringify(ledger));

  // ---- f. A completed live booking → review request waiting for approval → one send with the footer. --------------
  log('Complete the live booking');
  const confirm = await openTab(owner, `${BASE_URL}/appointments`, 'Past');
  const rileyCard = bookingCard(confirm, fullName(LIVE.riley));
  await rileyCard.waitFor({ timeout: 30_000 });
  check(timeLabel(pastStart) && (await textOf(rileyCard)).includes(timeLabel(pastStart)), 'the past live booking shows its Melbourne start time', (await textOf(rileyCard)).slice(0, 100));
  await submit(owner, () => rileyCard.getByRole('button', { name: 'Attended', exact: true }).click(), /\/attendance$/, 'Marked as attended');
  const liveBooking = (await q("select id, completion_source from bookings where square_booking_id = 'LIVE_PAST'"))[0];
  check(liveBooking.completion_source === 'owner_marked', 'the owner’s mark on a live booking counts as a completed visit', liveBooking.completion_source);
  await runJob(q, 'email.automation.sweep');
  await owner.goto(`${BASE_URL}/reviews`);
  const requestRow = owner.locator('li', { has: owner.getByText(fullName(LIVE.riley), { exact: true }) }).filter({ has: owner.getByRole('button', { name: 'Open' }) });
  await requestRow.waitFor({ timeout: 30_000 });
  check(/Waiting for approval/.test(await textOf(requestRow)), 'Reviews lists the review request for Riley as "Waiting for approval"', await textOf(requestRow));
  check((await fakeState()).postmark.counts.email === 0, 'nothing was sent before the owner approved');
  const approveTab = await openTab(owner, `${BASE_URL}/emails?tab=approve`, /^To approve/);
  const followUpRow = approveTab.locator('li', { hasText: fullName(LIVE.riley) });
  check((await followUpRow.count()) === 1, 'Emails → To approve holds the follow-up email for the same visit, waiting for approval', (await textOf(approveTab)).slice(0, 200));
  const appt = await openTab(owner, `${BASE_URL}/appointments`, 'Past');
  check(/Review request/i.test(await textOf(bookingCard(appt, fullName(LIVE.riley)))), 'the booking shows its review request badge', (await textOf(bookingCard(appt, fullName(LIVE.riley)))).slice(0, 200));

  log('Approve the review request');
  await owner.goto(`${BASE_URL}/reviews`);
  await owner.locator('li', { has: owner.getByText(fullName(LIVE.riley), { exact: true }) }).getByRole('button', { name: 'Open' }).click();
  const msgDialog = owner.getByRole('dialog');
  const approve = msgDialog.getByRole('button', { name: 'Approve and send' });
  await approve.waitFor({ timeout: 30_000 });
  await waitFor('Approve to be enabled', () => approve.isEnabled(), { timeoutMs: 15_000, intervalMs: 250 });
  await submit(owner, () => approve.click(), /\/approve$/, 'Approved');
  const sent = await waitFor('the review request to reach the fake Postmark', async () => {
    const s = (await fakeState()).postmark.sends.filter((x) => x.to === LIVE.riley.email);
    return s.length ? s : null;
  }, { timeoutMs: 60_000 });
  const msg = (await q("select id, status from email_messages where purpose = 'review_request' and to_email = $1", [LIVE.riley.email]))[0];
  await waitFor('the message to be marked sent', async () => (await q('select status from email_messages where id = $1', [msg.id]))[0].status === 'sent');
  const send = sent[0];
  check(sent.length === 1, 'the fake Postmark received exactly one email for Riley', String(sent.length));
  const footer = [BUSINESS.name, `${BUSINESS.street}, ${BUSINESS.suburb} ${BUSINESS.state} ${BUSINESS.postcode}`, `${BUSINESS.phone} · ${BUSINESS.email}`];
  check(footer.every((line) => send.text.includes(line)) && footer.every((line) => send.html.includes(line.replace(/&/g, '&amp;'))), 'the email carries the sender identification footer (name, address, phone and email)', send.text.slice(-400));
  const unsubscribeUrl = (send.text.match(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/u/[A-Za-z0-9_-]+`)) ?? [])[0];
  const reviewUrl = (send.text.match(new RegExp(`${BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/r/[A-Za-z0-9_-]+`)) ?? [])[0];
  check(Boolean(unsubscribeUrl) && send.stream === 'broadcast', 'it is sent on the Broadcast stream with an unsubscribe link to this app', `${send.stream} ${unsubscribeUrl}`);
  check(Boolean(reviewUrl) && !send.text.includes(REVIEW_LINK) && !GATING_WORDS.test(`${send.subject} ${send.text}`), 'the review link goes through the app’s redirect and the wording offers nothing in return', `${reviewUrl} | ${send.subject}`);
  await owner.goto(`${BASE_URL}/reviews`);
  const rowAfter = owner.locator('li', { has: owner.getByText(fullName(LIVE.riley), { exact: true }) }).filter({ has: owner.getByRole('button', { name: 'Open' }) });
  await rowAfter.waitFor();
  check(/\bSent\b/.test(await textOf(rowAfter)), 'after a reload Reviews shows the request as Sent', await textOf(rowAfter));
  const sentTab = await openTab(owner, `${BASE_URL}/emails?tab=sent`, 'Sent');
  check(/Review request/.test(await textOf(sentTab.locator('li', { hasText: fullName(LIVE.riley) }))), 'Emails → Sent lists the review request');
  log('Run the send and the dispatch again');
  await runJob(q, 'email.send', { emailMessageId: msg.id });
  await runJob(q, 'email.dispatch');
  const again = (await fakeState()).postmark.sends.filter((x) => x.to === LIVE.riley.email);
  check(again.length === 1, 'running the send and the dispatch again sends nothing more', String(again.length));

  // ---- g. Unsubscribe page. ----------------------------------------------------------------------------------------
  log('Unsubscribe from the email link');
  const clientContext = await browser.newContext({ viewport: PHONE });
  const client = await clientContext.newPage();
  watch(client);
  await client.goto(unsubscribeUrl);
  await client.getByRole('heading', { name: 'Unsubscribe' }).waitFor({ timeout: 30_000 });
  await client.reload();
  await client.getByRole('heading', { name: 'Unsubscribe' }).waitFor({ timeout: 30_000 });
  const before = await textOf(client.locator('main'));
  check(/Unsubscribe r•••@example\.com from marketing emails from Ivanhoe Test Barbers\?/.test(before) && !/You.re unsubscribed/.test(before), 'opening and reloading the link only asks; it does not claim the client is unsubscribed', before.slice(0, 200));
  check((await q("select count(*)::int as n from consent_events where kind = 'withdrawn' and email_lower = $1", [LIVE.riley.email]))[0].n === 0, 'viewing the page recorded nothing');
  await client.getByRole('button', { name: 'Unsubscribe' }).click();
  await client.getByRole('heading', { name: 'You’re unsubscribed' }).waitFor({ timeout: 30_000 });
  check(/Done\. You won't get marketing emails from Ivanhoe Test Barbers any more\./.test(await textOf(client.locator('main'))), 'the page confirms the unsubscribe');
  await client.reload();
  check((await client.getByRole('heading', { name: 'You’re unsubscribed' }).count()) === 1, 'reloading still shows the recorded unsubscribe');
  await clientContext.close();
  const clientsAfter = await openTab(owner, `${BASE_URL}/emails?tab=clients`, 'Clients');
  check(/Unsubscribed/.test(await textOf(clientsAfter.locator('li', { has: owner.getByText(fullName(LIVE.riley), { exact: true }) }))), 'Emails → Clients shows Riley as Unsubscribed');

  // ---- h. Campaign: approve for consenting clients, pause, resume, auto-pause on a complaint, cancel. ----------------
  log('Campaign');
  const campaigns = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  await campaigns.getByRole('button', { name: 'New campaign' }).click();
  const wizard = owner.getByRole('dialog');
  await wizard.getByLabel('Campaign name (only you see it)').fill('Spring hours');
  await wizard.getByLabel('Subject').fill('New spring opening hours');
  await wizard.getByLabel('Email', { exact: true }).fill('Hi {{first_name}},\n\nFrom next week we open at 8 am on Saturdays.\n\nSee you soon.');
  const toRecipients = wizard.getByRole('button', { name: 'Save and see recipients' });
  await waitFor('the campaign text to pass the checks', () => toRecipients.isEnabled(), { timeoutMs: 15_000, intervalMs: 250 });
  await toRecipients.click();
  await wizard.getByText(/will receive this/).waitFor({ timeout: 30_000 });
  const audience = await textOf(wizard);
  check(/3 will receive this · \d+ left out/.test(audience), 'only the three consenting, subscribed clients are included', audience.slice(0, 300));
  const rowIn = (c) => wizard.locator('li', { hasText: fullName(c) });
  check(/Included/.test(await textOf(rowIn(LIVE.casey))) && !/Included/.test(await textOf(rowIn(LIVE.riley))) && !/Included/.test(await textOf(rowIn(LIVE.noah))), 'Riley (unsubscribed) and Noah (no permission) are left out', `${await textOf(rowIn(LIVE.riley))} | ${await textOf(rowIn(LIVE.noah))}`);
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await wizard.getByRole('checkbox', { name: 'These clients agreed to receive marketing emails from us.' }).check();
  await control('/postmark/hold', { hold: true });
  await submit(owner, () => wizard.getByRole('button', { name: 'Approve campaign' }).click(), /\/approve$/, 'Campaign approved');
  const campaignId = (await q("select id from email_campaigns where name = 'Spring hours'"))[0].id;
  const campaignSends = async () => (await fakeState()).postmark.sends.filter((s) => s.metadata.campaignId === campaignId);
  // The approval expands the campaign into one message per recipient; the dispatch (normally every minute) hands them on.
  await waitFor('the campaign to be expanded', async () => (await q("select count(*)::int as n from email_messages where campaign_id = $1 and status = 'approved'", [campaignId]))[0].n === 3);
  await runJob(q, 'email.dispatch');
  const firstHeld = await waitFor('the first campaign email to be in flight', async () => {
    const st = (await fakeState()).postmark;
    return st.held.length ? st.held : null;
  }, { timeoutMs: 90_000 });
  check(firstHeld.length === 1, 'one campaign email is in flight at a time', firstHeld.join(', '));
  const camp = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  const campRow = camp.locator('li', { hasText: 'Spring hours' });
  await campRow.getByRole('button', { name: 'Pause' }).click();
  await campRow.getByText('Paused', { exact: true }).waitFor({ timeout: 15_000 });
  await control('/postmark/release', {});
  await waitFor('the in-flight email to be accepted', async () => ((await campaignSends()).length === 1 ? true : null));
  // Settle: every queued send for this campaign has run (and stood down), then one more dispatch.
  const settle = async () => {
    await waitFor('the campaign’s queued sends to settle', async () => (await q("select count(*)::int as n from jobs j join email_messages m on m.id = j.ref_id where j.type = 'email.send' and m.campaign_id = $1 and j.status in ('queued', 'running')", [campaignId]))[0].n === 0, { timeoutMs: 60_000 });
    await runJob(q, 'email.dispatch');
  };
  await settle();
  const pausedState = (await fakeState()).postmark;
  check((await campaignSends()).length === 1 && pausedState.held.length === 0, 'after the pause no further campaign email went out (the fake’s count stays at one)', `${(await campaignSends()).length} sent, ${pausedState.held.length} waiting`);
  const camp2 = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  check(/Paused/.test(await textOf(camp2.locator('li', { hasText: 'Spring hours' }))) && /1 of 3 sent/.test(await textOf(camp2.locator('li', { hasText: 'Spring hours' }))), 'after a reload the campaign shows Paused, 1 of 3 sent', await textOf(camp2.locator('li', { hasText: 'Spring hours' })));
  check(!(await fakeState()).postmark.sends.some((s) => s.metadata.campaignId === campaignId && [LIVE.riley.email, LIVE.noah.email].includes(s.to)), 'nothing from the campaign went to Riley (unsubscribed) or Noah (no permission)');

  // ---- i. Postmark webhooks: a spam complaint suppresses the address and pauses the campaign. ----------------------
  log('Resume, then a spam complaint pauses the campaign');
  await camp2.locator('li', { hasText: 'Spring hours' }).getByRole('button', { name: 'Resume' }).click();
  await camp2.locator('li', { hasText: 'Spring hours' }).getByText('Sending', { exact: true }).waitFor({ timeout: 15_000 });
  await waitFor('the paused messages to be ready again', async () => (await q("select count(*)::int as n from email_messages where campaign_id = $1 and status = 'approved'", [campaignId]))[0].n === 2);
  await runJob(q, 'email.dispatch');
  await waitFor('the second campaign email to be in flight', async () => ((await fakeState()).postmark.held.length ? true : null), { timeoutMs: 90_000 });
  const first = (await campaignSends())[0];
  const complaint = { RecordType: 'SpamComplaint', ID: 4201, Type: 'SpamComplaint', TypeCode: 512, Name: 'Spam complaint', Tag: 'campaign', MessageID: first.messageId, ServerID: 1, MessageStream: 'broadcast', Email: first.to, From: BUSINESS.email, BouncedAt: new Date().toISOString(), Inactive: true, CanActivate: false, Subject: first.subject };
  const hooksBefore = (await q("select count(*)::int as n from webhook_events where provider = 'postmark'"))[0].n;
  const wrong = await postPostmarkWebhook({ ...complaint, ID: 4299 }, { user: HOOK_USER, password: `${HOOK_PASSWORD}x` });
  const none = await postPostmarkWebhook({ ...complaint, ID: 4298 }, null);
  const hooksMid = (await q("select count(*)::int as n from webhook_events where provider = 'postmark'"))[0].n;
  check(wrong.status === 401 && none.status === 401, 'Postmark webhooks with wrong or missing credentials get 401', `${wrong.status} / ${none.status}`);
  check(hooksMid === hooksBefore && (await q('select count(*)::int as n from email_suppressions where email_lower = $1', [first.to]))[0].n === 0, 'nothing was stored for them');
  const right = await postPostmarkWebhook(complaint, { user: HOOK_USER, password: HOOK_PASSWORD });
  check(right.status === 200, 'the complaint with the right Basic credentials is accepted', `${right.status} ${JSON.stringify(right.json)}`);
  await waitFor('the campaign to pause itself', async () => (await q('select status from email_campaigns where id = $1', [campaignId]))[0].status === 'paused', { timeoutMs: 60_000 });
  await control('/postmark/release', {});
  await control('/postmark/hold', { hold: false });
  await waitFor('the in-flight email to be accepted', async () => ((await campaignSends()).length === 2 ? true : null));
  await settle();
  check((await campaignSends()).length === 2 && (await fakeState()).postmark.held.length === 0, 'after the automatic pause nothing more went out (the email already in flight was the last)', String((await campaignSends()).length));
  const camp3 = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  const row3 = await textOf(camp3.locator('li', { hasText: 'Spring hours' }));
  check(/Paused automatically: 1 spam complaint out of 1 sent\. Check the list before resuming\./.test(row3) && /1 complaints?/.test(row3), 'the campaign shows that it paused itself on the complaint', row3);
  const suppression = (await q('select scope, reason, source from email_suppressions where email_lower = $1', [first.to]))[0];
  check(suppression?.scope === 'all' && suppression.reason === 'spam_complaint' && suppression.source === 'postmark_webhook', 'the complaint suppressed the address for all email', JSON.stringify(suppression));
  const complainer = Object.values(LIVE).find((c) => c.email === first.to);
  const clientsNow = await openTab(owner, `${BASE_URL}/emails?tab=clients`, 'Clients');
  check(/Bounced or spam/.test(await textOf(clientsNow.locator('li', { has: owner.getByText(fullName(complainer), { exact: true }) }))), `Emails → Clients shows ${fullName(complainer)} as "Bounced or spam"`);

  log('A hard bounce');
  const second = (await campaignSends())[1];
  const bounce = { RecordType: 'Bounce', ID: 4301, Type: 'HardBounce', TypeCode: 1, Name: 'Hard bounce', Tag: 'campaign', MessageID: second.messageId, ServerID: 1, MessageStream: 'broadcast', Description: 'The server was unable to deliver your message.', Details: 'e2e', Email: second.to, From: BUSINESS.email, BouncedAt: new Date().toISOString(), DumpAvailable: false, Inactive: true, CanActivate: true, Subject: second.subject };
  check((await postPostmarkWebhook(bounce, { user: HOOK_USER, password: HOOK_PASSWORD })).status === 200, 'a hard bounce with the right credentials is accepted');
  const bounced = await waitFor('the bounce suppression', async () => (await q("select scope, reason from email_suppressions where email_lower = $1 and reason = 'hard_bounce'", [second.to]))[0] ?? null);
  check(bounced.scope === 'all', 'the hard bounce suppressed the address for all email', JSON.stringify(bounced));

  log('Cancel the campaign');
  const camp4 = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  await camp4.locator('li', { hasText: 'Spring hours' }).getByRole('button', { name: 'Cancel remaining' }).click();
  await camp4.locator('li', { hasText: 'Spring hours' }).getByText('Cancelled', { exact: true }).waitFor({ timeout: 15_000 });
  await settle();
  const leftover = (await q("select count(*)::int as n from email_messages where campaign_id = $1 and status in ('draft', 'approved', 'queued', 'sending')", [campaignId]))[0].n;
  check(leftover === 0 && (await campaignSends()).length === 2, 'cancelling leaves nothing to send and the fake’s count stays at two', `${leftover} pending, ${(await campaignSends()).length} sent`);
  const camp5 = await openTab(owner, `${BASE_URL}/emails?tab=campaigns`, 'Campaigns');
  check(/Cancelled/.test(await textOf(camp5.locator('li', { hasText: 'Spring hours' }))), 'after a reload the campaign shows Cancelled');
  const allSends = (await fakeState()).postmark.sends;
  check(allSends.filter((s) => s.to === LIVE.riley.email).length === 1 && !allSends.some((s) => s.to === LIVE.noah.email), 'over the whole run Riley got only the review request and Noah got nothing', allSends.map((s) => s.to).join(', '));

  // ---- j. Booking changes stay off on live Square too. -------------------------------------------------------------
  log('Booking changes are still off');
  await openTab(owner, `${BASE_URL}/appointments`, 'Upcoming');
  check((await owner.getByRole('button', { name: 'New booking' }).count()) === 0, 'live Appointments offers no "New booking"');
  await bookingCard(owner.getByRole('tabpanel'), fullName(LIVE.casey)).getByRole('button').first().click();
  const dlg = owner.getByRole('dialog');
  await dlg.getByText('Square’s status').waitFor({ timeout: 15_000 });
  check(!/\bMove\b|Cancel booking/.test(await textOf(dlg)), 'a live booking offers no Move or Cancel');
  await owner.keyboard.press('Escape');
  const liveTomorrow = (await q("select id from bookings where square_booking_id = 'LIVE_TOMORROW'"))[0];
  const refused = await apiJson(owner, 'POST', '/api/appointments/changes', { kind: 'cancel', bookingId: liveTomorrow.id, expectedVersion: 0 });
  check(refused.status >= 400 && refused.status < 500 && refused.json?.error?.message === 'Booking changes from Studio Assistant aren’t available yet. Make changes in Square.', 'POST /api/appointments/changes is refused on live Square too', `${refused.status}: ${refused.json?.error?.message}`);
  const writes = (await fakeState()).square.writes;
  check(writes.length === 0, 'the fake Square recorded zero write calls over the whole run', JSON.stringify(writes));

  // ---- k. 390 px. ---------------------------------------------------------------------------------------------------
  log('Layouts at 390 px');
  const phoneContext = await browser.newContext({ viewport: PHONE, storageState: await owner.context().storageState() });
  const phone = await phoneContext.newPage();
  watch(phone);
  for (const [name, url, tab] of [
    ['Appointments', `${BASE_URL}/appointments`, 'Upcoming'],
    ['Appointments → Past', `${BASE_URL}/appointments`, 'Past'],
    ['Emails → To approve', `${BASE_URL}/emails?tab=approve`, /^To approve/],
    ['Emails → Sent', `${BASE_URL}/emails?tab=sent`, 'Sent'],
    ['Emails → Campaigns', `${BASE_URL}/emails?tab=campaigns`, 'Campaigns'],
    ['Emails → Clients', `${BASE_URL}/emails?tab=clients`, 'Clients'],
    ['Emails → Automations', `${BASE_URL}/emails?tab=automations`, 'Automations'],
    ['Reviews', `${BASE_URL}/reviews`, /^Requests/],
  ]) {
    await openTab(phone, url, tab);
    await phone.waitForLoadState('networkidle');
    const o = await overflowAt(phone);
    check(o.scrollWidth <= o.clientWidth && o.offenders.length === 0, `${name} has no horizontal overflow at 390 px`, JSON.stringify(o));
  }
  await phoneContext.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (!CONTROL_URL || !DATABASE_URL || !SQUARE_KEY || !HOOK_PASSWORD) throw new Error('E2E_FAKE_CONTROL_URL, E2E_DATABASE_URL, E2E_SQUARE_SIGNATURE_KEY and E2E_POSTMARK_WEBHOOK_PASSWORD are required (run apps/web/e2e/run-stage-c-bookings.sh).');
  const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`The web app at ${BASE_URL} is not healthy (${JSON.stringify(health)}). Start it and the worker first.`);
  await fakeState();

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (text, params = []) => (await db.query(text, params)).rows;

  const launched = await chromium.launch();
  // Every context gets a 30 s default timeout, so a locator that never matches fails the run instead of hanging it.
  const browser = {
    newContext: async (options) => {
      const c = await launched.newContext(options);
      c.setDefaultTimeout(30_000);
      return c;
    },
    close: () => launched.close(),
  };
  const consoleErrors = carried?.consoleErrors ?? [];
  const expectedErrors = (carried?.expectedErrors ?? []).map((x) => ({ ...x, pattern: new RegExp(x.source, x.flags) }));
  const expectError = (pattern, why) => {
    if (!expectedErrors.some((x) => x.why === why)) expectedErrors.push({ pattern, source: pattern.source, flags: pattern.flags, why, seen: 0 });
  };
  const watch = (p) => {
    p.on('pageerror', (err) => consoleErrors.push({ phase: PHASE, text: `pageerror: ${err.message}`, url: '' }));
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ phase: PHASE, text: `console: ${msg.text()}`, url: msg.location()?.url ?? '' });
    });
  };
  let owner;
  let stoppedEarly = false;
  try {
    if (PHASE === 'sandbox') {
      log('First-run setup');
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
      await execFileAsync('node', ['--conditions=react-server', '--import', 'tsx', path.join(HERE, 'add-staff-user.ts'), STAFF_EMAIL, STAFF_NAME], { env: { ...process.env, DATABASE_URL, STAFF_PASSWORD }, cwd: path.join(REPO_ROOT, 'apps', 'web') });
    }
    const ownerContext = await browser.newContext({ viewport: DESKTOP });
    owner = await signIn(ownerContext, OWNER_EMAIL, OWNER_PASSWORD);
    watch(owner);
    const staffContext = await browser.newContext({ viewport: DESKTOP });
    const staff = await signIn(staffContext, STAFF_EMAIL, STAFF_PASSWORD);
    watch(staff);
    check(true, `owner and barber signed in (${PHASE})`);

    if (PHASE === 'sandbox') await sandboxPhase({ browser, q, owner, staff, expectError, watch });
    else await productionPhase({ browser, q, owner, staff, watch });
    await ownerContext.close();
    await staffContext.close();
  } catch (err) {
    stoppedEarly = true;
    failures.push(`[${PHASE}] stopped early: ${err instanceof Error ? err.message : String(err)}`);
    log(`STOPPED: ${err instanceof Error ? err.stack : String(err)}`);
    if (owner) await failureScreenshot(owner, 'stopped');
  } finally {
    await browser.close();
    await db.end();
  }

  const elapsedMs = elapsedBefore + (Date.now() - started);
  if (PHASE === 'sandbox' && !stoppedEarly) {
    writeFileSync(STATE_FILE, JSON.stringify({ passes, failures, consoleErrors, expectedErrors: expectedErrors.map(({ pattern: _p, ...x }) => x), elapsedMs }));
    console.log(`Sandbox phase: ${passes.length} checks passed, ${failures.length} failed so far; continuing with the production phase.`);
    process.exit(0);
  }

  // ---- k. Console (both phases). ----------------------------------------------------------------------------------
  const unexpected = consoleErrors.filter((e) => {
    const match = expectedErrors.find((x) => x.pattern.test(`${e.text} ${e.url}`));
    if (match) match.seen++;
    return !match;
  });
  if (!stoppedEarly) {
    check(unexpected.length === 0, 'no unexpected page errors or console errors in either phase', unexpected.slice(0, 5).map((e) => `[${e.phase}] ${e.text} ${e.url}`).join(' | '));
    for (const x of expectedErrors) check(x.seen >= 1, `the deliberate error appeared: ${x.why}`, `${x.seen} seen`);
  }

  console.log('');
  console.log(`${passes.length} checks passed, ${failures.length} failed in ${(elapsedMs / 1000).toFixed(0)} s`);
  for (const f of failures) console.log(`  - ${f}`);
  if (expectedErrors.length) {
    console.log('Console errors caused on purpose:');
    for (const x of expectedErrors) console.log(`  ${x.why} (${x.seen} seen)`);
  }
  if (consoleErrors.length) {
    console.log('Browser console errors seen:');
    for (const e of consoleErrors.slice(0, 20)) console.log(`  [${e.phase}] ${e.text} ${e.url}`);
  }
  process.exit(failures.length ? 1 : 0);
}

await main();
