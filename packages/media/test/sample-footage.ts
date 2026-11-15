import { execa } from 'execa';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The synthetic sample footage made by scripts/make-sample-footage.sh, shared by the media and worker tests.
 *
 * A samples folder is complete when the script's marker (.samples-complete, written last, after every file was moved
 * into place) lists every sample with its current size. `ensureSamples()` checks exactly that and otherwise runs the
 * script, which does all the coordinating: a lock in the folder (stale locks are taken over), a second check once it
 * holds the lock, and atomic moves from a private temporary folder. So any number of test files, worktrees sharing a
 * data/ folder, or manual runs can ask at once: one generates, the others wait for it and find the footage complete.
 */

/** Where the synthetic sample footage lives; override with STUDIO_SAMPLES_DIR. */
export const SAMPLES_DIR = path.resolve(process.env['STUDIO_SAMPLES_DIR'] ?? fileURLToPath(new URL('../../../data/samples', import.meta.url)));
export const SAMPLE_SCRIPT = fileURLToPath(new URL('../../../scripts/make-sample-footage.sh', import.meta.url));

/** Every file the script writes, in the order its marker lists them. */
export const SAMPLE_FILES = [
  'sample_a_portrait_sdr.mp4',
  'sample_b_rotated_hevc_hlg.mov',
  'sample_c_noaudio_scenes.mp4',
  'sample_d_tiny.mp4',
  'sample_music_120bpm.mp3',
] as const;
export type SampleFile = (typeof SAMPLE_FILES)[number];

/** Same marker name and version line as MARKER and MARKER_HEADER in scripts/make-sample-footage.sh. */
const MARKER = '.samples-complete';
const MARKER_HEADER = 'studio-assistant synthetic samples v1';

export function samplePath(name: SampleFile, dir: string = SAMPLES_DIR): string {
  return path.join(dir, name);
}

/** The script's completeness rule: the marker matches every sample's current size (and none is missing or empty). */
export function samplesComplete(dir: string = SAMPLES_DIR): boolean {
  let marker: string;
  try {
    marker = readFileSync(path.join(dir, MARKER), 'utf8');
  } catch {
    return false;
  }
  const expected = [MARKER_HEADER];
  for (const name of SAMPLE_FILES) {
    let size: number;
    try {
      const info = statSync(path.join(dir, name));
      if (!info.isFile()) return false;
      size = info.size;
    } catch {
      return false;
    }
    if (size === 0) return false;
    expected.push(`${name} ${size}`);
  }
  // The script compares through $(...), which drops trailing newlines; do the same.
  return marker.replace(/\n+$/, '') === expected.join('\n');
}

/**
 * Makes sure the folder holds the complete sample footage, generating it when needed (see the module comment).
 * Takes no arguments so it can be passed straight to `beforeAll`.
 */
export async function ensureSamples(): Promise<void> {
  await ensureSamplesIn(SAMPLES_DIR);
}

export async function ensureSamplesIn(dir: string): Promise<void> {
  if (samplesComplete(dir)) return;
  const result = await execa('bash', [SAMPLE_SCRIPT, dir], { reject: false, all: true });
  // Judged by the folder, not the exit status: what matters is that the footage is complete now.
  if (samplesComplete(dir)) return;
  const output = (result.all ?? '').trim().split('\n').slice(-30).join('\n');
  throw new Error(`Sample footage in ${dir} is incomplete after running ${SAMPLE_SCRIPT} (${result.failed ? `failed: ${result.shortMessage}` : 'exit 0'}).\n${output}`);
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
