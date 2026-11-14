#!/usr/bin/env node
/**
 * Stage B end-to-end check in a real browser (Chromium through Playwright), on synthetic footage plus a local fake of
 * Meta: music licence → export gates → publish manually and (against the fake) to Instagram → learned preferences
 * visible → trends labelled (docs/design/stage-bc-plan.md, "Stage B acceptance (after WP5)").
 *
 * It drives the running web app and worker the way the owner would and checks real outcomes in the app. The database
 * is read only where the UI cannot show something (the `music_usage` ledger, `feedback_events`, the stored Instagram
 * media id and the jobs table for the duplicate run); the fake is read through its `GET /__fake/state`.
 *
 * Needs a web app and a worker that share one database and storage folder, both started with NODE_ENV=test and
 * META_GRAPH_BASE_URL / META_RUPLOAD_BASE_URL / META_DIALOG_BASE_URL pointing at apps/web/e2e/fake-meta.ts.
 * `bash apps/web/e2e/run-stage-b.sh` sets all of that up and tears it down again.
 *
 * Settings (environment variables):
 *   E2E_BASE_URL        web app address                    (default http://localhost:3500)
 *   E2E_FAKE_META_URL   the fake Meta server               (required)
 *   E2E_DATABASE_URL    the app's database                 (required; read-only queries, plus the duplicate-job helper)
 *   E2E_SAMPLES_DIR     synthetic footage                  (default <repo>/data/samples)
 *   E2E_OUT_DIR         downloads and failure screenshots  (default <os tmp>/studio-e2e-b)
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD                   (default e2e-owner@example.com / a fixed test password)
 *   FFPROBE_PATH        ffprobe binary                     (default ffprobe)
 *
 * Exit code 0 when every check passed, 1 otherwise. Plain node + playwright + pg; no test runner.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3500').replace(/\/$/, '');
const FAKE_META_URL = (process.env.E2E_FAKE_META_URL ?? '').replace(/\/$/, '');
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const SAMPLES = process.env.E2E_SAMPLES_DIR ?? path.join(REPO_ROOT, 'data', 'samples');
const OUT_DIR = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'studio-e2e-b');
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@example.com';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'clipper guard number two';
const OWNER_NAME = 'E2E Owner';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const TSX = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'tsx');
const DESKTOP = { width: 1600, height: 1000 };
const TARGET_SEC = 12;
const PROJECT_TITLE = 'E2E Stage B';

const CLIPS = [
  { file: 'sample_a_portrait_sdr.mp4', tag: 'Cutting' },
  { file: 'sample_b_rotated_hevc_hlg.mov', tag: 'Before' },
  { file: 'sample_c_noaudio_scenes.mp4', tag: 'Result' },
];
const MUSIC_FILE = 'sample_music_120bpm.mp3';
const UNSURE_TRACK = 'E2E click track';
const META_TRACK = 'E2E Sound Collection track';
const HASHTAG = 'skinfade';
/** Words that would claim popularity; none may appear on our own trend labels (the YouTube chart's own name aside). */
const POPULARITY_WORDS = /trending|viral|popular|blowing up|hot right now|top performing/i;

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

