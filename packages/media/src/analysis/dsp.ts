/**
 * Small, dependency-free signal helpers shared by the audio and beat analysis. Everything here is pure
 * and synchronous; sizes are small enough (16–22 kHz mono) that plain typed-array loops are fast.
 */

/** Smallest power of two that is ≥ n (at least 2). */
export function nextPowerOfTwo(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

/** Periodic Hann window of length n. */
export function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * In-place iterative radix-2 complex FFT. `re` and `im` must have the same power-of-two length.
 * Forward transform with the usual e^(-2πi k n / N) kernel; no scaling is applied.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) throw new Error('fftInPlace: length must be a power of two');
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const bRe = re[b]! * curRe - im[b]! * curIm;
        const bIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - bRe;
        im[b] = im[a]! - bIm;
        re[a] = re[a]! + bRe;
        im[a] = im[a]! + bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Scratch buffers for repeated spectra of one frame size, so the hot loops allocate nothing. */
export class SpectrumAnalyser {
  readonly fftSize: number;
  readonly bins: number;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(readonly frameLength: number, fftSize: number = nextPowerOfTwo(frameLength)) {
    if (fftSize < frameLength) throw new Error('SpectrumAnalyser: fftSize must be ≥ frameLength');
    this.fftSize = fftSize;
    this.bins = fftSize / 2 + 1;
    this.window = hannWindow(frameLength);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
  }

  /** Writes the magnitude spectrum (bins 0..fftSize/2) of the Hann-windowed frame starting at `offset` into `out`. */
  magnitudes(samples: ArrayLike<number>, offset: number, out: Float64Array): void {
    const { re, im, window, frameLength, fftSize } = this;
    for (let i = 0; i < frameLength; i++) {
      re[i] = (samples[offset + i] ?? 0) * window[i]!;
      im[i] = 0;
    }
    for (let i = frameLength; i < fftSize; i++) {
      re[i] = 0;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < this.bins; k++) out[k] = Math.hypot(re[k]!, im[k]!);
  }
}

/** Root-mean-square of samples[start, end). */
export function rmsOf(samples: ArrayLike<number>, start: number, end: number): number {
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / (to - from));
}

/** Fraction of consecutive sample pairs that change sign (0–1) in samples[start, end). */
export function zeroCrossingRate(samples: ArrayLike<number>, start: number, end: number): number {
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  if (to - from < 2) return 0;
  let crossings = 0;
  let prev = (samples[from] ?? 0) >= 0;
  for (let i = from + 1; i < to; i++) {
    const cur = (samples[i] ?? 0) >= 0;
    if (cur !== prev) crossings++;
    prev = cur;
  }
  return crossings / (to - from - 1);
}

/** p-th percentile (0–100) by linear interpolation over a sorted copy; 0 for empty input. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Centred moving average with the given radius (window = 2·radius + 1), edges use the available samples. */
export function movingAverage(values: Float64Array, radius: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + values[i]!;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    out[i] = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
  }
  return out;
}

/** Least-squares slope of y against x; 0 when fewer than two points or all x equal. */
export function regressionSlope(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] ?? 0;
    sy += ys[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

/** Value of a sampled curve at a fractional index (linear interpolation, 0 outside the array). */
export function sampleAt(values: Float64Array, position: number): number {
  if (position < 0 || position > values.length - 1) return 0;
  const i = Math.floor(position);
  const frac = position - i;
  const a = values[i] ?? 0;
  const b = values[i + 1] ?? a;
  return a + (b - a) * frac;
}

/** Sub-sample peak position by parabolic interpolation around index i (clamped to ±0.5). */
export function refinePeak(values: Float64Array, i: number): number {
  const a = values[i - 1];
  const b = values[i];
  const c = values[i + 1];
  if (a === undefined || b === undefined || c === undefined) return i;
  const denom = a - 2 * b + c;
  if (denom >= 0) return i;
  const delta = (0.5 * (a - c)) / denom;
  return i + Math.max(-0.5, Math.min(0.5, delta));
}
