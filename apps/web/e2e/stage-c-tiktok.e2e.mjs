#!/usr/bin/env node
/**
 * Stage C end-to-end check in a real browser (Chromium through Playwright) for automatic TikTok posting through Zernio
 * (WP10, docs/design/publishing.md §7.2), against WP10's own local fake of Zernio run as a separate process
 * (apps/web/e2e/fake-zernio.ts over apps/worker/test/fakes/zernio-server.ts). It drives the running web app and worker
 * the way the owner would and checks real outcomes in the app. The database is read only where the UI cannot show
 * something (what was stored for a webhook, the encrypted key, the bound consent, job runs); the fake is read and
 * steered through its control port. Nothing is ever sent to the real Zernio.
 *
 * Three phases, run by `bash apps/web/e2e/run-stage-c-tiktok.sh` with a restart of the web app and the worker between
 * them (the fake keeps running):
 *   setup   TIKTOK_PUBLISH_PROVIDER=zernio without ZERNIO_API_BASE_URL: owner account, the honest "needs setup"
 *           state, the key is refused, and the fake hears nothing.
 *   on      ZERNIO_API_BASE_URL → the fake, ZERNIO_WEBHOOK_SECRET set: a refused key shows "needs a new key"; the real
 *           key is shown only as its last four characters (never in any response); the TikTok account the fake lists
 *           is chosen; "Publish via Zernio" is offered as a first verification post; approval is refused without the
 *           consent tick and the three interaction choices (UI and API); the worker uploads to the fake (no
 *           Authorization on the PUT) and creates exactly one post with both consent flags, PUBLIC_TO_EVERYONE and the
 *           owner's choices; processing → published only when the fake says so → the link only once the fake has it;
 *           signed webhooks trigger reads while forged/unsigned ones change nothing and cannot take a real event's id;
 *           a draft ends as "finish in the TikTok app", never published; a failed post's Retry calls /retry (no second
 *           create).
 *   off     TIKTOK_PUBLISH_PROVIDER=none (ZERNIO_API_BASE_URL still set): nothing about Zernio is shown except the
 *           integrations checklist line, the webhook route and key route refuse, queued Zernio reads do nothing, and
 *           the fake records zero requests.
 * Each later phase loads the earlier phases' results from E2E_STATE_FILE; the last prints the total.
 *
 * Settings (environment variables): E2E_PHASE (setup | on | off), E2E_BASE_URL, E2E_FAKE_CONTROL_URL,
 * E2E_FAKE_ZERNIO_URL, E2E_DATABASE_URL, E2E_STATE_FILE, E2E_OUT_DIR, E2E_ZERNIO_WEBHOOK_SECRET, E2E_SAMPLES_DIR,
 * E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD.
 *
 * Exit code 0 when every check passed, 1 otherwise. Plain node + playwright + pg; no test runner.
 */
import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
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
const PHASE = process.env.E2E_PHASE ?? 'setup';
const PHASES = ['setup', 'on', 'off'];
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:4300').replace(/\/$/, '');
const CONTROL_URL = (process.env.E2E_FAKE_CONTROL_URL ?? '').replace(/\/$/, '');
const FAKE_ZERNIO_URL = (process.env.E2E_FAKE_ZERNIO_URL ?? '').replace(/\/$/, '');
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const WEBHOOK_SECRET = process.env.E2E_ZERNIO_WEBHOOK_SECRET ?? '';
const OUT_DIR = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'studio-e2e-c-tiktok');
const STATE_FILE = process.env.E2E_STATE_FILE ?? path.join(OUT_DIR, 'phase-state.json');
const SAMPLES = process.env.E2E_SAMPLES_DIR ?? path.join(REPO_ROOT, 'data', 'samples');
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@example.com';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'clipper guard number two';
const OWNER_NAME = 'E2E Owner';
const TSX = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'tsx');
const DESKTOP = { width: 1600, height: 1000 };
const TARGET_SEC = 12;
const PROJECT_TITLE = 'E2E TikTok';
const CLIPS = [
  { file: 'sample_a_portrait_sdr.mp4', tag: 'Cutting' },
  { file: 'sample_b_rotated_hevc_hlg.mov', tag: 'Before' },
  { file: 'sample_c_noaudio_scenes.mp4', tag: 'Result' },
];

// The fake's own dummy key and account id, read from the fake itself so there is one source.
const FAKE_SOURCE = readFileSync(path.join(REPO_ROOT, 'apps', 'worker', 'test', 'fakes', 'zernio-server.ts'), 'utf8');
const FAKE_KEY = /FAKE_ZERNIO_KEY = '([^']+)'/.exec(FAKE_SOURCE)?.[1] ?? '';
const FAKE_ACCOUNT_ID = /FAKE_TIKTOK_ACCOUNT_ID = '([^']+)'/.exec(FAKE_SOURCE)?.[1] ?? '';
const WRONG_KEY = 'sk_e2e_not_the_right_key_000000000000000000000000000000000000000wxyz';
const HANDLE = '@ivanhoe_studio_test';
const TIKTOK_URL_A = 'https://www.tiktok.com/@ivanhoe_studio_test/video/7311111111111111111';
const TIKTOK_URL_C = 'https://www.tiktok.com/@ivanhoe_studio_test/video/7322222222222222222';

// ---------------------------------------------------------------------------------------------------------------
// Results, carried from one phase into the next
// ---------------------------------------------------------------------------------------------------------------

if (!PHASES.includes(PHASE)) {
  console.error(`E2E_PHASE must be one of ${PHASES.join(', ')}.`);
  process.exit(2);
}
const carried = PHASE !== 'setup' && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
if (PHASE !== 'setup' && !carried) {
  console.error(`Phase ${PHASE} needs the earlier phases' results in ${STATE_FILE}.`);
  process.exit(2);
}
const passes = carried?.passes ?? [];
const failures = carried?.failures ?? [];
/** Facts one phase hands to the next (version ids, post ids). */
const facts = carried?.facts ?? {};
const started = Date.now();
const elapsedBefore = carried?.elapsedMs ?? 0;

function log(message) {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[${PHASE.padEnd(5)} ${t}s] ${message}`);
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

/**
 * A load the browser itself cancelled: a video or download link (signed /api/media/… URL) that was replaced or left,
 * or a Next.js route prefetch (`?_rsc=`) cut short by navigating. Any other failed load counts as an error.
 */
function abortedLoadWeIgnore(e) {
  if (!/Failed to load resource: net::ERR_(ABORTED|FAILED)/.test(e.text)) return false;
  let u;
  try {
    u = new URL(e.url);
  } catch {
    return false;
  }
  return u.origin === new URL(BASE_URL).origin && (u.pathname.startsWith('/api/media/') || u.searchParams.has('_rsc'));
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

/** Visible text of a locator with whitespace collapsed. */
async function textOf(locator) {
  return ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();
}

/** A same-origin API call with the signed-in session of `page` (the Origin header passes the CSRF check). */
async function apiJson(page, method, urlPath, body) {
  const res = await page.request.fetch(`${BASE_URL}${urlPath}`, { method, headers: { origin: BASE_URL, 'content-type': 'application/json' }, ...(body === undefined ? {} : { data: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status(), json, text };
}

async function apiGet(page, urlPath) {
  const r = await apiJson(page, 'GET', urlPath);
  if (r.status !== 200) throw new Error(`${urlPath} answered ${r.status}`);
  return r.json;
}

async function control(method, urlPath, body) {
  const res = await fetch(`${CONTROL_URL}${urlPath}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`fake control ${urlPath} answered ${res.status}`);
  return res.json();
}
const fakeState = () => control('GET', '/state');

