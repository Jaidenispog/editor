/**
 * scripts/make-sample-footage.sh coordinates every test file, worktree and manual run that needs the synthetic
 * footage (see ./sample-footage.ts). These tests drive the real script with a stand-in ffmpeg, so they check the lock,
 * the completion marker and the clean-up quickly, without encoding any video, on whatever bash the machine has
 * (macOS: 3.2).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_FILES, SAMPLE_SCRIPT, ensureSamplesIn, samplesComplete } from './sample-footage.js';

/** Stands in for ffmpeg: logs the call with its caller's pid, waits a moment, then writes the output (last argument). */
const FAKE_FFMPEG = [
  '#!/usr/bin/env bash',
  'for last; do :; done',
  'echo "$PPID $last" >> "$FAKE_FFMPEG_LOG"',
  'trap \'kill "$sleeper" 2>/dev/null; exit 255\' TERM',
  'sleep "${FAKE_FFMPEG_SECONDS:-0.1}" & sleeper=$!',
  'wait "$sleeper"',
  'case "$last" in *"${FAKE_FFMPEG_FAIL_ON:-//none//}"*) echo "fake ffmpeg: failing on purpose" >&2; exit 1 ;; esac',
  'printf \'fake media for %s\\n\' "$last" > "$last"',
  '',
].join('\n');

/** One generation calls ffmpeg six times: samples A, B (encode, then rotation remux), C, D and the music. */
const CALLS_PER_GENERATION = 6;
const TIMEOUT = 30_000;

let root: string;
let bin: string;
let host: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'studio-samples-lock-'));
  bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'ffmpeg'), FAKE_FFMPEG);
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  host = (await execa('uname', ['-n'])).stdout.trim();
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A samples folder that does not exist yet, with its own ffmpeg call log. */
function fresh() {
  count += 1;
  const dir = path.join(root, `samples-${count}`);
  const log = path.join(root, `ffmpeg-${count}.log`);
  const lock = path.join(dir, '.generating.lock');
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, FAKE_FFMPEG_LOG: log, ...extra });
  return {
    dir,
    lock,
    owner: path.join(lock, 'owner'),
    env,
    run: (args: string[] = [], extra: Record<string, string> = {}) => execa('bash', [SAMPLE_SCRIPT, ...args, dir], { env: env(extra), reject: false, all: true }),
    calls: async (): Promise<string[]> => (existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter(Boolean) : []),
  };
}

const now = () => Math.floor(Date.now() / 1000);

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await sleep(50);
  }
}

