import { execa } from 'execa';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Where the synthetic sample footage lives; override with STUDIO_SAMPLES_DIR. */
export const SAMPLES_DIR = process.env['STUDIO_SAMPLES_DIR'] ?? fileURLToPath(new URL('../../../data/samples/', import.meta.url));
const SAMPLE_SCRIPT = fileURLToPath(new URL('../../../scripts/make-sample-footage.sh', import.meta.url));
export const SAMPLE_FILES = [
  'sample_a_portrait_sdr.mp4',
  'sample_b_rotated_hevc_hlg.mov',
  'sample_c_noaudio_scenes.mp4',
  'sample_d_tiny.mp4',
  'sample_music_120bpm.mp3',
] as const;

export function samplePath(name: (typeof SAMPLE_FILES)[number]): string {
  return path.join(SAMPLES_DIR, name);
}

/** True when both ffmpeg and ffprobe run; the FFmpeg-backed suites skip with a message otherwise. */
export async function hasFfmpeg(): Promise<boolean> {
  try {
    await execa('ffmpeg', ['-version']);
    await execa('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function missingSamples(): Promise<string[]> {
  const missing: string[] = [];
  for (const name of SAMPLE_FILES) {
    try {
      await access(samplePath(name));
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

const LOCK_DIR = path.join(SAMPLES_DIR, '.generating.lock');
const LOCK_WAIT_MS = 240_000;
const LOCK_STALE_MS = 10 * 60_000;

async function lockHeld(): Promise<boolean> {
  try {
    const info = await stat(LOCK_DIR);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure the synthetic samples exist, generating them with scripts/make-sample-footage.sh when
 * they are missing. Test files run in parallel workers, so a lock directory lets exactly one worker
 * run the script while the others wait for it to finish.
 */
export async function ensureSamples(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (!(await lockHeld())) {
      if ((await missingSamples()).length === 0) return;
      let locked = false;
      try {
        await mkdir(LOCK_DIR, { recursive: false });
        locked = true;
      } catch {
        locked = false;
      }
      if (locked) {
        try {
          await mkdir(SAMPLES_DIR, { recursive: true });
          await execa('bash', [SAMPLE_SCRIPT, SAMPLES_DIR], { timeout: LOCK_WAIT_MS });
        } finally {
          await rm(LOCK_DIR, { recursive: true, force: true });
        }
        const still = await missingSamples();
        if (still.length > 0) throw new Error(`Sample footage could not be generated: ${still.join(', ')}`);
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for sample footage to be generated (lock: ${LOCK_DIR})`);
    }
    await sleep(500);
  }
}

/** Deterministic pseudo-random values in [-0.5, 0.5) so synthetic test signals never flake. */
export function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}