/** Sends a webhook to the app the way Zernio would; `sign` false sends no signature, a string signs with that secret. */
async function sendWebhook(body, sign = WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'x-zernio-event-id': String(body.id ?? '') };
  if (sign) headers['x-zernio-signature'] = createHmac('sha256', sign).update(raw).digest('hex');
  const res = await fetch(`${BASE_URL}/api/webhooks/zernio`, { method: 'POST', headers, body: raw });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON.
  }
  return { status: res.status, json };
}

/** A post event as Zernio documents it (zernio-api §11): event id, name, the post with our metadata, the platform. */
function postEvent(id, event, { postId, targetId, extra = {} }) {
  return { id, event, timestamp: new Date().toISOString(), post: { id: postId, metadata: { studioTargetId: targetId } }, platform: { name: 'tiktok', accountId: FAKE_ACCOUNT_ID, ...extra } };
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  return page;
}

async function openIntegrations(page) {
  await page.goto(`${BASE_URL}/settings?tab=integrations`);
  await page.getByRole('tab', { selected: true }).waitFor({ timeout: 30_000 });
  await tiktokSection(page).waitFor({ timeout: 30_000 });
}

/** The TikTok part of the Publishing card in Settings → Integrations. */
function tiktokSection(page) {
  return page.locator('section', { has: page.getByRole('heading', { level: 3, name: 'TikTok', exact: true }) });
}

/** The TikTok line of the integrations checklist at the top of Settings → Integrations. */
function tiktokChecklistLine(page) {
  return page.locator('li.rounded-xl', { has: page.getByRole('heading', { level: 3, name: 'TikTok', exact: true }) });
}

/** The box "Automatic posting via Zernio (optional)" inside the TikTok section. */
function zernioBox(page) {
  return tiktokSection(page).locator('div.rounded-lg', { has: page.getByRole('heading', { level: 4, name: 'Automatic posting via Zernio (optional)' }) });
}