/** Polls `fn` until it returns a truthy value or the time runs out. */
async function waitFor(description, fn, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
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
    const file = path.join(OUT_DIR, `failure-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`  saved ${file}`);
  } catch {
    // The page may already be closed; the failure itself is what matters.
  }
}

/** Fires dragenter/dragover/drop with real File objects on the upload zone (as in the Stage A test). */
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

async function apiGet(page, urlPath) {
  const res = await page.request.get(`${BASE_URL}${urlPath}`);
  if (!res.ok()) throw new Error(`${urlPath} answered ${res.status()}`);
  return res.json();
}

const getStatus = (page, projectId) => apiGet(page, `/api/projects/${projectId}/status`);

async function ffprobeJson(file) {
  const { stdout } = await execFileAsync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}

function editCards(page) {
  return page.locator('section[aria-labelledby="previews-heading"] > ul > li');
}

function cardFor(page, styleName) {
  return editCards(page).filter({ has: page.getByRole('heading', { level: 3, name: styleName, exact: true }) });
}

/** The version the card currently shows. */
function currentVersion(status, styleName) {
  const edit = status.generations[0].edits.find((e) => e.styleName === styleName);
  return edit.versions.find((v) => v.id === edit.currentVersionId) ?? edit.versions[0];
}

async function saveDownload(page, trigger, name) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  const saved = path.join(OUT_DIR, `${name}-${download.suggestedFilename()}`);
  await download.saveAs(saved);
  log(`  saved ${saved}`);
  return { file: saved, suggested: download.suggestedFilename() };
}

async function fakeState() {
  const res = await fetch(`${FAKE_META_URL}/__fake/state`);
  if (!res.ok) throw new Error(`fake Meta answered ${res.status}`);
  return res.json();
}

/** Visible text of a locator with whitespace collapsed. */
async function textOf(locator) {
  return ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();
}

async function createProject(page, title) {
  await page.goto(`${BASE_URL}/studio`);
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByLabel('Project name').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: /Create/ }).click();
  await page.waitForURL(/\/studio\/[^/]+$/, { timeout: 30_000 });
  const projectId = new URL(page.url()).pathname.split('/').pop();
  await page.getByText('Drop your haircut clips here to start').waitFor();
  return projectId;
}

async function openSettings(page, tab) {
  await page.goto(`${BASE_URL}/settings?tab=${tab}`);
  await page.getByRole('tab', { selected: true }).waitFor({ timeout: 30_000 });
}

/** Uploads a track through "Upload licensed track" in Settings → Music library with the given passport choices. */
async function uploadTrack(page, { title, kindLabel, step2, analysed = true }) {
  await openSettings(page, 'music');
  await page.getByRole('button', { name: 'Upload licensed track' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles(path.join(SAMPLES, MUSIC_FILE));
  await dialog.getByLabel('Track title').fill(title);
  await dialog.getByLabel(kindLabel, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByText('Step 2 of 3').waitFor();
  if (step2) await step2(dialog);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByText('Step 3 of 3').waitFor();
  await dialog.getByRole('checkbox', { name: /I confirm the business holds the rights/ }).check();
  await dialog.getByRole('button', { name: 'Upload track' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
  if (!analysed) return null;
  const track = await waitFor(
    `the track "${title}" to be analysed`,
    async () => {
      const { tracks } = await apiGet(page, '/api/music');
      const t = tracks.find((x) => x.title === title);
      if (t?.status === 'failed') throw new Error(`analysis failed: ${t.statusMessage}`);
      return t?.status === 'ready' ? t : null;
    },
    { timeoutMs: 180_000, intervalMs: 2000 },
  );
  return track;
}

/** The row of a track in Settings → Music library. */
function trackRow(page, title) {
  return page.locator('li', { has: page.getByText(title, { exact: true }) }).filter({ has: page.getByRole('button', { name: `Licence details for ${title}` }) });
}

/** Opens the composer for the given version ids (or none) and waits until it has loaded. */
async function openComposer(page, versionIds) {
  await page.goto(`${BASE_URL}/publishing/new${versionIds.length ? `?versions=${versionIds.join(',')}` : ''}`);
  if (versionIds.length) await page.getByRole('button', { name: /^Review \d/ }).waitFor({ timeout: 30_000 });
}

/** A Card (components/ui/card.tsx) by its title. */
function cardByTitle(page, title) {
  return page.locator('div[class*="radius-card"]', { has: page.getByRole('heading', { level: 2, name: title, exact: true }) }).last();
}

/** One video's card in the composer. */
function composerCard(page, styleName) {
  return cardByTitle(page, `${PROJECT_TITLE} · ${styleName}`);
}

function platformSwitch(scope, platform) {
  return scope.getByRole('switch', { name: new RegExp(`^${platform} ·`) });
}

/** The bordered box of one platform in a composer card. */
function platformBox(scope, platform) {
  return scope.locator('div.rounded-xl.border', { has: scope.page().getByRole('switch', { name: new RegExp(`^${platform} ·`) }) });
}

async function getPost(page, postId) {
  return apiGet(page, `/api/publish-posts/${postId}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  if (!FAKE_META_URL || !DATABASE_URL) throw new Error('E2E_FAKE_META_URL and E2E_DATABASE_URL are required (run apps/web/e2e/run-stage-b.sh).');
  for (const f of [...CLIPS.map((c) => c.file), MUSIC_FILE]) if (!existsSync(path.join(SAMPLES, f))) throw new Error(`Missing ${f} in ${SAMPLES}. Run: bash scripts/make-sample-footage.sh data/samples`);
  const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`The web app at ${BASE_URL} is not healthy (${JSON.stringify(health)}). Start it and the worker first.`);
  await fakeState();

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (text, params = []) => (await db.query(text, params)).rows;

  const browser = await chromium.launch();
  /** Every page error and console error, with the address of the resource when the browser gives one. */
  const consoleErrors = [];
  /** Console errors this test causes on purpose (each must actually appear, and is listed at the end). */
  const expectedErrors = [];
  const expectError = (pattern, why) => expectedErrors.push({ pattern, why, seen: 0 });
  const watch = (p) => {
    p.on('pageerror', (err) => consoleErrors.push({ text: `pageerror: ${err.message}`, url: '' }));
    p.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ text: `console: ${msg.text()}`, url: msg.location()?.url ?? '' });
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
    const context = await browser.newContext({ viewport: DESKTOP, acceptDownloads: true });
    page = await context.newPage();
    watch(page);
    await page.goto(`${BASE_URL}/studio`);
    await page.waitForURL(/\/login/);
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.waitForURL(/\/studio$/, { timeout: 30_000 });
    check(true, 'owner signed in');

    // ---- 1. Honest states before anything is connected. ------------------------------------------------------
    log('Integrations before connecting');
    await openSettings(page, 'integrations');
    const igSection = page.locator('section', { has: page.getByRole('heading', { name: 'Instagram direct publishing' }) });
    await igSection.getByRole('link', { name: 'Connect Instagram' }).waitFor({ timeout: 30_000 });
    const igText = await textOf(igSection);
    check(!/\bConnected\b/.test(igText) && !/@ivanhoe_studio_test/.test(igText), 'Instagram shows "Connect Instagram", not connected, before the owner connects it', igText.slice(0, 160));
    await openSettings(page, 'trends');
    const youtube = page.locator('section[aria-labelledby="source-youtube_chart"]');
    await youtube.waitFor({ timeout: 30_000 });
    check((await youtube.getByText('Needs setup', { exact: true }).count()) > 0, 'YouTube chart without a key shows "Needs setup"');
    const hashtagSection = page.locator('section[aria-labelledby="source-instagram_hashtag"]');
    const hashtagBefore = await textOf(hashtagSection);
    check(/Connect Instagram/.test(hashtagBefore) && (await hashtagSection.getByLabel('Hashtag to watch (without #)').count()) === 0, 'hashtag watch asks for Instagram to be connected first', hashtagBefore.slice(0, 160));

    // ---- 2a. Music library: a track whose origin is "I'm not sure". ------------------------------------------
    log(`Upload "${UNSURE_TRACK}" with "I'm not sure"`);
    await openSettings(page, 'music');
    await page.getByRole('button', { name: 'Upload licensed track' }).first().click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel("I'm not sure", { exact: true }).check();
      check((await dialog.getByText('Exports with this track are blocked until you confirm a licence.').count()) === 1, 'passport warns that "I\'m not sure" blocks exports');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    // Uploads are kept against a project, so with no project yet the library says what to do instead of failing silently.
    expectError(/status of 409.*\/api\/music\/uploads|\/api\/music\/uploads.*409/, 'music upload refused before any project exists (POST /api/music/uploads → 409)');
    await uploadTrack(page, { title: UNSURE_TRACK, kindLabel: "I'm not sure", analysed: false });
    const noProject = page.getByText('Create a project in the Video Studio first, then you can upload music here or from the project page.');
    await noProject.first().waitFor({ timeout: 15_000 });
    check(true, 'with no project yet, the music upload explains that a project is needed first');
    check((await q('select count(*)::int as n from music_tracks'))[0].n === 0, 'nothing was stored for the refused upload');
    const projectId = await createProject(page, PROJECT_TITLE);
    const unsure = await uploadTrack(page, { title: UNSURE_TRACK, kindLabel: "I'm not sure" });
    check(unsure.licence.kind === 'unknown' && unsure.licenceState === 'not_confirmed', 'the "I\'m not sure" track is stored as not confirmed', `${unsure.licence.kind} / ${unsure.licenceState}`);
    check(Math.round(unsure.bpm ?? 0) === 120, 'the click track was analysed at 120 BPM', String(unsure.bpm));
    await openSettings(page, 'music');
    const unsureRow = trackRow(page, UNSURE_TRACK);
    await unsureRow.waitFor({ timeout: 30_000 });
    const unsureText = await textOf(unsureRow);
    check(/Not confirmed/.test(unsureText) && /Origin not recorded/.test(unsureText) && !/Licence confirmed/.test(unsureText), 'its library row says "Not confirmed" and "Origin not recorded"', unsureText.slice(0, 200));

    // ---- 2b. CC BY-NC is refused in the passport. ----------------------------------------------------------
    log('CC BY-NC is refused');
    await page.getByRole('button', { name: 'Upload licensed track' }).first().click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.locator('input[type="file"]').setInputFiles(path.join(SAMPLES, MUSIC_FILE));
      await dialog.getByLabel('Creative Commons non-commercial (CC BY-NC)', { exact: true }).check();
      const refusal = dialog.getByRole('alert');
      await refusal.waitFor();
      check(/Non-commercial licences don't cover promoting a business, so this track can't be added\./.test(await textOf(refusal)), 'CC BY-NC shows the refusal', await textOf(refusal));
      check(await dialog.getByRole('button', { name: 'Next' }).isDisabled(), 'CC BY-NC cannot go on to the next step');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    const trackCount = await q('select count(*)::int as n from music_tracks where deleted_at is null');
    check(trackCount[0].n === 1, 'nothing was uploaded for the CC BY-NC choice', `${trackCount[0].n} tracks`);

    // ---- 3. A project with the unsure track: five previews. --------------------------------------------------
    log('Project with the unsure track');
    await page.goto(`${BASE_URL}/studio/${projectId}`);
    await page.getByText('Drop your haircut clips here to start').waitFor();
    await dropFiles(page, CLIPS.map((c) => path.join(SAMPLES, c.file)));
    await waitFor(
      'all three clips to be ready',
      async () => {
        const s = await getStatus(page, projectId);
        const failed = s.assets.filter((a) => a.status === 'failed');
        if (failed.length) throw new Error(`clip analysis failed: ${failed.map((a) => `${a.filename}: ${a.statusMessage}`).join('; ')}`);
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
    const musicSelect = page.getByLabel('Music', { exact: true });
    await waitFor('the track in the Music list', async () => (await musicSelect.locator(`option[value="${unsure.id}"]`).count()) === 1, { timeoutMs: 30_000 });
    await musicSelect.selectOption(unsure.id);
    const musicNote = await textOf(musicSelect.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]'));
    check(/Not confirmed/.test(musicNote) && !/Licence confirmed/.test(musicNote), 'the Studio says the chosen track is not confirmed', musicNote.slice(0, 200));
    await page.getByRole('button', { name: 'Generate 5 edits' }).click();
    const generated = await waitFor(
      'five previews',
      async () => {
        const s = await getStatus(page, projectId);
        const g = s.generations[0];
        if (!g) return null;
        const versions = g.edits.map((e) => e.versions.find((v) => v.id === e.currentVersionId) ?? e.versions[0]);
        const bad = versions.filter((v) => v && (v.status === 'failed' || v.status === 'cancelled'));
        if (bad.length) throw new Error(`a preview failed: ${bad.map((v) => v.statusMessage).join('; ')}`);
        return g.edits.length === 5 && versions.every((v) => v?.status === 'preview_ready') ? s : null;
      },
      { timeoutMs: 480_000, intervalMs: 2000 },
    );
    await waitFor('five preview players', async () => (await editCards(page).locator('video').count()) === 5, { timeoutMs: 30_000 });
    const styleNames = generated.generations[0].edits.map((e) => e.styleName);
    const [exportName, metaName, igName, favName4, favName5] = styleNames;
    const plans = await q('select ev.id, ev.plan from edit_versions ev join edits e on e.id = ev.edit_id where e.project_id = $1', [projectId]);
    check(plans.length === 5 && plans.every((r) => r.plan?.audio?.music?.trackId === unsure.id), 'all five plans use the unsure track', plans.map((r) => r.plan?.audio?.music?.trackId ?? 'none').join(', '));

    // ---- 4. Export gates. -------------------------------------------------------------------------------------
    log(`Export gates on "${exportName}"`);
    const exportCard = cardFor(page, exportName);
    const banner = exportCard.getByText('Music licence not confirmed — previews only');
    await banner.waitFor({ timeout: 30_000 });
    check(true, 'the card says the music licence is not confirmed and previews only');
    check((await exportCard.getByText(/Where this track came from hasn't been recorded/).count()) > 0, 'the card gives the reason (origin not recorded)');
    const v1 = currentVersion(generated, exportName);
    expectError(/status of 409.*\/api\/edit-versions\/[^/ ]+\/export/, `export refused for unconfirmed music (POST /api/edit-versions/${v1.id}/export)`);
    await exportCard.getByRole('button', { name: 'Export full quality' }).click();
    const refusalToast = page.getByRole('alert').filter({ hasText: 'Could not start the export' });
    await refusalToast.waitFor({ timeout: 15_000 });
    const refusalText = await textOf(refusalToast);
    check(/isn't cleared for business use/.test(refusalText) && /music-free version/.test(refusalText), 'the export is refused with the licence message', refusalText);
    const afterRefusal = await getStatus(page, projectId);
    check(currentVersion(afterRefusal, exportName).exportStatus === 'none' && afterRefusal.jobs.every((j) => j.type !== 'render.export'), 'no export was started for the refused version');

    log('Music-free version');
    await exportCard.getByRole('button', { name: 'Make a music-free version' }).first().click();
    const musicFreeButton = exportCard.getByRole('button', { name: 'Music-free version' });
    await musicFreeButton.waitFor({ timeout: 300_000 });
    const noMusic = await saveDownload(page, () => musicFreeButton.click(), 'no-music');
    const noMusicProbe = await ffprobeJson(noMusic.file);
    const v1Plan = plans.find((r) => r.id === v1.id)?.plan;
    const clipSound = Boolean(v1Plan?.audio?.originalSound?.enabled);
    const nmVideo = noMusicProbe.streams.find((s) => s.codec_type === 'video');
    const nmAudio = noMusicProbe.streams.filter((s) => s.codec_type === 'audio');
    check(nmVideo?.width === 1080 && nmVideo?.height === 1920, 'the music-free file is 1080x1920', `${nmVideo?.width}x${nmVideo?.height}`);
    check(
      clipSound ? nmAudio.length <= 1 : nmAudio.length === 0,
      clipSound ? 'the music-free file has at most the clips’ own sound' : 'the music-free file has no audio stream',
      `${nmAudio.length} audio streams, original sound ${clipSound ? 'on' : 'off'}`,
    );
    check(/no-music|music-free/i.test(noMusic.suggested), 'the music-free download is named as such', noMusic.suggested);
    check((await q('select count(*)::int as n from music_usage where edit_version_id = $1', [v1.id]))[0].n === 0, 'no music_usage row for a refused or music-free export');

    log('Confirm the licence (own recording)');
    await openSettings(page, 'music');
    await trackRow(page, UNSURE_TRACK).getByRole('button', { name: `Licence details for ${UNSURE_TRACK}` }).click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('I made it, or I own the recording', { exact: true }).check();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByText('Step 2 of 3').waitFor();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByText('Step 3 of 3').waitFor();
      const rights = dialog.getByRole('checkbox', { name: /I confirm the business holds the rights/ });
      if (!(await rights.isChecked())) await rights.check();
      await dialog.getByRole('button', { name: 'Save licence details' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }
    await page.getByRole('status').filter({ hasText: 'Licence confirmed' }).first().waitFor({ timeout: 15_000 });
    await page.reload();
    const confirmedText = await textOf(trackRow(page, UNSURE_TRACK));
    check(/Licence confirmed/.test(confirmedText) && /Own recording/.test(confirmedText) && /Rights confirmed:/.test(confirmedText), 'the track now shows "Licence confirmed" and "Own recording"', confirmedText.slice(0, 200));

    log(`Standard export of "${exportName}"`);
    await page.goto(`${BASE_URL}/studio/${projectId}`);
    await cardFor(page, exportName).waitFor({ timeout: 30_000 });
    await waitFor('the licence banner to clear', async () => (await cardFor(page, exportName).getByText('Music licence not confirmed — previews only').count()) === 0, { timeoutMs: 30_000 });
    await cardFor(page, exportName).getByRole('button', { name: 'Export full quality' }).click();
    const downloadButton = cardFor(page, exportName).getByRole('button', { name: /^Download/ });
    await downloadButton.waitFor({ timeout: 300_000 });
    const standard = await saveDownload(page, () => downloadButton.click(), 'standard');
    const standardProbe = await ffprobeJson(standard.file);
    const sv = standardProbe.streams.find((s) => s.codec_type === 'video');
    const sa = standardProbe.streams.find((s) => s.codec_type === 'audio');
    check(sv?.width === 1080 && sv?.height === 1920 && sv?.codec_name === 'h264', 'the standard export is 1080x1920 H.264', `${sv?.width}x${sv?.height} ${sv?.codec_name}`);
    check(sa?.codec_name === 'aac' && sa?.channels === 2, 'the standard export carries the music (AAC stereo)', `${sa?.codec_name} ${sa?.channels}ch`);
    const usage = await q("select purpose, platform, licence_snapshot->>'kind' as kind from music_usage where edit_version_id = $1", [v1.id]);
    check(usage.length === 1 && usage[0].purpose === 'export' && usage[0].platform === '' && usage[0].kind === 'owner_upload', 'one music_usage row for the export, with the confirmed licence', JSON.stringify(usage));

    // ---- 5. Learned preferences (favourites and a download). ---------------------------------------------------
    log('Favourites for preference learning');
    for (const name of [exportName, favName4, favName5]) {
      const card = cardFor(page, name);
      await card.getByRole('button', { name: `Mark ${name} as a favourite` }).click();
      await card.getByRole('button', { name: `Remove ${name} from favourites` }).waitFor({ timeout: 15_000 });
    }
    const feedback = await waitFor('three favourite events', async () => {
      const rows = await q("select type, count(*)::int as n from feedback_events group by type");
      const by = Object.fromEntries(rows.map((r) => [r.type, r.n]));
      return (by.favourite ?? 0) >= 3 ? by : null;
    }, { timeoutMs: 20_000, intervalMs: 500 });
    check(feedback.favourite === 3 && (feedback.download ?? 0) >= 1, 'feedback recorded: 3 favourites and the download', JSON.stringify(feedback));

    // ---- 6. Meta Sound Collection track: never TikTok as standard. --------------------------------------------
    log(`Upload "${META_TRACK}" from Meta Sound Collection`);
    const metaTrack = await uploadTrack(page, { title: META_TRACK, kindLabel: "Meta Sound Collection (downloaded with the business's Meta login)" });
    check(metaTrack.licenceState === 'meta_only' && metaTrack.licence.permitted.tiktok === false, 'the Sound Collection track is locked to Instagram and Facebook', `${metaTrack.licenceState}, tiktok ${metaTrack.licence.permitted.tiktok}`);
    await page.goto(`${BASE_URL}/studio/${projectId}`);
    const metaCard = cardFor(page, metaName);
    await metaCard.getByRole('button', { name: 'Sound' }).click();
    {
      const dialog = page.getByRole('dialog');
      const trackSelect = dialog.getByLabel('Track', { exact: true });
      await waitFor('the Sound Collection track in the Sound panel', async () => (await trackSelect.locator(`option[value="${metaTrack.id}"]`).count()) === 1, { timeoutMs: 30_000 });
      await trackSelect.selectOption(metaTrack.id);
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }
    const withMeta = await waitFor(
      'the Sound Collection version',
      async () => {
        const s = await getStatus(page, projectId);
        const v = currentVersion(s, metaName);
        if (v.status === 'failed') throw new Error(`re-cut failed: ${v.statusMessage}`);
        return v.versionNo === 2 && v.status === 'preview_ready' ? v : null;
      },
      { timeoutMs: 240_000, intervalMs: 2000 },
    );
    const metaPlan = (await q('select plan from edit_versions where id = $1', [withMeta.id]))[0]?.plan;
    check(metaPlan?.audio?.music?.trackId === metaTrack.id, `"${metaName}" v2 uses the Sound Collection track`);
    await openComposer(page, [withMeta.id]);
    {
      const card = composerCard(page, metaName);
      check((await platformSwitch(card, 'Instagram').getAttribute('aria-checked')) === 'false' && (await platformSwitch(card, 'TikTok').getAttribute('aria-checked')) === 'false', 'the composer starts with Instagram and TikTok switched off');
      await platformSwitch(card, 'TikTok').click();
      const tiktok = platformBox(card, 'TikTok');
      const withMusic = tiktok.getByRole('radio', { name: /With music/ });
      const withoutMusic = tiktok.getByRole('radio', { name: /Without music/ });
      check((await withMusic.isDisabled()) && (await withoutMusic.isChecked()), 'TikTok does not offer the Meta-only music as standard; "Without music" is chosen', `with music disabled ${await withMusic.isDisabled()}, without checked ${await withoutMusic.isChecked()}`);
      check(/Will post without music:/.test(await textOf(tiktok)), 'TikTok explains it will post without music');
      await platformSwitch(card, 'Instagram').click();
      const instagram = platformBox(card, 'Instagram');
      check(!(await instagram.getByRole('radio', { name: /With music/ }).isDisabled()) && /For Instagram\/Facebook upload only/.test(await textOf(instagram)), 'Instagram may use it, labelled "For Instagram/Facebook upload only"');
    }

    // ---- 7. Publishing, manual ("Post it yourself"). -----------------------------------------------------------
    log(`Manual post of "${exportName}" to Instagram`);
    await openComposer(page, []);
    check((await page.getByText('Choose the edits to publish. Nothing is picked for you.').count()) === 1, 'the composer starts empty: nothing is picked');
    await page.getByRole('button', { name: 'Choose edits' }).click();
    const pickerBoxes = page.locator('input[type="checkbox"]');
    await waitFor('the edit picker', async () => (await pickerBoxes.count()) >= 5, { timeoutMs: 15_000 });
    const tickedAtStart = await pickerBoxes.evaluateAll((els) => els.filter((e) => e.checked).length);
    check(tickedAtStart === 0, 'no edit is ticked in the picker', `${tickedAtStart} ticked of ${await pickerBoxes.count()}`);
    await page.locator('label', { hasText: `${PROJECT_TITLE} · ${exportName}` }).filter({ hasText: 'Version 1' }).locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Done' }).click();
    const manualCard = composerCard(page, exportName);
    await platformSwitch(manualCard, 'Instagram').waitFor({ timeout: 15_000 });
    check((await platformSwitch(manualCard, 'Instagram').getAttribute('aria-checked')) === 'false', 'the chosen edit starts with Instagram off');
    await platformSwitch(manualCard, 'Instagram').click();
    const igBox = platformBox(manualCard, 'Instagram');
    await igBox.getByRole('radio', { name: 'Post it yourself' }).check();
    await igBox.getByRole('radio', { name: /With music/ }).check();
    const manualCaption = 'Fresh skin fade at the studio. E2E manual post.';
    await manualCard.getByLabel('Caption').fill(manualCaption);
    await page.getByRole('button', { name: 'Review 1 video' }).click();
    await page.getByText('This is exactly what will be posted.').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Post now/ }).click();
    await page.waitForURL(/\/publishing$/, { timeout: 30_000 });
    const manualPost = (await q('select p.id from publish_posts p where p.edit_version_id = $1 and p.approved_at is not null', [v1.id]))[0];
    check(Boolean(manualPost), 'the manual post was approved');
    await page.goto(`${BASE_URL}/publishing/${manualPost.id}`);
    const manualTarget = page.locator('div.rounded-xl.border', { has: page.getByText(/^Instagram · /) }).filter({ has: page.getByText(/Post it yourself/) }).first();
    await manualTarget.getByRole('link', { name: /Download video/ }).waitFor({ timeout: 30_000 });
    const beforeConfirm = await textOf(manualTarget);
    check(/Your turn/.test(beforeConfirm) && !/Posted/.test(beforeConfirm), 'before confirming, the destination is "Your turn", not posted', beforeConfirm.slice(0, 200));
    const beforeRows = await q("select (select count(*)::int from feedback_events where type = 'publish') as fb, (select count(*)::int from music_usage where purpose = 'publish') as mu");
    check(beforeRows[0].fb === 0 && beforeRows[0].mu === 0, 'nothing is recorded as published before the owner confirms', JSON.stringify(beforeRows[0]));
    const manualFile = await saveDownload(page, () => manualTarget.getByRole('link', { name: /Download video/ }).click(), 'manual');
    const manualProbe = await ffprobeJson(manualFile.file);
    const mv = manualProbe.streams.find((s) => s.codec_type === 'video');
    check(mv?.width === 1080 && mv?.height === 1920 && manualProbe.streams.some((s) => s.codec_type === 'audio'), 'the manual download is the 1080x1920 file with its music', `${mv?.width}x${mv?.height}`);
    const media = await page.evaluate(async (id) => (await fetch(`/api/publish-targets/${id}/media`)).json(), (await q('select id from publish_targets where post_id = $1', [manualPost.id]))[0].id);
    check(typeof media.caption === 'string' && media.caption.startsWith(manualCaption), 'the caption to copy is the one written in the composer', media.caption);
    await manualTarget.getByRole('button', { name: "I've posted it" }).click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Mark as posted' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }
    await manualTarget.getByText('Posted (you confirmed)').first().waitFor({ timeout: 15_000 });
    check(/confirmed by E2E Owner/.test(await textOf(manualTarget)), 'after "I\'ve posted it" the destination shows "Posted (you confirmed)"');
    const afterManual = await q("select (select count(*)::int from feedback_events where type = 'publish' and edit_version_id = $1) as fb, (select count(*)::int from music_usage where purpose = 'publish' and platform = 'instagram' and edit_version_id = $1) as mu", [v1.id]);
    check(afterManual[0].fb === 1 && afterManual[0].mu === 1, 'the confirmation records one publish event and one music_usage row', JSON.stringify(afterManual[0]));

    // ---- 8. Instagram direct against the fake. ------------------------------------------------------------------
    log('Connect Instagram through the login dialog (fake Meta)');
    await openSettings(page, 'integrations');
    await page.getByRole('link', { name: 'Connect Instagram' }).click();
    await page.waitForURL(/\/settings\?tab=integrations/, { timeout: 30_000 });
    const connections = await waitFor(
      'the read-only check to find the Instagram account',
      async () => {
        const c = await apiGet(page, '/api/publishing/connections');
        return c.instagram.connectionStatus === 'connected' && c.instagram.accounts.length === 1 ? c : null;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    check(connections.instagram.accounts[0].username === 'ivanhoe_studio_test', 'the fake account @ivanhoe_studio_test was found', connections.instagram.accounts[0].username);
    const fakeAfterConnect = await fakeState();
    check(fakeAfterConnect.counts.dialog === 1 && fakeAfterConnect.counts.access_token === 1 && (fakeAfterConnect.counts.debug_token ?? 0) >= 1, 'the connect went through the login dialog, one code exchange and the read-only check', JSON.stringify(fakeAfterConnect.counts));
    const conn = (await q("select status, access_token_encrypted from integration_connections where provider = 'meta'"))[0];
    check(conn?.status === 'connected' && Boolean(conn.access_token_encrypted) && !conn.access_token_encrypted.includes('fake-system-user-token'), 'the token is stored encrypted');
    await page.reload();
    await page.getByText('@ivanhoe_studio_test').first().waitFor({ timeout: 30_000 });
    check(true, 'Settings shows the connected account');

    log(`First verification post of "${igName}" to Instagram`);
    const igVersion = currentVersion(await getStatus(page, projectId), igName);
    await openComposer(page, [igVersion.id]);
    const igCard = composerCard(page, igName);
    await platformSwitch(igCard, 'Instagram').click();
    const igDirect = platformBox(igCard, 'Instagram');
    await igDirect.getByRole('radio', { name: /First verification post/ }).check();
    await igDirect.getByRole('radio', { name: /With music/ }).check();
    await igCard.getByLabel('Caption').fill('Clean taper, posted from Studio Assistant. E2E direct post.');
    await page.getByRole('button', { name: 'Review 1 video' }).click();
    await page.getByText('This is exactly what will be posted.').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Post now/ }).click();
    await page.waitForURL(/\/publishing$/, { timeout: 30_000 });
    const igPost = (await q('select id, project_id from publish_posts where edit_version_id = $1 and approved_at is not null', [igVersion.id]))[0];
    const published = await waitFor(
      'the Instagram destination to be published',
      async () => {
        const post = await getPost(page, igPost.id);
        const t = post.targets.find((x) => x.platform === 'instagram');
        if (t?.status === 'failed') throw new Error(`publishing failed: ${t.statusMessage}`);
        return t?.status === 'published' ? { post, target: t } : null;
      },
      { timeoutMs: 420_000, intervalMs: 2000 },
    );
    const fakeAfterPublish = await fakeState();
    const mediaId = fakeAfterPublish.published[0]?.mediaId;
    const igTargetRow = (await q('select id, external_post_id, published_url from publish_targets where post_id = $1', [igPost.id]))[0];
    check(fakeAfterPublish.published.length === 1 && fakeAfterPublish.counts.publish === 1 && (fakeAfterPublish.counts.upload ?? 0) >= 1, 'the worker uploaded the file and published once at the fake', JSON.stringify(fakeAfterPublish.counts));
    check(igTargetRow.external_post_id === mediaId && published.target.publishedUrl === `https://www.instagram.com/reel/R${mediaId}/`, "the destination is published with the fake's media id and permalink", `${igTargetRow.external_post_id} vs ${mediaId}; ${published.target.publishedUrl}`);
    check(fakeAfterPublish.published[0]?.caption.startsWith('Clean taper, posted from Studio Assistant.'), 'the caption reached the fake');
    const igUsage = await q("select count(*)::int as n from music_usage where edit_version_id = $1 and purpose = 'publish' and platform = 'instagram'", [igVersion.id]);
    check(igUsage[0].n === 1, "one music_usage row with purpose 'publish' and platform instagram", String(igUsage[0].n));

    log('A second run of the same destination');
    const { stdout } = await execFileAsync(TSX, [path.join(HERE, 'requeue-job.ts'), igPost.id, igTargetRow.id, igPost.project_id ?? ''], { env: { ...process.env, DATABASE_URL } });
    const { bossJobId } = JSON.parse(stdout.trim().split('\n').pop());
    const secondRun = await waitFor(
      'the second publish.target run to finish',
      async () => (await q("select status, message from jobs where boss_job_id = $1 and status in ('succeeded', 'failed', 'cancelled')", [bossJobId]))[0] ?? null,
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    const fakeAfterSecond = await fakeState();
    check(secondRun.status === 'succeeded' && /Another attempt is already handling/.test(secondRun.message ?? ''), 'the second run claimed nothing', `${secondRun.status}: ${secondRun.message}`);
    check(fakeAfterSecond.published.length === 1 && fakeAfterSecond.counts.publish === 1 && fakeAfterSecond.counts.create === fakeAfterPublish.counts.create, 'nothing was published twice', JSON.stringify(fakeAfterSecond.counts));

    await page.goto(`${BASE_URL}/publishing/${igPost.id}`);
    const igTargetCard = page.locator('div.rounded-xl.border', { has: page.getByText('Instagram · @ivanhoe_studio_test') }).first();
    await igTargetCard.getByRole('link', { name: /View on Instagram/ }).waitFor({ timeout: 30_000 });
    check((await igTargetCard.getByRole('link', { name: /View on Instagram/ }).getAttribute('href')) === `https://www.instagram.com/reel/R${mediaId}/`, 'the post page links to the permalink the fake returned');
    await igTargetCard.getByRole('button', { name: "Yes, it's there" }).click();
    await waitFor('the verification answer', async () => (await q('select capabilities from social_accounts where platform = $1', ['instagram']))[0]?.capabilities?.verifiedDirectAt, { timeoutMs: 15_000, intervalMs: 500 });
    check(true, 'the owner confirmed the verification post');

    // ---- 9. Trends. ---------------------------------------------------------------------------------------------
    log('Trends: curated, noted and the hashtag watch');
    await openSettings(page, 'trends');
    const curatedCard = cardByTitle(page, 'Curated references');
    const curatedRows = curatedCard.locator('ul.divide-y > li');
    await curatedRows.first().waitFor({ timeout: 30_000 });
    const curatedItems = await curatedRows.allInnerTexts();
    const curatedLabels = await curatedRows.locator(':scope > div > div > p:nth-of-type(2)').allInnerTexts();
    const unlabelled = curatedLabels.filter((t) => !/^.+ · last reviewed \d{1,2} \w+ \d{4}$/.test(t.trim()));
    check(curatedLabels.length === curatedItems.length && curatedItems.length > 0 && unlabelled.length === 0, 'every curated reference names its source and when it was last reviewed', `${curatedItems.length} items; unlabelled: ${unlabelled.slice(0, 3).join(' | ')}`);
    const sourced = curatedLabels.filter((t) => !t.startsWith('Editor suggestion')).length;
    const withSources = await curatedRows.filter({ has: page.getByText(/^Sources \(\d+\)$/) }).count();
    check(withSources === sourced, 'every curated reference with a named source lists its source links', `${withSources} of ${sourced}`);
    check(curatedItems.every((t) => !POPULARITY_WORDS.test(t)), 'curated references make no popularity claims');

    await page.getByRole('button', { name: 'Note a trend' }).click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('What did you see?').fill('Slow close-ups of the line-up with no talking');
      await dialog.getByLabel('Describe it (optional)').fill('Seen on a few barber accounts this week.');
      await dialog.getByRole('button', { name: 'Save note' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }
    const notedCard = cardByTitle(page, 'Noted by staff');
    const note = notedCard.locator('li', { hasText: 'Slow close-ups of the line-up with no talking' });
    await note.waitFor({ timeout: 15_000 });
    const noteText = await textOf(note);
    check(new RegExp(`Noted by ${OWNER_NAME} on \\d`).test(noteText) && !POPULARITY_WORDS.test(noteText), 'the note is listed under "Noted by staff" with who noted it and when', noteText.slice(0, 200));

    const hashtagCard = page.locator('section[aria-labelledby="source-instagram_hashtag"]');
    await hashtagCard.getByLabel('Hashtag to watch (without #)').fill(HASHTAG);
    await hashtagCard.getByRole('button', { name: 'Watch' }).click();
    const tagBlock = hashtagCard.locator('div.rounded-lg', { has: page.getByText(`#${HASHTAG}`, { exact: true }) }).first();
    await tagBlock.getByText(/^Fetched /).waitFor({ timeout: 90_000 });
    const heading = await textOf(tagBlock.locator('h4'));
    check(new RegExp(`^Top posts under #${HASHTAG} — Instagram, fetched \\d`).test(heading), 'hashtag posts are labelled as live Instagram signals with the fetch time', heading);
    const rows = tagBlock.locator('ol > li');
    const rowTexts = await rows.allInnerTexts();
    check(rowTexts.length === 3 && rowTexts.every((t) => /posted \d/.test(t) && /as Instagram reported them/.test(t)), 'each post shows its type, date and counts as Instagram reported them', rowTexts.map((t) => t.replace(/\s+/g, ' ')).join(' | '));
    const links = await rows.getByRole('link', { name: /Open on Instagram/ }).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(links.length === 3 && links.every((h) => /^https:\/\/www\.instagram\.com\/p\//.test(h ?? '')), 'posts link to their Instagram permalinks', links.join(', '));
    const hashtagText = await textOf(hashtagCard);
    check(!POPULARITY_WORDS.test(hashtagText), 'the hashtag watch makes no popularity claims', hashtagText.match(POPULARITY_WORDS)?.[0]);
    const fakeAfterHashtag = await fakeState();
    check(fakeAfterHashtag.counts.hashtag_search === 1 && fakeAfterHashtag.counts.top_media === 1, 'one hashtag search and one top_media read at the fake', JSON.stringify(fakeAfterHashtag.counts));

    // ---- 10. Learned preferences in Settings: evidence, "Keep this", reset. ----------------------------------------
    log('Editing preferences: learned values');
    const learnedView = await waitFor(
      'learned values',
      async () => {
        const v = await apiGet(page, '/api/preferences');
        return v.fields?.some((f) => f.source === 'learned') ? v : null;
      },
      { timeoutMs: 60_000, intervalMs: 2000 },
    );
    const learnedFields = learnedView.fields.filter((f) => f.source === 'learned').map((f) => f.field);
    await openSettings(page, 'preferences');
    const learnedCard = cardByTitle(page, 'What the editor has learned');
    const lengthRow = learnedCard.locator('li', { has: page.getByText('Default length', { exact: true }) });
    await lengthRow.waitFor({ timeout: 30_000 });
    const lengthText = await textOf(lengthRow);
    check(learnedFields.includes('defaultDurationSec') && /Learned/.test(lengthText) && /From \d+ favourites?/.test(lengthText), 'Default length shows a learned value with its evidence', lengthText);
    check(/\b10 seconds\b/.test(lengthText), 'the learned length follows the kept 12-second edits (10 seconds after rounding)', lengthText);
    await lengthRow.getByRole('button', { name: 'Keep this' }).click();
    await lengthRow.getByText('Set by you').waitFor({ timeout: 15_000 });
    check((await lengthRow.getByRole('button', { name: 'Let it learn' }).count()) === 1, '"Keep this" pins the value as the owner\'s setting');
    await learnedCard.getByRole('button', { name: 'Reset what it learned' }).click();
    {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }
    await waitFor('learned values to be cleared', async () => {
      const v = await apiGet(page, '/api/preferences');
      return v.fields.every((f) => f.source !== 'learned') ? v : null;
    }, { timeoutMs: 30_000, intervalMs: 1000 });
    await page.reload();
    const afterReset = cardByTitle(page, 'What the editor has learned');
    await afterReset.locator('li').first().waitFor({ timeout: 30_000 });
    const resetText = await textOf(afterReset);
    check((await afterReset.getByText('Learned', { exact: true }).count()) === 0 && /Nothing has been learned yet/.test(resetText), 'after reset nothing is shown as learned', resetText.slice(0, 200));
    check(/Set by you/.test(await textOf(afterReset.locator('li', { has: page.getByText('Default length', { exact: true }) }))), 'the pinned length stays as the owner set it');

    // ---- 11. Console. -------------------------------------------------------------------------------------------
    const unexpected = consoleErrors.filter((e) => {
      const match = expectedErrors.find((x) => x.pattern.test(`${e.text} ${e.url}`));
      if (match) match.seen++;
      return !match && !/net::ERR_ABORTED|net::ERR_FAILED/.test(e.text);
    });
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
