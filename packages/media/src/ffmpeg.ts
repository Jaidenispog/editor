import { execa, type ResultPromise } from 'execa';
import { CancelledError } from '@studio/core';

export interface FfmpegProgress {
  /** Output time processed so far, in seconds. */
  outTimeSec: number;
  frame: number | null;
  fps: number | null;
  speed: number | null;
}

export interface RunFfmpegOptions {
  ffmpegPath?: string;
  signal?: AbortSignal;
  onProgress?: (p: FfmpegProgress) => void;
  /** Hard cap for a single run; defaults to 2 hours. */
  timeoutMs?: number;
  cwd?: string;
}

export interface FfmpegResult {
  durationMs: number;
  stderrTail: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

const PROGRESS_KEYS = new Set(['out_time_us', 'out_time_ms', 'frame', 'fps', 'speed', 'progress']);

/**
 * Runs ffmpeg with machine-readable progress on stdout (-progress pipe:1) and keeps the stderr tail
 * for diagnostics. Aborting the signal kills the process (SIGTERM then SIGKILL) and throws CancelledError.
 */
export async function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<FfmpegResult> {
  const started = Date.now();
  const fullArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y', ...args];
  const child: ResultPromise = execa(options.ffmpegPath ?? 'ffmpeg', fullArgs, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    timeout: options.timeoutMs ?? 2 * 60 * 60 * 1000,
    forceKillAfterDelay: 5000,
    buffer: { stdout: false, stderr: true },
    reject: false,
    stdin: 'ignore',
    stripFinalNewline: false,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (options.onProgress && child.stdout) {
    let buf = '';
    const current: Record<string, string> = {};
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1).trim();
        if (!PROGRESS_KEYS.has(key)) continue;
        current[key] = value;
        if (key === 'progress') {
          const us = Number(current['out_time_us'] ?? NaN);
          const ms = Number(current['out_time_ms'] ?? NaN);
          const outTimeSec = Number.isFinite(us) && us >= 0 ? us / 1e6 : Number.isFinite(ms) && ms >= 0 ? ms / 1e6 : 0;
          const frame = Number(current['frame']);
          const fps = Number(current['fps']);
          const speedRaw = (current['speed'] ?? '').replace('x', '');
          const speed = Number(speedRaw);
          options.onProgress?.({
            outTimeSec,
            frame: Number.isFinite(frame) ? frame : null,
            fps: Number.isFinite(fps) ? fps : null,
            speed: Number.isFinite(speed) ? speed : null,
          });
        }
      }
    });
  } else {
    child.stdout?.resume();
  }

  const result = await child;
  const stderrTail = tail(typeof result.stderr === 'string' ? result.stderr : '', 4000);
  if (result.isCanceled || options.signal?.aborted) {
    throw new CancelledError('ffmpeg cancelled');
  }
  if (result.timedOut) {
    throw new FfmpegError('ffmpeg timed out', result.exitCode ?? null, stderrTail, fullArgs);
  }
  if (result.failed || result.exitCode !== 0) {
    throw new FfmpegError(`ffmpeg exited with code ${result.exitCode}: ${lastLine(stderrTail)}`, result.exitCode ?? null, stderrTail, fullArgs);
  }
  return { durationMs: Date.now() - started, stderrTail };
}

/** Runs ffmpeg and returns its stderr (for analysis filters such as showinfo/silencedetect that print there). */
export async function runFfmpegCapture(args: string[], options: Omit<RunFfmpegOptions, 'onProgress'> & { loglevel?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = ['-hide_banner', '-nostdin', '-loglevel', options.loglevel ?? 'info', '-y', ...args];
  const result = await execa(options.ffmpegPath ?? 'ffmpeg', fullArgs, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    timeout: options.timeoutMs ?? 30 * 60 * 1000,
    forceKillAfterDelay: 5000,
    reject: false,
    stdin: 'ignore',
    maxBuffer: 200 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.isCanceled || options.signal?.aborted) throw new CancelledError('ffmpeg cancelled');
  if (result.failed || result.exitCode !== 0) {
    const stderrTail = tail(result.stderr ?? '', 4000);
    throw new FfmpegError(`ffmpeg exited with code ${result.exitCode}: ${lastLine(stderrTail)}`, result.exitCode ?? null, stderrTail, fullArgs);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Runs ffmpeg writing raw bytes to stdout (e.g. rawvideo grey frames or PCM) and returns them as a Buffer. */
export async function runFfmpegToBuffer(args: string[], options: Omit<RunFfmpegOptions, 'onProgress'> = {}): Promise<Buffer> {
  const fullArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args];
  const result = await execa(options.ffmpegPath ?? 'ffmpeg', fullArgs, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    timeout: options.timeoutMs ?? 30 * 60 * 1000,
    forceKillAfterDelay: 5000,
    reject: false,
    stdin: 'ignore',
    encoding: 'buffer',
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  if (result.isCanceled || options.signal?.aborted) throw new CancelledError('ffmpeg cancelled');
  if (result.failed || result.exitCode !== 0) {
    const stderrTail = tail(Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? ''), 4000);
    throw new FfmpegError(`ffmpeg exited with code ${result.exitCode}: ${lastLine(stderrTail)}`, result.exitCode ?? null, stderrTail, fullArgs);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout as unknown as string);
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s;
}
function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}