/** Fires dragenter/dragover/drop with real File objects on the upload zone (as in the Stage A and B tests). */
async function dropFiles(page, filePaths) {
  const zone = page.locator('div', { has: page.locator(':scope > p', { hasText: /Drop your haircut clips here|Add more clips/ }) }).last();
  await zone.waitFor();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'e2e-drop-source';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#e2e-drop-source', filePaths);
  const dataTransfer = await page.evaluateHandle(() => {
    const input = document.getElementById('e2e-drop-source');
    const dt = new DataTransfer();
    for (const f of input.files) dt.items.add(f);
    input.remove();
    return dt;
  });
  await zone.dispatchEvent('dragenter', { dataTransfer });
  await zone.dispatchEvent('dragover', { dataTransfer });
  await zone.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

/** A Card (components/ui/card.tsx) by its title. */
function cardByTitle(page, title) {
  return page.locator('div[class*="radius-card"]', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
}

function platformSwitch(scope, platform) {
  return scope.getByRole('switch', { name: new RegExp(`^${platform} ·`) });
}

/** The bordered box of one platform in a composer card. */
function platformBox(scope, platform) {
  return scope.locator('div.rounded-xl.border', { has: scope.page().getByRole('switch', { name: new RegExp(`^${platform} ·`) }) });
}

/** Opens the composer for one version and waits until it has loaded. */
async function openComposer(page, versionId, styleName) {
  await page.goto(`${BASE_URL}/publishing/new?versions=${versionId}`);
  await page.getByRole('button', { name: /^Review \d/ }).waitFor({ timeout: 30_000 });
  return cardByTitle(page, `${PROJECT_TITLE} · ${styleName}`);
}

/** The TikTok destination card on a post's page. */
function tiktokTargetCard(page) {
  return page.locator('div.rounded-xl.border', { has: page.getByText(`TikTok · ${HANDLE}`, { exact: true }) }).first();
}

/** The consent box on the review step. */
function consentBox(page) {
  return page.locator('div.rounded-xl.border', { has: page.getByText(`TikTok through Zernio · ${HANDLE}`, { exact: true }) });
}

// ---------------------------------------------------------------------------------------------------------------
// Phase "setup": flag on, no API address
// ---------------------------------------------------------------------------------------------------------------

async function setupPhase({ browser, q, watch }) {
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
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await signIn(context);
  watch(page);
  check(true, 'owner signed in');

  log('Settings → Integrations with the flag on but no API address');
  await openIntegrations(page);
  const box = zernioBox(page);
  await box.waitFor();
  const boxText = await textOf(box);
  check(/Needs setup on the server: ZERNIO_API_BASE_URL\./.test(boxText), 'the Zernio box says "Needs setup on the server: ZERNIO_API_BASE_URL"', boxText.slice(0, 200));
  check((await box.getByLabel('Zernio API key').count()) === 0 && (await box.getByRole('button', { name: 'Save key' }).count()) === 0, 'no key can be pasted while the server needs setup');
  const line = await textOf(tiktokChecklistLine(page));
  check(/needs setup: add ZERNIO_API_BASE_URL/.test(line) && /^TikTok/.test(line) && /Post it yourself works now/.test(line), 'the checklist line says manual posting works and Zernio needs ZERNIO_API_BASE_URL', line.slice(0, 260));
  const dto = await apiGet(page, '/api/integrations/zernio');
  check(dto.enabled === true && dto.configured === false && dto.missingEnv.join() === 'ZERNIO_API_BASE_URL' && dto.keyHint === null, 'the API reports flag on, not configured, no key', JSON.stringify({ enabled: dto.enabled, configured: dto.configured, missingEnv: dto.missingEnv }));
  const refused = await apiJson(page, 'POST', '/api/integrations/zernio', { apiKey: FAKE_KEY });
  check(refused.status === 409 && !refused.text.includes(FAKE_KEY), 'a key sent anyway is refused (409) and not echoed', `${refused.status} ${refused.text.slice(0, 160)}`);
  const stored = await q("select count(*)::int as n from integration_connections where provider = 'zernio'");
  check(stored[0].n === 0, 'nothing was stored for the refused key', String(stored[0].n));
  const fake = await fakeState();
  check(fake.total === 0, 'the fake Zernio heard nothing in this phase', JSON.stringify(fake.counts));
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Phase "on": the whole flow against the fake
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every response body the app sent to this browser (to prove the key never comes back). Read once the request has
 * finished, so a response that is still streaming (a page left open) never holds the check up.
 */
function recordResponses(page, bodies) {
  page.on('requestfinished', (req) => {
    if (!req.url().startsWith(BASE_URL)) return;
    bodies.push(
      req
        .response()
        .then(async (res) => {
          const type = res?.headers()['content-type'] ?? '';
          return { url: req.url(), text: res && /json|text|x-component|javascript/.test(type) ? await res.text() : '' };
        })
        .catch(() => ({ url: req.url(), text: '' })),
    );
  });
}

async function waitForZernio(page, description, predicate, timeoutMs = 60_000) {
  return waitFor(description, async () => {
    const z = await apiGet(page, '/api/integrations/zernio');
    return predicate(z) ? z : null;
  }, { timeoutMs, intervalMs: 500 });
}

/** The approved post of a version and its TikTok target (database ids; the UI shows neither). */
async function postAndTarget(q, versionId) {
  const post = (await q('select id from publish_posts where edit_version_id = $1 and approved_at is not null order by created_at desc limit 1', [versionId]))[0];
  if (!post) return null;
  const target = (await q("select * from publish_targets where post_id = $1 and platform = 'tiktok'", [post.id]))[0];
  return target ? { postId: post.id, target } : null;
}

async function targetRow(q, id) {
  return (await q('select * from publish_targets where id = $1', [id]))[0];
}

/** Waits until a TikTok target reaches `status` (and optionally a manual step); a failure on the way stops the wait. */
async function waitForTarget(q, id, description, ok, { timeoutMs = 300_000, failOn = ['failed', 'cancelled'] } = {}) {
  return waitFor(
    description,
    async () => {
      const t = await targetRow(q, id);
      if (!ok(t) && failOn.includes(t.status)) throw fatal(`the target is ${t.status}: ${t.status_message}`);
      return ok(t) ? t : null;
    },
    { timeoutMs, intervalMs: 1000 },
  );
}

/** Waits until every webhook delivery received since `since` was processed and every read it queued has finished. */
async function waitForHintReads(q, since, description) {
  return waitFor(
    description,
    async () => {
      const events = await q("select processed_at, error from webhook_events where provider = 'zernio' and received_at >= $1", [since]);
      if (events.length === 0 || events.some((e) => !e.processed_at)) return null;
      const polls = await q("select status from jobs where type = 'publish.poll' and created_at >= $1", [since]);
      return polls.length > 0 && polls.every((j) => ['succeeded', 'failed', 'cancelled'].includes(j.status)) ? { events, polls } : null;
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}

/** Approves through the composer's review step, after the consent box was filled in by `fill`. */
async function reviewAndApprove(page, fill) {
  await page.getByRole('button', { name: 'Review 1 video' }).click();
  await page.getByText('This is exactly what will be posted.').waitFor({ timeout: 15_000 });
  const box = consentBox(page);
  await box.waitFor({ timeout: 15_000 });
  await fill(box);
  const post = page.getByRole('button', { name: /^Post now/ });
  await waitFor('the Post now button to be enabled', () => post.isEnabled(), { timeoutMs: 10_000, intervalMs: 200 });
  await post.click();
  await page.waitForURL(/\/publishing$/, { timeout: 30_000 });
}

async function onPhase({ browser, q, watch }) {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await signIn(context);
  watch(page);
  const bodies = [];
  recordResponses(page, bodies);
  check(Boolean(FAKE_KEY) && Boolean(FAKE_ACCOUNT_ID), 'the fake key and account id were read from the fake');

  // ---- 1. The key: a refused one, then the right one; only the last four characters ever come back. ----------------
  log('Settings → Integrations: paste a key Zernio refuses');
  await openIntegrations(page);
  const box = zernioBox(page);
  await box.getByLabel('Zernio API key').waitFor();
  check((await box.getByLabel('Zernio API key').getAttribute('type')) === 'password', 'the key field is a password field');
  const lineBefore = await textOf(tiktokChecklistLine(page));
  check(/ready to connect: paste a Zernio API key/.test(lineBefore), 'the checklist line says Zernio is ready to connect', lineBefore.slice(0, 220));
  await box.getByLabel('Zernio API key').fill(WRONG_KEY);
  await box.getByRole('button', { name: 'Save key' }).click();
  await waitForZernio(page, 'the check to refuse the wrong key', (z) => z.connectionStatus === 'needs_reauth');
  await page.reload();
  await zernioBox(page).getByText("Zernio didn't accept this key.", { exact: false }).first().waitFor({ timeout: 15_000 });
  const reauthText = await textOf(zernioBox(page));
  check(/Key saved \(ends …wxyz\)/.test(reauthText) && /Zernio didn't accept this key/.test(reauthText), 'a refused key shows "Zernio didn\'t accept this key" and only its last four characters', reauthText.slice(0, 260));
  const lineReauth = await textOf(tiktokChecklistLine(page));
  check(/Zernio needs a new key/.test(lineReauth), 'the checklist line says Zernio needs a new key', lineReauth.slice(0, 220));

  log('Replace it with the right key');
  await zernioBox(page).getByRole('button', { name: 'Replace key' }).click();
  await zernioBox(page).getByLabel('Zernio API key').fill(FAKE_KEY);
  await zernioBox(page).getByRole('button', { name: 'Save key' }).click();
  const listed = await waitForZernio(page, 'the check to list the TikTok account', (z) => z.connectionStatus === 'connected' && z.candidates.length === 1);
  check(listed.candidates[0].id === FAKE_ACCOUNT_ID && `@${listed.candidates[0].username}` === HANDLE && listed.candidates[0].problem === null, 'the fake account is the one candidate, without problems', JSON.stringify(listed.candidates));
  check(listed.keyHint === FAKE_KEY.slice(-4) && !JSON.stringify(listed).includes(FAKE_KEY), 'the API shows only the last four characters of the key', String(listed.keyHint));
  await page.reload();
  const accountRadio = zernioBox(page).getByRole('radio', { name: new RegExp(`^${HANDLE}`) });
  await accountRadio.waitFor({ timeout: 15_000 });
  check(/Key saved \(ends …6789\)/.test(await textOf(zernioBox(page))) && FAKE_KEY.endsWith('6789'), 'Settings shows "Key saved (ends …6789)"');
  check((await zernioBox(page).getByLabel('Zernio API key').count()) === 0, 'the key field is gone once a key is saved');
  const conn = (await q("select status, access_token_encrypted, config from integration_connections where provider = 'zernio'"))[0];
  check(Boolean(conn?.access_token_encrypted) && !conn.access_token_encrypted.includes(FAKE_KEY) && !JSON.stringify(conn.config).includes(FAKE_KEY) && conn.config.keyHint === '6789', 'the key is stored encrypted, with only its last four characters in plain text');

  log('Choose the TikTok account the fake lists');
  await accountRadio.check();
  await zernioBox(page).getByRole('button', { name: 'Use this account' }).click();
  const chosen = await waitFor(
    'the account check to read creator info',
    async () => {
      const a = (await q("select id, status, capabilities, external_id, direct_publish_enabled from social_accounts where provider = 'zernio' and platform = 'tiktok'"))[0];
      return a && a.status === 'connected' && typeof a.capabilities.allowStitchEnabled === 'boolean' ? a : null;
    },
    { timeoutMs: 60_000 },
  );
  check(chosen.external_id === FAKE_ACCOUNT_ID && chosen.capabilities.businessApiLane === true && chosen.direct_publish_enabled === false, 'the chosen account is stored on the Business lane with direct publishing off', JSON.stringify({ lane: chosen.capabilities.integrationLane, direct: chosen.direct_publish_enabled }));
  facts.accountRowId = chosen.id;
  await page.reload();
  const accountRow = zernioBox(page).locator('div.rounded-lg', { has: page.getByText(HANDLE, { exact: true }) }).last();
  await accountRow.getByRole('switch', { name: 'Publish directly via Zernio' }).waitFor({ timeout: 15_000 });
  const rowText = await textOf(accountRow);
  check(/Not verified\. Your first post through Zernio is a real, public TikTok post/.test(rowText), 'the account row says it is not verified and the first post is real and public', rowText.slice(0, 220));
  check((await accountRow.getByRole('switch', { name: 'Publish directly via Zernio' }).isDisabled()) && (await accountRow.getByRole('switch', { name: 'Send to TikTok drafts' }).isDisabled()), 'both switches stay off and locked until a verification post');
  const lineConnected = await textOf(tiktokChecklistLine(page));
  check(/Connected as @ivanhoe_studio_test through Zernio\. Not verified/.test(lineConnected), 'the checklist line says connected, not verified', lineConnected.slice(0, 220));
  check(!(await page.content()).includes(FAKE_KEY), 'the Settings page never contains the key');
  const afterConnect = await fakeState();
  check((afterConnect.counts.verify ?? 0) >= 2 && (afterConnect.counts.accounts ?? 0) >= 1 && (afterConnect.counts.health ?? 0) >= 1 && (afterConnect.counts.creator_info ?? 0) >= 1, 'the checks went through verify, accounts, health and creator info', JSON.stringify(afterConnect.counts));
  check(!afterConnect.counts.create && !afterConnect.counts.presign && !afterConnect.counts.upload, 'connecting and choosing posted nothing', JSON.stringify(afterConnect.counts));
  check(afterConnect.badAuth.length === 1 && afterConnect.badAuth[0] === 'GET /api/v1/auth/verify', 'only the refused key reached the fake without the right key (one verify)', afterConnect.badAuth.join(', '));

  // ---- 2. Footage and five edits. ----------------------------------------------------------------------------------
  log('Project with three clips and five edits');
  await page.goto(`${BASE_URL}/studio`);
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Project name').fill(PROJECT_TITLE);
  await page.getByRole('dialog').getByRole('button', { name: /Create/ }).click();
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 30_000 });
  const projectId = new URL(page.url()).pathname.split('/').pop();
  await page.getByText('Drop your haircut clips here to start').waitFor();
  await dropFiles(page, CLIPS.map((c) => path.join(SAMPLES, c.file)));
  await waitFor(
    'all three clips to be ready',
    async () => {
      const s = await apiGet(page, `/api/projects/${projectId}/status`);
      const failed = s.assets.filter((a) => a.status === 'failed');
      if (failed.length) throw fatal(`clip analysis failed: ${failed.map((a) => `${a.filename}: ${a.statusMessage}`).join('; ')}`);
      return s.assets.length === 3 && s.assets.every((a) => a.status === 'ready') ? s : null;
    },
    { timeoutMs: 240_000, intervalMs: 2000 },
  );
  const clipCards = page.locator('section[aria-labelledby="clips-heading"] li');
  await waitFor('three Ready pills', async () => (await clipCards.filter({ hasText: 'Ready' }).count()) === 3, { timeoutMs: 30_000 });
  for (const c of CLIPS) {
    const select = clipCards.filter({ hasText: c.file }).getByLabel("What's in this clip?");
    await select.selectOption({ label: c.tag });
    await waitFor(`the ${c.tag} tag to save`, async () => (await select.isEnabled()) && (await select.inputValue()) !== '', { timeoutMs: 15_000, intervalMs: 300 });
  }
  await page.locator('input[type="range"]').first().fill(String(TARGET_SEC));
  await page.getByRole('button', { name: 'Generate 5 edits' }).click();
  const generated = await waitFor(
    'five previews',
    async () => {
      const s = await apiGet(page, `/api/projects/${projectId}/status`);
      const g = s.generations[0];
      if (!g) return null;
      const versions = g.edits.map((e) => e.versions.find((v) => v.id === e.currentVersionId) ?? e.versions[0]);
      const bad = versions.filter((v) => v && (v.status === 'failed' || v.status === 'cancelled'));
      if (bad.length) throw fatal(`a preview failed: ${bad.map((v) => v.statusMessage).join('; ')}`);
      return g.edits.length === 5 && versions.every((v) => v?.status === 'preview_ready') ? g : null;
    },
    { timeoutMs: 480_000, intervalMs: 2000 },
  );
  const edits = generated.edits.map((e) => ({ styleName: e.styleName, versionId: e.currentVersionId ?? e.versions[0].id }));
  check(edits.length === 5, 'five edits are ready');
  const [editA, editB, editC, editD] = edits;
  facts.editD = editD;
  facts.projectId = projectId;

  // ---- 3. Post A: "Publish via Zernio" as the first verification post. ------------------------------------------------
  log(`Post A ("${editA.styleName}"): the first verification post via Zernio`);
  let card = await openComposer(page, editA.versionId, editA.styleName);
  await platformSwitch(card, 'TikTok').click();
  let tiktok = platformBox(card, 'TikTok');
  const publishOption = tiktok.getByRole('radio', { name: /^First verification post \(publish via Zernio\)/ });
  const draftOption = tiktok.getByRole('radio', { name: /^First verification post \(send to TikTok drafts via Zernio\)/ });
  await publishOption.waitFor({ timeout: 15_000 });
  check((await publishOption.isEnabled()) && (await draftOption.isEnabled()) && (await tiktok.getByRole('radio', { name: /^Post it yourself/ }).count()) === 1, 'the composer offers "Publish via Zernio" and "Send to TikTok drafts via Zernio" as first verification posts, next to "Post it yourself"');
  await publishOption.check();
  const optionText = await textOf(tiktok);
  check(new RegExp(`This is a real, public post on ${HANDLE}\\.`).test(optionText) && /0 of 15 TikTok videos in the last 24 h/.test(optionText), 'the option warns it is a real, public post and shows 0 of 15 videos today', optionText.slice(0, 400));
  await card.getByRole('textbox', { name: 'Caption', exact: true }).fill('Clean skin fade, posted through Zernio. E2E TikTok post A.');
  await page.getByRole('button', { name: 'Review 1 video' }).click();
  await page.getByText('This is exactly what will be posted.').waitFor({ timeout: 15_000 });
  let consent = consentBox(page);
  await consent.waitFor({ timeout: 15_000 });
  const postNow = page.getByRole('button', { name: /^Post now/ });
  const comments = consent.getByRole('switch', { name: 'Comments', exact: true });
  const duets = consent.getByRole('switch', { name: 'Duets', exact: true });
  const stitches = consent.getByRole('switch', { name: 'Stitches', exact: true });
  check(
    (await comments.getAttribute('aria-checked')) === 'true' && (await duets.getAttribute('aria-checked')) === 'false' && (await stitches.getAttribute('aria-checked')) === 'false' && (await stitches.isDisabled()),
    'the three switches start from creator info: Comments on, Duets off, Stitches off and locked',
  );
  check(/Turned off in your TikTok settings/.test(await textOf(consent)), 'the locked switch says it is turned off in TikTok');
  check(await postNow.isDisabled(), 'Post now is disabled until the consent tick');

  log('Approval without the consent tick and choices is refused by the API too');
  const draftPost = (await q('select id from publish_posts where edit_version_id = $1 and approved_at is null', [editA.versionId]))[0];
  const tries = [
    { body: { postIds: [draftPost.id] }, why: 'no consent at all', expect: /Tick the box to confirm/ },
    { body: { postIds: [draftPost.id], consent: { tiktokPublic: false, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: false } } }, why: 'the tick false', expect: /Tick the box to confirm/ },
    { body: { postIds: [draftPost.id], consent: { tiktokPublic: true } }, why: 'the tick but no interaction choices', expect: /Choose whether to allow Comments, Duets and Stitches/ },
    { body: { postIds: [draftPost.id], consent: { tiktokPublic: true, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: true } } }, why: 'Stitches on although TikTok turned it off', expect: /Stitches is turned off in your TikTok settings/ },
  ];
  for (const t of tries) {
    const r = await apiJson(page, 'POST', '/api/publish-posts/approve', t.body);
    check(r.status === 400 && t.expect.test(r.json?.error?.message ?? ''), `approval with ${t.why} is refused (400)`, `${r.status} ${r.json?.error?.message ?? r.text.slice(0, 120)}`);
  }
  const notApproved = (await q('select approved_at from publish_posts where id = $1', [draftPost.id]))[0];
  const noConsent = (await q("select provider_state from publish_targets where post_id = $1 and platform = 'tiktok'", [draftPost.id]))[0];
  check(notApproved.approved_at === null && !('consent' in (noConsent.provider_state ?? {})), 'the refused approvals left the post unapproved with no consent stored');

  log('Choose Comments off, Duets on, tick the consent and post');
  await comments.click();
  await duets.click();
  check((await comments.getAttribute('aria-checked')) === 'false' && (await duets.getAttribute('aria-checked')) === 'true', "the owner's choices differ from the seeds (Comments off, Duets on)");
  const publicTick = consent.getByRole('checkbox', { name: new RegExp(`I've watched this video and checked the caption\\. Post it publicly to TikTok as ${HANDLE}\\.`) });
  check(await postNow.isDisabled(), 'with the switches chosen but no tick, Post now is still disabled');
  await publicTick.check();
  await waitFor('the Post now button to be enabled', () => postNow.isEnabled(), { timeoutMs: 10_000, intervalMs: 200 });
  await postNow.click();
  await page.waitForURL(/\/publishing$/, { timeout: 30_000 });
  const a = await waitFor('post A to be approved', () => postAndTarget(q, editA.versionId), { timeoutMs: 15_000 });
  const boundA = a.target.provider_state.consent;
  check(boundA?.tiktokPublic === true && boundA.binding.interactions.allowComment === false && boundA.binding.interactions.allowDuet === true && boundA.binding.interactions.allowStitch === false && boundA.binding.delivery === 'publish', 'the approval stored the consent bound to the choices the owner saw', JSON.stringify(boundA?.binding?.interactions));

  const createdA = await waitForTarget(q, a.target.id, 'post A to be created at the fake', (t) => t.status === 'processing' && Boolean(t.external_post_id), { timeoutMs: 420_000 });
  facts.postA = { postId: a.postId, targetId: a.target.id, zernioPostId: createdA.external_post_id };
  let fake = await fakeState();
  check(fake.counts.presign === 1 && fake.counts.upload === 1 && fake.counts.create === 1, 'the worker presigned once, uploaded once and created exactly one post', JSON.stringify(fake.counts));
  const upload = fake.uploads[0];
  check(upload && upload.authorization === null && !upload.keyAnywhere, 'the upload PUT carried no Authorization header and the key nowhere', JSON.stringify({ authorization: upload?.authorization, keyAnywhere: upload?.keyAnywhere }));
  check(upload && upload.host === new URL(FAKE_ZERNIO_URL).host && upload.contentType === 'video/mp4' && Number(upload.contentLength) === upload.bytes && upload.bytes > 100_000 && !upload.transferEncoding, 'the upload went only to the presigned address, as video/mp4 with an explicit Content-Length (not chunked)', JSON.stringify(upload));
  check(fake.presigns[0]?.contentType === 'video/mp4' && fake.presigns[0]?.size === upload?.bytes && fake.presigns[0]?.filename === `${a.target.id}.mp4`, 'the presign named the target and the exact size', JSON.stringify(fake.presigns[0]));
  const create = fake.creates[0];
  const s = create?.body?.tiktokSettings ?? {};
  check(create?.idempotencyKey === a.target.id && create.body.metadata?.studioTargetId === a.target.id, 'the create carried Idempotency-Key and metadata.studioTargetId = the target id', JSON.stringify({ key: create?.idempotencyKey, metadata: create?.body?.metadata }));
  check(s.content_preview_confirmed === true && s.express_consent_given === true && s.privacy_level === 'PUBLIC_TO_EVERYONE', 'the create body has both consent flags and PUBLIC_TO_EVERYONE', JSON.stringify(s));
  check(s.allow_comment === false && s.allow_duet === true && s.allow_stitch === false && !('draft' in s) && !('isDraft' in s), "the create body has the owner's three choices and no draft flag", JSON.stringify(s));
  check(create?.body?.publishNow === true && create.body.platforms?.[0]?.accountId === FAKE_ACCOUNT_ID && create.body.mediaItems?.[0]?.url?.startsWith('https://media.zernio.example/') && create.body.content.startsWith('Clean skin fade, posted through Zernio.'), 'the create body names the account, the uploaded file and the caption', JSON.stringify({ platforms: create?.body?.platforms, media: create?.body?.mediaItems }));
  check(fake.invalidBodies.length === 0, 'no create body broke the strict contract (no unknown field)', JSON.stringify(fake.invalidBodies).slice(0, 200));
  check(fake.badAuth.length === 1 && fake.unknown.length === 0, 'every other request carried the right key, and nothing hit an unknown path', `${fake.badAuth.join(', ')} | ${fake.unknown.join(', ')}`);

  await page.goto(`${BASE_URL}/publishing/${a.postId}`);
  let target = tiktokTargetCard(page);
  await target.getByText('Processing', { exact: true }).waitFor({ timeout: 30_000 });
  let targetText = await textOf(target);
  check(/TikTok is processing the video/.test(targetText) && !/Posted/.test(targetText) && (await target.getByRole('link', { name: /View on TikTok/ }).count()) === 0, 'post A shows "Processing", with no "Posted" and no link', targetText.slice(0, 300));
  check(/First verification post \(publish via Zernio\)|Publish via Zernio/.test(targetText) && new RegExp(`This is a real, public post on ${HANDLE}`).test(targetText), 'the card names the method and warns it is a real, public post', targetText.slice(0, 300));

  log('Forged and unsigned webhooks claiming "published" change nothing');
  const eventId = `evt_e2e_${randomUUID()}`;
  const forgedAt = new Date();
  const forged = postEvent(eventId, 'post.platform.published', { postId: createdA.external_post_id, targetId: a.target.id, extra: { platformPostUrl: 'https://www.tiktok.com/@someone_else/video/7399999999999999999', status: 'published' } });
  const forgedAnswer = await sendWebhook(forged, 'not-the-webhook-secret');
  const unsignedAnswer = await sendWebhook({ ...forged, timestamp: new Date(Date.now() + 1).toISOString() }, false);
  check(forgedAnswer.status === 200 && unsignedAnswer.status === 200, 'Zernio-style answers: a forged and an unsigned delivery are both answered 200', `${forgedAnswer.status} ${unsignedAnswer.status}`);
  await waitForHintReads(q, forgedAt, 'the forged deliveries to be processed');
  const forgedRows = await q("select external_event_id, signature_valid, payload from webhook_events where provider = 'zernio' and received_at >= $1", [forgedAt]);
  check(forgedRows.length === 2 && forgedRows.every((r) => r.external_event_id.startsWith('unverified:') && r.signature_valid === false), 'both were stored as unverified, never under the event id', forgedRows.map((r) => r.external_event_id.slice(0, 20)).join(', '));
  check(forgedRows.every((r) => !JSON.stringify(r.payload).includes('someone_else') && Object.keys(r.payload).sort().join() === 'accountId,event,id,platform,postId,studioTargetId'), 'only the envelope was stored (no link from the payload)', JSON.stringify(forgedRows[0]?.payload));
  const afterForged = await targetRow(q, a.target.id);
  check(afterForged.status === 'processing' && afterForged.published_url === null && afterForged.published_at === null, 'post A is still processing with no link after the forged deliveries', `${afterForged.status} ${afterForged.published_url}`);
  await page.reload();
  await tiktokTargetCard(page).getByText('Processing', { exact: true }).waitFor({ timeout: 15_000 });
  check((await tiktokTargetCard(page).getByRole('link', { name: /View on TikTok/ }).count()) === 0, 'the page still shows "Processing" and no link');

  log('The fake says published (no link yet); a signed webhook with the same event id triggers the read');
  await control('POST', `/posts/${createdA.external_post_id}`, { status: 'published', entry: { status: 'published', publishedAt: new Date().toISOString(), platformPostUrl: null } });
  const readsBefore = (await fakeState()).reads.length;
  const signedAt = new Date();
  const signed = await sendWebhook(postEvent(eventId, 'post.platform.published', { postId: createdA.external_post_id, targetId: a.target.id }));
  check(signed.status === 200 && signed.json?.duplicate === false, 'the signed delivery is new, although forged ones used its event id first', JSON.stringify(signed.json));
  await waitForHintReads(q, signedAt, 'the signed delivery to be processed');
  const realRow = (await q("select signature_valid from webhook_events where provider = 'zernio' and external_event_id = $1", [eventId]))[0];
  check(realRow?.signature_valid === true, 'the signed delivery holds its own event id, verified');
  const publishedA = await waitForTarget(q, a.target.id, 'post A to be published', (t) => t.status === 'published');
  check((await fakeState()).reads.length > readsBefore, 'the signed webhook made the worker read the post');
  check(publishedA.published_url === null, 'published without a link while the fake has none', String(publishedA.published_url));
  await page.reload();
  target = tiktokTargetCard(page);
  await target.getByText('Posted', { exact: true }).waitFor({ timeout: 15_000 });
  targetText = await textOf(target);
  check(/Published\. The TikTok link appears in a few minutes\./.test(targetText) && (await target.getByRole('link', { name: /View on TikTok/ }).count()) === 0, 'post A shows "Posted" and "The TikTok link appears in a few minutes", with no link', targetText.slice(0, 300));
  check(new RegExp(`Can you see the video on ${HANDLE}\\?`).test(targetText), 'the owner is asked whether the video is on TikTok');

  log('The fake resolves the TikTok link; a signed url_resolved webhook brings it in');
  await control('POST', `/posts/${createdA.external_post_id}`, { entry: { platformPostUrl: TIKTOK_URL_A } });
  const urlAt = new Date();
  await sendWebhook(postEvent(`evt_e2e_${randomUUID()}`, 'post.tiktok.url_resolved', { postId: createdA.external_post_id, targetId: a.target.id }));
  await waitForHintReads(q, urlAt, 'the url_resolved delivery to be processed');
  await waitForTarget(q, a.target.id, 'post A to have its link', (t) => t.published_url === TIKTOK_URL_A, { timeoutMs: 30_000 });
  await page.reload();
  target = tiktokTargetCard(page);
  await target.getByRole('link', { name: /View on TikTok/ }).waitFor({ timeout: 15_000 });
  check((await target.getByRole('link', { name: /View on TikTok/ }).getAttribute('href')) === TIKTOK_URL_A, 'the link is the one the fake resolved');
  await target.getByRole('button', { name: "Yes, it's there" }).click();
  await waitFor('the verification answer', async () => (await q('select capabilities from social_accounts where id = $1', [facts.accountRowId]))[0]?.capabilities?.verifiedDirectAt, { timeoutMs: 15_000 });
  check(true, 'the owner confirmed the verification post');
  log('A second publish.target run for post A (a duplicate delivery) sends nothing');
  const { stdout: requeued } = await execFileAsync(TSX, [path.join(HERE, 'requeue-job.ts'), a.postId, a.target.id, projectId], { env: { ...process.env, DATABASE_URL }, cwd: path.join(REPO_ROOT, 'apps', 'web') });
  const { bossJobId } = JSON.parse(requeued.trim().split('\n').pop());
  const secondRun = await waitFor('the second publish.target run to finish', async () => (await q("select status, message from jobs where boss_job_id = $1 and status in ('succeeded', 'failed', 'cancelled')", [bossJobId]))[0] ?? null, { timeoutMs: 60_000 });
  fake = await fakeState();
  check(secondRun.status === 'succeeded' && fake.counts.create === 1 && fake.counts.presign === 1 && fake.counts.upload === 1, 'still exactly one create (and one upload) for post A after a duplicate run', `${secondRun.status}: ${secondRun.message}; ${JSON.stringify(fake.counts)}`);
  check((await targetRow(q, a.target.id)).published_url === TIKTOK_URL_A, 'post A keeps its link after the duplicate run');

  // ---- 4. Post B: a draft via Zernio ends as "finish in the TikTok app", never published. ---------------------------
  log(`Post B ("${editB.styleName}"): the first draft via Zernio`);
  card = await openComposer(page, editB.versionId, editB.styleName);
  await platformSwitch(card, 'TikTok').click();
  tiktok = platformBox(card, 'TikTok');
  await tiktok.getByRole('radio', { name: /^First verification post \(send to TikTok drafts via Zernio\)/ }).check();
  const draftOptionText = await textOf(tiktok);
  check(new RegExp(`This sends a real draft to the TikTok inbox of ${HANDLE}\\.`).test(draftOptionText) && /Choose the cover, sound and caption in the TikTok app\./.test(draftOptionText), 'the drafts option says it sends a real draft to the TikTok inbox', draftOptionText.slice(0, 400));
  await card.getByRole('textbox', { name: 'Caption', exact: true }).fill('Fresh taper, sent to the TikTok drafts. E2E TikTok post B.');
  await page.getByRole('button', { name: 'Review 1 video' }).click();
  await page.getByText('This is exactly what will be posted.').waitFor({ timeout: 15_000 });
  consent = consentBox(page);
  await consent.waitFor({ timeout: 15_000 });
  const reviewText = await textOf(page.locator('main'));
  check(new RegExp(`This sends a real draft to the TikTok inbox of ${HANDLE}\\.`).test(reviewText) && /Choose the cover in the TikTok app\./.test(reviewText), 'the review step says it is a draft for the TikTok inbox', reviewText.slice(0, 400));
  check((await consent.getByRole('checkbox', { name: /Post it publicly/ }).count()) === 0, 'a draft asks for no "post it publicly" tick');
  await consent.getByRole('checkbox', { name: new RegExp(`I've watched this video\\. Send it to my TikTok drafts as ${HANDLE}\\.`) }).check();
  const postNowB = page.getByRole('button', { name: /^Post now/ });
  await waitFor('the Post now button to be enabled', () => postNowB.isEnabled(), { timeoutMs: 10_000, intervalMs: 200 });
  await postNowB.click();
  await page.waitForURL(/\/publishing$/, { timeout: 30_000 });
  const b = await waitFor('post B to be approved', () => postAndTarget(q, editB.versionId), { timeoutMs: 15_000 });
  const createdB = await waitForTarget(q, b.target.id, 'post B to be created at the fake', (t) => t.status === 'processing' && Boolean(t.external_post_id), { timeoutMs: 420_000 });
  facts.postB = { postId: b.postId, targetId: b.target.id };
  fake = await fakeState();
  const createB = fake.creates[1];
  const sb = createB?.body?.tiktokSettings ?? {};
  check(fake.counts.create === 2 && createB?.idempotencyKey === b.target.id && sb.draft === true && sb.content_preview_confirmed === true && sb.express_consent_given === true, 'one create for post B, with draft: true inside tiktokSettings and both consent flags', JSON.stringify(sb));
  check(fake.invalidBodies.length === 0, 'post B also kept to the strict contract');
  await page.goto(`${BASE_URL}/publishing/${b.postId}`);
  target = tiktokTargetCard(page);
  await target.getByText('Processing', { exact: true }).waitFor({ timeout: 30_000 });
  targetText = await textOf(target);
  check(new RegExp(`This sends a real draft to the TikTok inbox of ${HANDLE}\\.`).test(targetText) && !/real, public post/.test(targetText), 'the draft destination card does not call it a public post', targetText.slice(0, 300));

  log('The fake reports the draft delivered (entry published, no link)');
  await control('POST', `/posts/${createdB.external_post_id}`, { status: 'published', entry: { status: 'published', publishedAt: new Date().toISOString(), platformPostUrl: null } });
  const draftAt = new Date();
  await sendWebhook(postEvent(`evt_e2e_${randomUUID()}`, 'post.platform.published', { postId: createdB.external_post_id, targetId: b.target.id }));
  await waitForHintReads(q, draftAt, 'the draft delivery to be processed');
  const handed = await waitForTarget(q, b.target.id, 'post B to be handed over to the TikTok app', (t) => t.status === 'manual_step_required' && t.manual_step === 'finish_in_tiktok_app', { timeoutMs: 30_000, failOn: ['failed', 'cancelled', 'published'] });
  check(handed.published_url === null && handed.published_at === null, 'the draft has no link and no published time', `${handed.published_url} ${handed.published_at}`);
  await page.reload();
  target = tiktokTargetCard(page);
  await target.getByText('Your turn', { exact: true }).waitFor({ timeout: 15_000 });
  targetText = await textOf(target);
  check(/Sent to your TikTok drafts\. Open TikTok, add a sound if you like, and post\./.test(targetText), 'post B says "Sent to your TikTok drafts. Open TikTok … and post."', targetText.slice(0, 300));
  check(!/Posted/.test(targetText) && !/Published/.test(targetText) && (await target.getByRole('link', { name: /View on TikTok/ }).count()) === 0, 'the draft is never shown as posted or published, and has no link', targetText.slice(0, 300));
  const postB = await apiGet(page, `/api/publish-posts/${b.postId}`);
  check(postB.status !== 'complete' && postB.targets.every((t) => t.status !== 'published'), 'the post itself is not complete', postB.status);
  check(new RegExp(`Can you see the draft in the TikTok inbox of ${HANDLE}\\?`).test(targetText), 'the owner is asked whether the draft reached the TikTok inbox');
  await target.getByRole('button', { name: "Yes, it's there" }).click();
  await waitFor('the draft verification answer', async () => (await q('select capabilities from social_accounts where id = $1', [facts.accountRowId]))[0]?.capabilities?.verifiedDraftAt, { timeoutMs: 15_000 });
  check(true, 'the owner confirmed the draft verification');

  log('Switch on "Publish directly via Zernio" (now verified)');
  await openIntegrations(page);
  const row = zernioBox(page).locator('div.rounded-lg', { has: page.getByText(HANDLE, { exact: true }) }).last();
  const directSwitch = row.getByRole('switch', { name: 'Publish directly via Zernio' });
  await waitFor('the direct switch to be enabled', () => directSwitch.isEnabled(), { timeoutMs: 15_000, intervalMs: 300 });
  check(/First post through Zernio confirmed/.test(await textOf(row)) && /1 of 15 TikTok videos in the last 24 h/.test(await textOf(row)), 'Settings shows the first post confirmed and 1 of 15 videos (drafts are not counted)', (await textOf(row)).slice(0, 300));
  await directSwitch.click();
  await waitFor('the switch to be on', async () => (await directSwitch.getAttribute('aria-checked')) === 'true', { timeoutMs: 15_000, intervalMs: 300 });
  check(true, 'direct publishing via Zernio switched on');

  // ---- 5. Post C: a failed post's Retry calls /retry, never a second create. -----------------------------------------
  log(`Post C ("${editC.styleName}"): publish via Zernio, fail at TikTok, retry`);
  card = await openComposer(page, editC.versionId, editC.styleName);
  await platformSwitch(card, 'TikTok').click();
  tiktok = platformBox(card, 'TikTok');
  const plainOption = tiktok.getByRole('radio', { name: /^Publish via Zernio/ });
  await plainOption.waitFor({ timeout: 15_000 });
  check((await tiktok.getByRole('radio', { name: /^First verification post \(publish via Zernio\)/ }).count()) === 0, 'after the confirmed verification, "Publish via Zernio" is a plain option');
  await plainOption.check();
  await card.getByRole('textbox', { name: 'Caption', exact: true }).fill('Sharp line-up, posted through Zernio. E2E TikTok post C.');
  await reviewAndApprove(page, async (box) => {
    await box.getByRole('checkbox', { name: /Post it publicly to TikTok/ }).check();
  });
  const c = await waitFor('post C to be approved', () => postAndTarget(q, editC.versionId), { timeoutMs: 15_000 });
  const createdC = await waitForTarget(q, c.target.id, 'post C to be created at the fake', (t) => t.status === 'processing' && Boolean(t.external_post_id), { timeoutMs: 420_000 });
  facts.postC = { postId: c.postId, targetId: c.target.id };
  fake = await fakeState();
  const createC = fake.creates[2];
  check(fake.counts.create === 3 && createC?.idempotencyKey === c.target.id && createC.body.tiktokSettings.allow_comment === true && createC.body.tiktokSettings.allow_duet === false, 'one create for post C, with the switches as left (the seeds)', JSON.stringify(createC?.body?.tiktokSettings));

  await control('POST', `/posts/${createdC.external_post_id}`, { status: 'failed', entry: { status: 'failed', errorMessage: 'The video could not be processed (fake).', errorSource: 'platform', errorCategory: 'platform_error' } });
  const failAt = new Date();
  await sendWebhook(postEvent(`evt_e2e_${randomUUID()}`, 'post.platform.failed', { postId: createdC.external_post_id, targetId: c.target.id }));
  await waitForHintReads(q, failAt, 'the failure delivery to be processed');
  await waitForTarget(q, c.target.id, 'post C to fail', (t) => t.status === 'failed', { timeoutMs: 30_000, failOn: ['cancelled', 'published'] });
  await page.goto(`${BASE_URL}/publishing/${c.postId}`);
  target = tiktokTargetCard(page);
  await target.getByText('Failed', { exact: true }).waitFor({ timeout: 30_000 });
  targetText = await textOf(target);
  check(/TikTok didn't publish this\. TikTok said: The video could not be processed \(fake\)\./.test(targetText) && (await target.getByRole('button', { name: 'Retry', exact: true }).count()) === 1, "post C shows Failed with TikTok's message and a Retry button", targetText.slice(0, 300));
  await control('POST', '/scenario', { retryStatus: 200, retryPostStatus: 'publishing', retryEntry: { status: 'processing', errorMessage: null } });
  await target.getByRole('button', { name: 'Retry', exact: true }).click();
  await waitFor('the retry call at the fake', async () => ((await fakeState()).counts.retry ?? 0) >= 1, { timeoutMs: 60_000 });
  await waitForTarget(q, c.target.id, 'post C to be processing again', (t) => t.status === 'processing', { timeoutMs: 60_000, failOn: ['cancelled', 'published'] });
  fake = await fakeState();
  check(fake.counts.retry === 1 && fake.retries[0]?.path === `/api/v1/posts/${createdC.external_post_id}/retry` && fake.retries[0]?.bytes === 0, 'Retry called /v1/posts/{id}/retry once, with no body', JSON.stringify(fake.retries));
  check(fake.counts.create === 3 && fake.counts.presign === 3 && fake.counts.upload === 3, 'no second create (and no new upload) for the retry', JSON.stringify(fake.counts));
  await control('POST', `/posts/${createdC.external_post_id}`, { status: 'published', entry: { status: 'published', publishedAt: new Date().toISOString(), platformPostUrl: TIKTOK_URL_C, errorMessage: null } });
  const okAt = new Date();
  await sendWebhook(postEvent(`evt_e2e_${randomUUID()}`, 'post.platform.published', { postId: createdC.external_post_id, targetId: c.target.id }));
  await waitForHintReads(q, okAt, 'the retried post delivery to be processed');
  await waitForTarget(q, c.target.id, 'post C to be published with its link', (t) => t.status === 'published' && t.published_url === TIKTOK_URL_C, { timeoutMs: 30_000 });
  await page.reload();
  target = tiktokTargetCard(page);
  await target.getByRole('link', { name: /View on TikTok/ }).waitFor({ timeout: 15_000 });
  check((await target.getByRole('link', { name: /View on TikTok/ }).getAttribute('href')) === TIKTOK_URL_C && /Posted/.test(await textOf(target)), 'after the retry post C is posted with the link the fake resolved');

  // ---- 6. Wrap up: the count, the key never in a response, no request after settling. -------------------------------
  await openIntegrations(page);
  const finalRow = zernioBox(page).locator('div.rounded-lg', { has: page.getByText(HANDLE, { exact: true }) }).last();
  await finalRow.getByText(/of 15 TikTok videos in the last 24 h/).waitFor({ timeout: 15_000 });
  check(/2 of 15 TikTok videos in the last 24 h/.test(await textOf(finalRow)), 'Settings counts 2 of 15 videos (posts A and C)', (await textOf(finalRow)).slice(0, 300));
  fake = await fakeState();
  check(fake.counts.create === 3 && fake.posts.length === 3, 'three posts in total at the fake, one per destination', JSON.stringify(fake.counts));
  const settled = await Promise.all(bodies);
  const leaks = settled.filter((r) => r.text.includes(FAKE_KEY));
  check(settled.length > 20 && leaks.length === 0, `the key appeared in none of the ${settled.length} responses the app sent to the browser`, leaks.map((r) => r.url).join(', '));
  const auditLeak = await q('select count(*)::int as n from audit_log where data::text like $1', [`%${FAKE_KEY}%`]);
  const jobLeak = await q('select count(*)::int as n from jobs where payload::text like $1 or message like $1', [`%${FAKE_KEY}%`]);
  check(auditLeak[0].n === 0 && jobLeak[0].n === 0, 'the key is in no audit entry, job payload or job message');
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Phase "off": flag off after use
// ---------------------------------------------------------------------------------------------------------------

async function offPhase({ browser, q, watch }) {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await signIn(context);
  watch(page);

  log('Settings → Integrations with the flag off');
  await openIntegrations(page);
  const section = tiktokSection(page);
  const sectionText = await textOf(section);
  check(!/Zernio/i.test(sectionText) && /Post it yourself/.test(sectionText), 'the TikTok section says nothing about Zernio, only "Post it yourself"', sectionText.slice(0, 260));
  check((await page.getByLabel('Zernio API key').count()) === 0, 'there is no key field');
  const line = await textOf(tiktokChecklistLine(page));
  check(/the optional route through Zernio is off on this server\./.test(line), 'the checklist line says the Zernio route is off on this server', line.slice(0, 260));
  const mainText = await textOf(page.locator('main'));
  const withoutLine = mainText.replace(line, '');
  check((mainText.match(/Zernio/g) ?? []).length >= 1 && !/Zernio/i.test(withoutLine), 'the checklist line is the only place on the page that mentions Zernio', (withoutLine.match(/.{0,60}Zernio.{0,60}/i) ?? [''])[0]);
  const dto = await apiGet(page, '/api/integrations/zernio');
  check(dto.enabled === false && dto.keyHint !== FAKE_KEY && !JSON.stringify(dto).includes(FAKE_KEY), 'the API reports the flag off and never the key', JSON.stringify({ enabled: dto.enabled }));

  log('The composer offers only "Post it yourself" for TikTok');
  const editD = facts.editD;
  const card = await openComposer(page, editD.versionId, editD.styleName);
  await platformSwitch(card, 'TikTok').click();
  const tiktok = platformBox(card, 'TikTok');
  await tiktok.getByRole('radio', { name: /^Post it yourself/ }).waitFor({ timeout: 15_000 });
  check((await tiktok.getByRole('radio').filter({ hasText: /Zernio/ }).count()) === 0 && (await tiktok.locator('fieldset').first().getByRole('radio').count()) === 1, 'the only TikTok method is "Post it yourself"');
  check(!/Zernio/i.test(await textOf(card)), 'the composer card says nothing about Zernio');

  log('The routes refuse and queued work sends nothing');
  const hook = await sendWebhook(postEvent(`evt_e2e_${randomUUID()}`, 'post.platform.published', { postId: 'x', targetId: facts.postA.targetId }));
  check(hook.status === 404, 'the webhook route answers 404 with the flag off', String(hook.status));
  const key = await apiJson(page, 'POST', '/api/integrations/zernio', { apiKey: FAKE_KEY });
  check(key.status === 409 && !key.text.includes(FAKE_KEY), 'a new key is refused (409) and not echoed', `${key.status} ${key.text.slice(0, 160)}`);
  const conn = (await q("select id from integration_connections where provider = 'zernio'"))[0];
  const runJob = async (type, payload) => {
    const { stdout } = await execFileAsync(TSX, [path.join(HERE, 'enqueue-job.ts'), type, JSON.stringify(payload)], { env: { ...process.env, DATABASE_URL }, cwd: path.join(REPO_ROOT, 'apps', 'web') });
    const { bossJobId } = JSON.parse(stdout.trim().split('\n').pop());
    return waitFor(`the ${type} run to finish`, async () => (await q("select status, message from jobs where boss_job_id = $1 and status in ('succeeded', 'failed', 'cancelled')", [bossJobId]))[0] ?? null, { timeoutMs: 60_000 });
  };
  const checkRun = await runJob('social.check', { connectionId: conn.id, reason: 'manual' });
  check(checkRun.status === 'succeeded' && /switched off on this server/.test(checkRun.message), 'a Zernio check run with the flag off does nothing', `${checkRun.status}: ${checkRun.message}`);
  const pollRun = await runJob('publish.poll', { targetId: facts.postC.targetId, postId: facts.postC.postId, projectId: facts.projectId, pollNo: 0 });
  check(pollRun.status === 'succeeded', 'a Zernio read with the flag off finishes without calling', `${pollRun.status}: ${pollRun.message}`);
  const postC = (await q('select status, published_url from publish_targets where id = $1', [facts.postC.targetId]))[0];
  check(postC.status === 'published', 'post C stays posted', postC.status);
  const fake = await fakeState();
  check(fake.total === 0, 'the fake Zernio recorded zero requests with the flag off', JSON.stringify(fake.counts));
  await context.close();
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (!CONTROL_URL || !FAKE_ZERNIO_URL || !DATABASE_URL || !WEBHOOK_SECRET) throw new Error('E2E_FAKE_CONTROL_URL, E2E_FAKE_ZERNIO_URL, E2E_DATABASE_URL and E2E_ZERNIO_WEBHOOK_SECRET are required (run apps/web/e2e/run-stage-c-tiktok.sh).');
  if (PHASE === 'on') for (const c of CLIPS) if (!existsSync(path.join(SAMPLES, c.file))) throw new Error(`Missing ${c.file} in ${SAMPLES}. Run: bash scripts/make-sample-footage.sh data/samples`);
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
      const ctx = await launched.newContext(options);
      ctx.setDefaultTimeout(30_000);
      return ctx;
    },
  };
  const consoleErrors = carried?.consoleErrors ?? [];
  const watch = (p) => {
    p.on('pageerror', (err) => consoleErrors.push({ phase: PHASE, text: `pageerror: ${err.message}`, url: '' }));
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ phase: PHASE, text: `console: ${msg.text()}`, url: msg.location()?.url ?? '' });
    });
    pages.push(p);
  };
  const pages = [];
  let stoppedEarly = false;
  try {
    if (PHASE === 'setup') await setupPhase({ browser, q, watch });
    else if (PHASE === 'on') await onPhase({ browser, q, watch });
    else await offPhase({ browser, q, watch });
  } catch (err) {
    stoppedEarly = true;
    failures.push(`[${PHASE}] stopped early: ${err instanceof Error ? err.message : String(err)}`);
    log(`STOPPED: ${err instanceof Error ? err.stack : String(err)}`);
    const open = pages.filter((p) => !p.isClosed()).pop();
    if (open) await failureScreenshot(open, 'stopped');
  } finally {
    await launched.close();
    await db.end();
  }

  const elapsedMs = elapsedBefore + (Date.now() - started);
  if (PHASE !== 'off' && !stoppedEarly) {
    writeFileSync(STATE_FILE, JSON.stringify({ passes, failures, consoleErrors, facts, elapsedMs }));
    console.log(`Phase ${PHASE}: ${passes.length} checks passed, ${failures.length} failed so far; continuing with the next phase.`);
    process.exit(0);
  }

  // Console (every phase). No error is caused on purpose in this test: the refusals are checked through the API.
  const unexpected = consoleErrors.filter((e) => !abortedLoadWeIgnore(e));
  const ignored = consoleErrors.filter(abortedLoadWeIgnore);
  if (ignored.length) log(`  (ignored ${ignored.length} cancelled media or prefetch loads)`);
  if (!stoppedEarly) check(unexpected.length === 0, 'no page errors or console errors in any phase', unexpected.slice(0, 5).map((e) => `[${e.phase}] ${e.text} ${e.url}`).join(' | '));

  console.log('');
  console.log(`${passes.length} checks passed, ${failures.length} failed in ${(elapsedMs / 1000).toFixed(0)} s`);
  for (const f of failures) console.log(`  - ${f}`);
  if (consoleErrors.length) {
    console.log('Browser console errors seen:');
    for (const e of consoleErrors.slice(0, 20)) console.log(`  [${e.phase}] ${e.text} ${e.url}`);
  }
  process.exit(failures.length ? 1 : 0);
}

await main();