describe('make-sample-footage.sh with a stand-in ffmpeg', () => {
  it('lets one of four simultaneous runs generate while the others wait, and all succeed', async () => {
    const t = fresh();
    const results = await Promise.all([1, 2, 3, 4].map(() => t.run()));
    for (const result of results) expect(result.exitCode, result.all).toBe(0);
    const calls = await t.calls();
    expect(calls).toHaveLength(CALLS_PER_GENERATION);
    expect(new Set(calls.map((line) => line.split(' ')[0])).size).toBe(1);
    expect(samplesComplete(t.dir)).toBe(true);
    expect((await readdir(t.dir)).sort()).toEqual([...SAMPLE_FILES, '.samples-complete'].sort());
  }, TIMEOUT);

  it('leaves a complete folder alone, regenerates it with --force, and regenerates a sample that no longer matches', async () => {
    const t = fresh();
    expect((await t.run()).exitCode).toBe(0);
    const again = await t.run();
    expect(again.exitCode).toBe(0);
    expect(again.all).toContain('already complete');
    expect(await t.calls()).toHaveLength(CALLS_PER_GENERATION);

    const forced = await t.run(['--force']);
    expect(forced.exitCode, forced.all).toBe(0);
    expect(await t.calls()).toHaveLength(2 * CALLS_PER_GENERATION);
    expect(samplesComplete(t.dir)).toBe(true);

    await writeFile(path.join(t.dir, 'sample_c_noaudio_scenes.mp4'), 'truncated');
    expect(samplesComplete(t.dir)).toBe(false);
    const repaired = await t.run();
    expect(repaired.exitCode, repaired.all).toBe(0);
    expect(await t.calls()).toHaveLength(3 * CALLS_PER_GENERATION);
    expect(samplesComplete(t.dir)).toBe(true);
  }, TIMEOUT);

  it('takes over a lock whose owner process has exited', async () => {
    const t = fresh();
    const deadPid = (await execa('bash', ['-c', 'echo $$'])).stdout.trim();
    await mkdir(t.lock, { recursive: true });
    await writeFile(t.owner, `${deadPid} ${host} ${now()}\n`);
    const result = await t.run();
    expect(result.exitCode, result.all).toBe(0);
    expect(result.all).toContain(`pid ${deadPid} on ${host} is no longer running`);
    expect(samplesComplete(t.dir)).toBe(true);
    expect(existsSync(t.lock)).toBe(false);
  }, TIMEOUT);

  it('takes over a lock held for longer than a generation can take, even by a live process', async () => {
    const t = fresh();
    await mkdir(t.lock, { recursive: true });
    await writeFile(t.owner, `${process.pid} ${host} ${now() - 3600}\n`);
    const result = await t.run();
    expect(result.exitCode, result.all).toBe(0);
    expect(result.all).toMatch(/has held it for \d+s, longer than 600s/);
    expect(samplesComplete(t.dir)).toBe(true);
  }, TIMEOUT);

  it('takes over a lock without an owner record once it is more than a minute old', async () => {
    const t = fresh();
    await mkdir(t.lock, { recursive: true });
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(t.lock, old, old);
    const result = await t.run();
    expect(result.exitCode, result.all).toBe(0);
    expect(result.all).toContain('no owner record');
    expect(samplesComplete(t.dir)).toBe(true);
  }, TIMEOUT);

  it('waits for a live owner instead of taking its lock', async () => {
    const t = fresh();
    await mkdir(t.lock, { recursive: true });
    await writeFile(t.owner, `${process.pid} ${host} ${now()}\n`);
    const waiting = t.run();
    await sleep(1_500);
    expect(await t.calls()).toHaveLength(0);
    expect(existsSync(t.owner)).toBe(true);
    // The owner gives up without finishing the footage: the waiter takes the lock and generates it.
    await rm(t.lock, { recursive: true, force: true });
    const result = await waiting;
    expect(result.exitCode, result.all).toBe(0);
    expect(result.all).toContain('waiting for it');
    expect(await t.calls()).toHaveLength(CALLS_PER_GENERATION);
    expect(samplesComplete(t.dir)).toBe(true);
  }, TIMEOUT);

  it('stops at once on SIGTERM, leaving no lock, temporary folder or sample behind', async () => {
    const t = fresh();
    const running = t.run([], { FAKE_FFMPEG_SECONDS: '30' });
    await waitFor(async () => (await t.calls()).length > 0);
    const stoppedAt = Date.now();
    running.kill('SIGTERM');
    const result = await running;
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(result.exitCode).toBe(143);
    expect(await readdir(t.dir)).toEqual([]);
  }, TIMEOUT);

  it('fails without leaving a partial sample, a marker or its lock when ffmpeg fails', async () => {
    const t = fresh();
    const result = await t.run([], { FAKE_FFMPEG_FAIL_ON: 'sample_c' });
    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain('failing on purpose');
    expect(await readdir(t.dir)).toEqual([]);
  }, TIMEOUT);

  it('treats only an existing lock directory as held: any other mkdir failure is an error, not a wait', async () => {
    const t = fresh();
    await mkdir(t.dir, { recursive: true });
    await writeFile(t.lock, 'not a directory');
    const result = await t.run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('cannot create the lock');
    expect(await t.calls()).toHaveLength(0);
  }, TIMEOUT);
});

describe('samplesComplete and ensureSamplesIn', () => {
  it('needs the marker with the current version and every sample at the size it records', async () => {
    const t = fresh();
    await mkdir(t.dir, { recursive: true });
    for (const name of SAMPLE_FILES) await writeFile(path.join(t.dir, name), `content of ${name}`);
    expect(samplesComplete(t.dir)).toBe(false);
    const lines = SAMPLE_FILES.map((name) => `${name} ${`content of ${name}`.length}`);
    await writeFile(path.join(t.dir, '.samples-complete'), ['studio-assistant synthetic samples v0', ...lines, ''].join('\n'));
    expect(samplesComplete(t.dir)).toBe(false);
    await writeFile(path.join(t.dir, '.samples-complete'), ['studio-assistant synthetic samples v1', ...lines, ''].join('\n'));
    expect(samplesComplete(t.dir)).toBe(true);
    await rm(path.join(t.dir, 'sample_d_tiny.mp4'));
    expect(samplesComplete(t.dir)).toBe(false);
  });

  it('generates once for many simultaneous callers, and reports the script output when it cannot', async () => {
    const t = fresh();
    const saved = { PATH: process.env['PATH'], FAKE_FFMPEG_LOG: process.env['FAKE_FFMPEG_LOG'], FAKE_FFMPEG_FAIL_ON: process.env['FAKE_FFMPEG_FAIL_ON'] };
    Object.assign(process.env, t.env());
    try {
      await Promise.all([1, 2, 3].map(() => ensureSamplesIn(t.dir)));
      expect(samplesComplete(t.dir)).toBe(true);
      expect(await t.calls()).toHaveLength(CALLS_PER_GENERATION);

      const broken = fresh();
      Object.assign(process.env, broken.env({ FAKE_FFMPEG_FAIL_ON: 'sample_music' }));
      await expect(ensureSamplesIn(broken.dir)).rejects.toThrow(/incomplete after running[\s\S]*failing on purpose/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, TIMEOUT);
});
