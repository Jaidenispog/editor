#!/usr/bin/env node
/**
 * Stage A end-to-end check in a real browser (Chromium through Playwright).
 *
 * Drives the running web app and worker the way the owner would: first-run setup, sign-in, a new project,
 * dropping three synthetic clips on the upload zone, tagging them, "Generate 5 edits", playing every preview,
 * favouriting, revising one edit to 15 seconds, exporting and downloading a real MP4 (checked with ffprobe),
 * cancelling and retrying an export, reloading the page in the middle of an upload, and the phone layout.
 *
 * It needs a web app and a worker that share one database and storage folder (see apps/web/README.md, "End-to-end
 * browser test"; `bash apps/web/e2e/run-stage-a.sh` sets everything up and tears it down again).
 *
 * Settings (environment variables, all optional):
 *   E2E_BASE_URL        web app address                    (default http://localhost:3100)
 *   E2E_SAMPLES_DIR     synthetic footage                  (default <repo>/data/samples)
 *   E2E_OUT_DIR         downloads and failure screenshots  (default <os tmp>/studio-e2e)
 *   E2E_SCREENSHOT_DIR  key-screen screenshots, PNG @2x    (default: not saved)
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD                   (default e2e-owner@example.com / a fixed test password)
 *   FFPROBE_PATH        ffprobe binary                     (default ffprobe)
 *
 * Exit code 0 when every check passed, 1 otherwise. Plain node + playwright; no test runner.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/** Loads Playwright from the workspace, the global install or NODE_PATH, with a plain message when it is missing. */
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error('Playwright is not installed. Install it with "npm i -g playwright@1.65.0" (and its Chromium), or add it to apps/web.');
    process.exit(2);
  }
}

const { chromium } = loadPlaywright();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const SAMPLES = process.env.E2E_SAMPLES_DIR ?? path.join(REPO_ROOT, 'data', 'samples');
const OUT_DIR = process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'studio-e2e');
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? null;
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? 'e2e-owner@example.com';
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? 'clipper guard number two';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };
const TARGET_SEC = 12;
const REVISED_SEC = 15;
const MAX_SCREENSHOT_BYTES = 600 * 1024;

const CLIPS = [
  { file: 'sample_a_portrait_sdr.mp4', tag: 'Cutting' },
  { file: 'sample_b_rotated_hevc_hlg.mov', tag: 'Before' },
  { file: 'sample_c_noaudio_scenes.mp4', tag: 'Result' },
];

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

/** Saves a viewport screenshot of a key screen, re-encoding it with a 256-colour palette when it is too large. */
async function keyScreenshot(page, name) {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  let { size } = await stat(file);
  if (size > MAX_SCREENSHOT_BYTES) {
    const tmp = `${file}.tmp.png`;
    await execFileAsync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none', '-compression_level', '100', tmp]);
    await rename(tmp, file);
    size = (await stat(file)).size;
  }
  check(size <= MAX_SCREENSHOT_BYTES, `screenshot ${name}.png is under 600 KB`, `${Math.round(size / 1024)} KB`);
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

/** Builds a DataTransfer from local files and fires dragenter/dragover/drop on the upload zone, like a real drop. */
async function dropFiles(page, filePaths) {
  const zone = page.locator('div', { has: page.locator(':scope > p', { hasText: /Drop your haircut clips here|Add more clips/ }) }).last();
  await zone.waitFor();
  // A throwaway file input turns local paths into real File objects inside the page.
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

async function getStatus(page, projectId) {
  const res = await page.request.get(`${BASE_URL}/api/projects/${projectId}/status`);
  if (!res.ok()) throw new Error(`status request answered ${res.status()}`);
  return res.json();
}

/** Loads a preview <video> far enough to show frames and reports what the browser decoded. */
async function probeVideoElement(video) {
  return video.evaluate(
    (v) =>
      new Promise((resolve) => {
        const report = () => resolve({ readyState: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.code : null });
        if (v.readyState >= 2) return report();
        const timer = setTimeout(report, 30_000);
        v.addEventListener('loadeddata', () => (clearTimeout(timer), report()), { once: true });
        v.addEventListener('error', () => (clearTimeout(timer), report()), { once: true });
        v.preload = 'auto';
        v.load();
      }),
  );
}

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

function jobRow(page, label) {
  return page.locator('li', { has: page.getByText(label, { exact: true }) });
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

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const c of CLIPS) if (!existsSync(path.join(SAMPLES, c.file))) throw new Error(`Missing ${c.file} in ${SAMPLES}. Run: bash scripts/make-sample-footage.sh data/samples`);
  const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) throw new Error(`The web app at ${BASE_URL} is not healthy (${JSON.stringify(health)}). Start it and the worker first.`);

  const browser = await chromium.launch();
  const consoleErrors = [];
  const watch = (page) => {
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
    });
  };
  let page;
  try {
    // ---- 1. First-run setup creates the owner, then a fresh browser signs in. --------------------------------
    log('First-run setup');
    const setupContext = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
    const setupPage = await setupContext.newPage();
    watch(setupPage);
    await setupPage.goto(`${BASE_URL}/setup`);
    if (setupPage.url().includes('/setup')) {
      await setupPage.getByLabel('Your name').fill('E2E Owner');
      await setupPage.getByLabel('Email').fill(OWNER_EMAIL);
      await setupPage.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
      await setupPage.getByLabel('Confirm password').fill(OWNER_PASSWORD);
      await setupPage.getByRole('button', { name: 'Create account and sign in' }).click();
      await setupPage.waitForURL((u) => !u.pathname.startsWith('/setup'), { timeout: 30_000 });
      check(true, 'setup created the owner account');
    } else {
      log('  an owner already exists; continuing with sign-in');
    }
    await setupContext.close();

    const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, acceptDownloads: true });
    page = await context.newPage();
    watch(page);
    log('Sign in');
    await page.goto(`${BASE_URL}/studio`);
    await page.waitForURL(/\/login/);
    await page.getByLabel('Email').fill(OWNER_EMAIL);
    await page.getByLabel('Password').fill(OWNER_PASSWORD);
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.waitForURL(/\/studio$/, { timeout: 30_000 });
    check(true, 'signed in and returned to the Video Studio');
    await page.getByRole('button', { name: 'New project' }).first().waitFor();
    await keyScreenshot(page, 'studio-empty');

    // ---- 2. Project, drop three clips, wait for analysis. ----------------------------------------------------
    log('Create project and drop clips');
    const projectId = await createProject(page, 'E2E synthetic test');
    check(Boolean(projectId), 'project "E2E synthetic test" created', projectId);
    await keyScreenshot(page, 'project-empty');
    await dropFiles(page, CLIPS.map((c) => path.join(SAMPLES, c.file)));
    const clipsHeading = page.locator('#clips-heading');
    await clipsHeading.waitFor({ timeout: 60_000 });
    await page.getByText(/Analysing \d clips?…/).waitFor({ timeout: 60_000 }).catch(() => undefined);
    await keyScreenshot(page, 'clips-processing');
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
    await waitFor('three Ready pills in the clip list', async () => (await clipCards.filter({ hasText: 'Ready' }).count()) === 3, { timeoutMs: 30_000 });
    check(true, 'three clips uploaded and analysed');
    const hevcCard = clipCards.filter({ hasText: 'sample_b_rotated_hevc_hlg.mov' });
    check((await hevcCard.getByText('HDR, colour converted', { exact: true }).count()) === 1, 'HEVC HLG clip shows the HDR badge');
    check((await hevcCard.getByText('Rotated', { exact: true }).count()) === 1, 'HEVC HLG clip shows the Rotated badge');
    check((await clipCards.filter({ hasText: 'sample_c_noaudio_scenes.mp4' }).getByText('No sound', { exact: true }).count()) === 1, 'silent clip shows the No sound badge');

    // ---- 3. Tag the clips, set the length, generate. ---------------------------------------------------------
    log('Tag clips and generate');
    for (const c of CLIPS) {
      const card = clipCards.filter({ hasText: c.file });
      const select = card.getByLabel("What's in this clip?");
      await select.selectOption({ label: c.tag });
      await waitFor(`the ${c.tag} tag to save`, async () => (await select.isEnabled()) && (await select.inputValue()) !== '', { timeoutMs: 15_000, intervalMs: 300 });
    }
    const tagged = await getStatus(page, projectId);
    check(
      CLIPS.every((c) => tagged.assets.find((a) => a.filename === c.file)?.clipLabel === c.tag.toLowerCase()),
      'tags Cutting / Before / Result saved',
      tagged.assets.map((a) => `${a.filename}=${a.clipLabel}`).join(', '),
    );
    check(tagged.styles.filter((s) => s.supported).length === 5, 'all five styles available after tagging', tagged.styles.map((s) => `${s.id}:${s.supported}`).join(', '));
    await page.locator('input[type="range"]').fill(String(TARGET_SEC));
    await page.getByText(`${TARGET_SEC} s`, { exact: false }).first().waitFor();
    const generateButton = page.getByRole('button', { name: 'Generate 5 edits' });
    await generateButton.waitFor({ timeout: 15_000 });
    await generateButton.click();

    log('Wait for five previews');
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
      { timeoutMs: 420_000, intervalMs: 2000 },
    );
    const generation = generated.generations[0];
    check(new Set(generation.edits.map((e) => e.styleId)).size === 5, 'five different styles generated', generation.edits.map((e) => e.styleId).join(', '));
    await waitFor('five preview players', async () => (await editCards(page).locator('video').count()) === 5, { timeoutMs: 30_000 });
    const styleNames = generation.edits.map((e) => e.styleName);
    for (const name of styleNames) {
      const info = await probeVideoElement(cardFor(page, name).locator('video'));
      check(
        info.readyState >= 2 && info.error === null && Math.abs(info.duration - TARGET_SEC) <= TARGET_SEC * 0.12 && info.height > info.width,
        `preview "${name}" plays (readyState ≥ 2, ≈ ${TARGET_SEC} s, vertical)`,
        `readyState ${info.readyState}, ${Number(info.duration).toFixed(2)} s, ${info.width}x${info.height}, error ${info.error}`,
      );
    }
    await page.locator('#previews-heading').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -80));
    await keyScreenshot(page, 'five-previews');

    // ---- 4. Favourite one. -----------------------------------------------------------------------------------
    const [favName, reviseName, cancelName] = styleNames;
    log(`Favourite "${favName}"`);
    await cardFor(page, favName).getByRole('button', { name: `Mark ${favName} as a favourite` }).click();
    await cardFor(page, favName).getByRole('button', { name: `Remove ${favName} from favourites` }).waitFor({ timeout: 15_000 });
    const afterFav = await waitFor(
      'the favourite to be saved',
      async () => {
        const s = await getStatus(page, projectId);
        return s.generations[0].edits.find((e) => e.styleName === favName)?.isFavourite === true ? s : null;
      },
      { timeoutMs: 15_000, intervalMs: 500 },
    ).catch(() => null);
    check(afterFav !== null, `"${favName}" saved as a favourite`);
    if (!afterFav) throw new Error('the favourite was not saved');

    // ---- 5. Revise one to 15 seconds; the others must not change. -----------------------------------------------
    log(`Revise "${reviseName}" with "Make this 15 seconds"`);
    const before = afterFav.generations[0].edits;
    const reviseCard = cardFor(page, reviseName);
    await reviseCard.getByRole('button', { name: 'Revise' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Make this 15 seconds' }).click();
    check((await dialog.getByLabel('What should change?').inputValue()) === 'Make this 15 seconds', 'suggestion chip fills the instruction');
    await keyScreenshot(page, 'revise-dialog');
    await dialog.getByRole('button', { name: 'Make this change' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    const revised = await waitFor(
      'the revised version',
      async () => {
        const s = await getStatus(page, projectId);
        const e = s.generations[0].edits.find((x) => x.styleName === reviseName);
        const v2 = e?.versions.find((v) => v.versionNo === 2);
        if (v2 && (v2.status === 'failed' || v2.status === 'cancelled')) throw new Error(`revision failed: ${v2.statusMessage}`);
        return v2?.status === 'preview_ready' && e.currentVersionId === v2.id ? s : null;
      },
      { timeoutMs: 240_000, intervalMs: 2000 },
    );
    const revisedEdit = revised.generations[0].edits.find((e) => e.styleName === reviseName);
    const v2 = revisedEdit.versions.find((v) => v.versionNo === 2);
    const v1 = revisedEdit.versions.find((v) => v.versionNo === 1);
    check(Math.abs((v2.previewDurationSec ?? 0) - REVISED_SEC) <= 1, `v2 is about ${REVISED_SEC} s`, `${v2.previewDurationSec} s`);
    check(v1?.status === 'preview_ready', 'v1 is kept and still ready');
    for (const old of before.filter((e) => e.styleName !== reviseName)) {
      const now = revised.generations[0].edits.find((e) => e.id === old.id);
      const same = now && now.currentVersionId === old.currentVersionId && now.versions.length === old.versions.length && now.versions.every((v, i) => v.id === old.versions[i].id && v.status === old.versions[i].status);
      check(Boolean(same), `"${old.styleName}" unchanged by the revision`);
    }
    const versionSelect = reviseCard.getByLabel('Version', { exact: true });
    await versionSelect.waitFor({ timeout: 20_000 });
    const optionLabels = await versionSelect.locator('option').allTextContents();
    check(optionLabels.length === 2 && optionLabels.some((l) => l.startsWith('v1')) && optionLabels.some((l) => l.startsWith('v2')), 'version switcher lists v1 and v2', optionLabels.join(' | '));
    const v2Info = await probeVideoElement(reviseCard.locator('video'));
    check(v2Info.readyState >= 2 && Math.abs(v2Info.duration - REVISED_SEC) <= 1, 'v2 preview plays at about 15 s', `${v2Info.readyState}, ${Number(v2Info.duration).toFixed(2)} s`);
    await versionSelect.selectOption(v1.id);
    await reviseCard.locator('video[aria-label$="version 1"]').waitFor({ timeout: 20_000 });
    const v1Info = await probeVideoElement(reviseCard.locator('video'));
    check(v1Info.readyState >= 2 && Math.abs(v1Info.duration - TARGET_SEC) <= TARGET_SEC * 0.12, 'v1 is still selectable and plays', `${v1Info.readyState}, ${Number(v1Info.duration).toFixed(2)} s`);
    await versionSelect.selectOption(v2.id);
    await reviseCard.locator('video[aria-label$="version 2"]').waitFor({ timeout: 20_000 });

    // ---- 6. Export, download and inspect the MP4. -------------------------------------------------------------
    log(`Export "${favName}"`);
    const favCard = cardFor(page, favName);
    await favCard.getByRole('button', { name: 'Export full quality' }).click();
    const downloadButton = favCard.getByRole('button', { name: /^Download/ });
    await downloadButton.waitFor({ timeout: 300_000 });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), downloadButton.click()]);
    const savedPath = path.join(OUT_DIR, download.suggestedFilename());
    await download.saveAs(savedPath);
    log(`  saved ${savedPath}`);
    const probe = await ffprobeJson(savedPath);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    const fileDuration = Number(probe.format.duration);
    check(v?.width === 1080 && v?.height === 1920, 'export is 1080x1920', `${v?.width}x${v?.height}`);
    check(v?.codec_name === 'h264' && v?.pix_fmt === 'yuv420p', 'export is H.264 yuv420p', `${v?.codec_name} ${v?.pix_fmt}`);
    check(v?.color_primaries === 'bt709' && v?.color_transfer === 'bt709' && v?.color_space === 'bt709', 'export is tagged BT.709', `${v?.color_primaries}/${v?.color_transfer}/${v?.color_space}`);
    if (a) check(a.codec_name === 'aac' && a.sample_rate === '48000' && a.channels === 2, 'export audio is AAC 48 kHz stereo', `${a.codec_name} ${a.sample_rate} ${a.channels}ch`);
    else log('  (export has no audio stream; the plan used no sound)');
    const favPreview = afterFav.generations[0].edits.find((e) => e.styleName === favName).versions[0].previewDurationSec;
    check(Math.abs(fileDuration - favPreview) <= 0.25 && Math.abs(fileDuration - TARGET_SEC) <= TARGET_SEC * 0.12, 'export length matches the preview', `${fileDuration.toFixed(2)} s vs ${favPreview} s`);
    check(/\.mp4$/.test(download.suggestedFilename()), 'download has a readable .mp4 filename', download.suggestedFilename());

    // ---- 7. Cancel a running export, then retry it. ------------------------------------------------------------
    log(`Cancel and retry the export of "${cancelName}"`);
    const cancelCard = cardFor(page, cancelName);
    await cancelCard.getByRole('button', { name: 'Export full quality' }).click();
    const exportJob = jobRow(page, 'Exporting full quality');
    await waitFor('the export to be running', async () => (await exportJob.count()) > 0 && (await exportJob.first().getByText('Running').count()) > 0, { timeoutMs: 60_000, intervalMs: 250 });
    await exportJob.first().getByRole('button', { name: 'Cancel' }).click();
    await cancelCard.getByText('Export cancelled').waitFor({ timeout: 60_000 });
    check(true, 'the edit card shows the export as cancelled');
    const afterCancel = await getStatus(page, projectId);
    const cancelledVersion = afterCancel.generations[0].edits.find((e) => e.styleName === cancelName).versions[0];
    check(cancelledVersion.exportStatus === 'none' && afterCancel.jobs.every((j) => j.type !== 'render.export'), 'no export left running after the cancel', `${cancelledVersion.exportStatus}`);
    await cancelCard.getByRole('button', { name: 'Export full quality' }).click();
    await cancelCard.getByRole('button', { name: /^Download/ }).waitFor({ timeout: 300_000 });
    check(true, 'retrying the cancelled export finishes');

    // ---- 8. Reload in the middle of an upload in a second project. ----------------------------------------------
    log('Reload during an upload (second project)');
    const secondId = await createProject(page, 'E2E resume test');
    const bigClip = path.join(SAMPLES, 'sample_a_portrait_sdr.mp4');
    const PART_URL = /\/api\/uploads\/[^/]+\/parts\/(\d+)$/;
    const partRequests = [];
    page.on('request', (req) => {
      const m = req.url().match(PART_URL);
      if (m && req.method() === 'PUT') partRequests.push(Number(m[1]));
    });
    // The first part to be sent goes through; every other part is held back so the reload lands mid-upload.
    let firstPart = null;
    let releaseHeld = () => undefined;
    const held = new Promise((r) => (releaseHeld = r));
    await page.route(PART_URL, async (route) => {
      const n = Number(route.request().url().match(PART_URL)[1]);
      if (firstPart === null) firstPart = n;
      if (n === firstPart) return route.continue();
      await held;
      return route.abort().catch(() => undefined);
    });
    const firstArrived = page.waitForResponse((res) => PART_URL.test(res.url()) && res.request().method() === 'PUT' && res.ok(), { timeout: 60_000 });
    await dropFiles(page, [bigClip]);
    await firstArrived;
    check(firstPart !== null, 'first part of the second upload arrived before the reload', `part ${firstPart}`);
    page.once('dialog', (d) => void d.accept());
    releaseHeld();
    await page.unroute(PART_URL);
    partRequests.length = 0;
    await page.reload();
    await page.getByText('Drop your haircut clips here to start').waitFor({ timeout: 30_000 });
    await dropFiles(page, [bigClip]);
    await waitFor('the resumed upload to finish', async () => (await page.locator('ul[aria-label="Uploads"] li', { hasText: 'Uploaded' }).count()) === 1, { timeoutMs: 120_000, intervalMs: 500 });
    check(!partRequests.includes(firstPart), 'resumed upload skipped the part that had already arrived', `parts sent after reload: ${partRequests.join(', ')}; first part ${firstPart}`);
    const resumed = await waitFor('the resumed clip to be ready', async () => {
      const s = await getStatus(page, secondId);
      return s.assets.length === 1 && s.assets[0].status === 'ready' ? s : null;
    }, { timeoutMs: 180_000, intervalMs: 2000 });
    check(resumed.assets[0].filename === 'sample_a_portrait_sdr.mp4' && Math.abs(resumed.assets[0].durationSec - 12) < 0.2, 'resumed clip arrived intact and was analysed', `${resumed.assets[0].durationSec} s`);

    // ---- 9. Phone layout. ---------------------------------------------------------------------------------------
    log('Phone layout at 390x844');
    const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await context.storageState() });
    const phonePage = await phone.newPage();
    watch(phonePage);
    for (const target of [`/studio/${projectId}`, '/studio', '/']) {
      await phonePage.goto(`${BASE_URL}${target}`);
      await phonePage.waitForLoadState('networkidle').catch(() => undefined);
      const widths = await phonePage.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
      check(widths.scroll <= widths.client && widths.body <= widths.client, `no horizontal scroll on ${target} at 390 px`, `scrollWidth ${widths.scroll}, body ${widths.body}, clientWidth ${widths.client}`);
      if (target === `/studio/${projectId}`) {
        await phonePage.locator('#previews-heading').scrollIntoViewIfNeeded();
        await keyScreenshot(phonePage, 'mobile-previews');
        await phonePage.evaluate(() => window.scrollTo(0, 0));
        await keyScreenshot(phonePage, 'mobile-studio');
      }
    }
    await phone.close();

    const relevantErrors = consoleErrors.filter((e) => !/Failed to load resource: net::ERR_FAILED|net::ERR_ABORTED|ERR_INTERNET_DISCONNECTED/.test(e));
    check(relevantErrors.length === 0, 'no page errors or console errors', relevantErrors.slice(0, 5).join(' | '));
    await context.close();
  } catch (err) {
    failures.push(`stopped early: ${err instanceof Error ? err.message : String(err)}`);
    log(`STOPPED: ${err instanceof Error ? err.stack : String(err)}`);
    if (page) await failureScreenshot(page, 'stopped');
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(`${passes.length} checks passed, ${failures.length} failed in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  for (const f of failures) console.log(`  - ${f}`);
  if (consoleErrors.length) {
    console.log('Browser console errors seen:');
    for (const e of consoleErrors.slice(0, 20)) console.log(`  ${e}`);
  }
  await rm(path.join(OUT_DIR, 'e2e-drop-source'), { force: true });
  process.exit(failures.length ? 1 : 0);
}

await main();
