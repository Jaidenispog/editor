import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SYNTHETIC reference fixtures with known ground truth (preferences design §4.3.1.10). Generated at test time with
 * FFmpeg `lavfi` sources only; nothing is committed and nothing is ever seeded into a development or preview database.
 * 540 × 960, 30 fps unless a spec sets `fps` (the 60 and 25 fps edge cases), 48 kHz audio; every frame carries a small "SYNTHETIC TEST CLIP" label; files are named
 * `synthetic-*.mp4` with a ground-truth JSON beside each.
 *
 * Reproducible: every random input is pinned, so building a fixture twice on the same machine gives the same file.
 * `gradients` picks random colours unless `c0`/`c1` are set (its `seed` only places the gradient line), `anoisesrc`,
 * `life` and `cellauto` pick a random seed unless one is given, and the `noise` seed is written out although FFmpeg's
 * default is already fixed. x264 splits each frame into 4 slices on 4 threads: its default frame threads now and then
 * encode a few frames differently from run to run (seen on X9's bright insert), and their number follows the CPU. The
 * one row FFmpeg 6.1's `slideup` leaves undefined is painted black (see `buildFixture`). Another FFmpeg build or CPU type
 * can still round pixels differently.
 */

const FONT = fileURLToPath(new URL('../../../../assets/fonts/Inter-Regular.otf', import.meta.url));
export const FPS = 30;
const DEFAULT_FPS = FPS;
const W = 540;
const H = 960;

/** Eight visually different sources (design §4.3.1.10), each with temporal noise and a hue offset. */
const sourcesAt = (fps: number) =>
  [
    `testsrc2=s=${W}x${H}:r=${fps}`,
    `mandelbrot=s=${W}x${H}:r=${fps}:end_pts=1000000`,
    `cellauto=s=${W}x${H}:r=${fps}:rule=110:scroll=0:seed=3`,
    `smptebars=s=${W}x${H}:r=${fps}`,
    `gradients=s=${W}x${H}:r=${fps}:speed=0.02:seed=7:c0=0x3b6db3:c1=0xe8a23a`,
    `life=s=${W}x${H}:r=${fps}:mold=10:ratio=0.3:seed=5:life_color=#ff8000:death_color=#002040`,
    `rgbtestsrc=s=${W}x${H}:r=${fps}`,
    `testsrc=s=${W}x${H}:r=${fps}`,
  ] as const;

/** Click track; `bpm` sets the beat, `gain` an optional level expression of t. */
export function clickTrack(bpm = 120, gain = '1'): string {
  const p = (60 / bpm).toFixed(6);
  return `aevalsrc='(${gain})*(0.8*sin(2*PI*55*t)*exp(-30*mod(t\\,${p}))+0.3*sin(2*PI*1800*t)*exp(-60*mod(t\\,${p})))':s=48000:c=mono`;
}
export const PINK_NOISE = 'anoisesrc=color=pink:amplitude=0.03:r=48000:seed=17';
/** Speech-like: voiced tones with an irregular syllable envelope and pauses (no steady pulse). */
export const SPEECH_LIKE =
  "aevalsrc='0.35*sin(2*PI*(130+25*sin(2*PI*2.3*t))*t)*(0.55+0.45*sin(2*PI*3.7*t+sin(2*PI*1.3*t)))*gt(sin(2*PI*0.37*t)+0.4*sin(2*PI*1.1*t)\\,-0.5)+0.08*sin(2*PI*(260+40*sin(2*PI*1.7*t))*t)':s=48000:c=mono";

/** One shot: a source index (or a custom filter graph input) and its length in frames. */
export interface ShotSpec {
  source?: number;
  /** A full lavfi source expression instead of the standard list. */
  lavfi?: string;
  /** Extra filters after the source (before the label). */
  filter?: string;
  hue?: number;
  /** Use a still image file looped. */
  still?: string;
  /** Fixed noise strength (default 4). */
  noise?: number;
}

/** A join into shot j: a hard cut, or an xfade starting at `atSec` (output time) lasting `durationSec`. */
export type JoinSpec = { type: 'cut'; atSec: number } | { type: 'xfade'; transition: string; atSec: number; durationSec: number };

export interface FixtureSpec {
  name: string;
  shots: ShotSpec[];
  /** joins[j] joins shot j and shot j + 1. */
  joins: JoinSpec[];
  totalSec: number;
  audio: string | null;
  truth: Record<string, unknown>;
  /** Frame rate of the whole fixture (default 30). */
  fps?: number;
}

function shotInput(s: ShotSpec, lenFrames: number, index: number, fps: number): { args: string[]; chain: string } {
  const noise = s.noise ?? 4;
  const hue = s.hue ?? (index * 47) % 360;
  if (s.still) {
    return { args: ['-loop', '1', '-framerate', String(fps), '-t', ((lenFrames + 2) / fps).toFixed(4), '-i', s.still], chain: `${s.filter ? `${s.filter},` : ''}scale=${W}:${H},setsar=1` };
  }
  const sources = sourcesAt(fps);
  const src = s.lavfi ?? sources[(s.source ?? index) % sources.length]!;
  return {
    args: ['-f', 'lavfi', '-t', ((lenFrames + 2) / fps).toFixed(4), '-i', src],
    chain: `${s.filter ? `${s.filter},` : ''}scale=${W}:${H},setsar=1,hue=h=${hue},noise=alls=${noise}:allf=t:all_seed=123457`,
  };
}

/**
 * Builds a fixture: shots joined by cuts (concat) and xfades, the label drawn on every frame, the audio, H.264/AAC.
 * Shot lengths follow from the join times so every cut lands on the frame the ground truth names.
 */
export async function buildFixture(dir: string, spec: FixtureSpec): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `synthetic-${spec.name}.mp4`);
  const FPS = spec.fps ?? DEFAULT_FPS;
  const frames = (sec: number) => Math.round(sec * FPS);
  const n = spec.shots.length;
  const startOf = (j: number) => (j === 0 ? 0 : spec.joins[j - 1]!.atSec);
  const endOf = (j: number) => {
    if (j === n - 1) return spec.totalSec;
    const join = spec.joins[j]!;
    return join.type === 'cut' ? join.atSec : join.atSec + join.durationSec;
  };
  const args: string[] = [];
  const graph: string[] = [];
  spec.shots.forEach((s, j) => {
    const len = frames(endOf(j)) - frames(startOf(j));
    const input = shotInput(s, len, j, FPS);
    args.push(...input.args);
    graph.push(`[${j}:v]${input.chain},format=yuv420p,fps=${FPS},trim=end_frame=${len},setpts=PTS-STARTPTS,settb=1/${FPS}[s${j}]`);
  });
  let cur = 's0';
  for (let j = 1; j < n; j++) {
    const join = spec.joins[j - 1]!;
    const out = `j${j}`;
    if (join.type === 'cut') graph.push(`[${cur}][s${j}]concat=n=2:v=1:a=0,settb=1/${FPS}[${out}]`);
    else {
      // FFmpeg 6.1's `slideup` leaves the top row of its first frame undefined (it differs from run to run), so that one
      // row is painted black to keep the fixture the same on every build.
      const half = 0.5 / FPS;
      const topRow = join.transition === 'slideup' ? `,drawbox=x=0:y=0:w=iw:h=1:color=black:t=fill:enable='between(t,${(join.atSec - half).toFixed(6)},${(join.atSec + half).toFixed(6)})'` : '';
      graph.push(`[${cur}][s${j}]xfade=transition=${join.transition}:duration=${join.durationSec}:offset=${join.atSec}${topRow},settb=1/${FPS}[${out}]`);
    }
    cur = out;
  }
  graph.push(`[${cur}]drawtext=fontfile='${FONT}':text='SYNTHETIC TEST CLIP':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:x=12:y=h-34,format=yuv420p[vout]`);
  const audioArgs: string[] = [];
  if (spec.audio) {
    audioArgs.push('-f', 'lavfi', '-t', spec.totalSec.toFixed(3), '-i', spec.audio);
  }
  await execa('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
    ...audioArgs,
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[vout]',
    ...(spec.audio ? ['-map', `${n}:a`, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000'] : []),
    '-c:v',
    'libx264',
    '-threads',
    '4',
    '-x264-params',
    'sliced-threads=1',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-t',
    spec.totalSec.toFixed(3),
    '-movflags',
    '+faststart',
    file,
  ]);
  await writeFile(file.replace(/\.mp4$/, '.json'), JSON.stringify({ synthetic: true, ...spec.truth }, null, 2));
  return file;
}

/** A still image for the zoom fixture (2× size so zoompan does not jitter). */
export async function buildStill(dir: string, name: string, lavfi: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `synthetic-still-${name}.png`);
  await execa('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', file]);
  return file;
}

const cuts = (times: number[]): JoinSpec[] => times.map((t) => ({ type: 'cut', atSec: t }));
const range = (from: number, to: number, step = 1) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Math.round((from + i * step) * 1e6) / 1e6);

/** Seeded random numbers (mulberry32) so R11 is the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixture table of design §4.3.1.10 (R4 needs stills, built by {@link zoomFixture}). */
export function fixtureSpecs(): Record<string, FixtureSpec> {
  const shots = (count: number) => Array.from({ length: count }, (_, i): ShotSpec => ({ source: i }));
  const r1Cuts = range(1, 15);
  const r2Joins: JoinSpec[] = r1Cuts.map((t) => (t % 2 === 0 ? { type: 'xfade', transition: 'fadewhite', atSec: t - 0.04, durationSec: 0.2 } : { type: 'cut', atSec: t }));
  const r5Joins: JoinSpec[] = [2, 4, 6, 8, 10, 12, 14].map((t) => (t === 8 ? { type: 'xfade', transition: 'fadewhite', atSec: 7.96, durationSec: 0.2 } : { type: 'cut', atSec: t }));
  const r10Beats = range(1, 31).map((k) => (k * 60) / 124).filter((t) => t < 15);
  const rnd = seeded(11);
  const r11Cuts: number[] = [];
  while (r11Cuts.length < 15) {
    const t = Math.round((0.6 + rnd() * 14.8) * FPS) / FPS;
    if (r11Cuts.every((c) => Math.abs(c - t) >= 0.45)) r11Cuts.push(t);
  }
  r11Cuts.sort((a, b) => a - b);
  const quietThenLoud = clickTrack(120, 'if(lt(t\\,8)\\,0.126\\,1)');
  return {
    r1: { name: 'r1-hard-cuts-120bpm', shots: shots(16), joins: cuts(r1Cuts), totalSec: 16, audio: clickTrack(120), truth: { cuts: r1Cuts, bpm: 120 } },
    r2: { name: 'r2-flash-every-4-beats', shots: shots(16), joins: r2Joins, totalSec: 16, audio: clickTrack(120), truth: { flashPeaks: range(2, 14, 2), hardCuts: range(1, 15, 2), bpm: 120 } },
    r3: {
      name: 'r3-cross-fades',
      shots: [0, 1, 3, 4, 6, 7].map((source) => ({ source })),
      joins: [2, 4, 6, 8, 10].map((t): JoinSpec => ({ type: 'xfade', transition: 'fade', atSec: t, durationSec: 0.5 })),
      totalSec: 12.5,
      audio: PINK_NOISE,
      truth: { crossFades: 5, durationSec: 0.5 },
    },
    r3b: {
      name: 'r3b-pixel-dissolve',
      shots: [0, 1, 3, 4, 6, 7].map((source) => ({ source })),
      joins: [2, 4, 6, 8, 10].map((t): JoinSpec => ({ type: 'xfade', transition: 'dissolve', atSec: t, durationSec: 0.5 })),
      totalSec: 12.5,
      audio: PINK_NOISE,
      truth: { crossFades: 5, durationSec: 0.5 },
    },
    r5: { name: 'r5-drop-on-a-cut', shots: shots(8), joins: r5Joins, totalSec: 16, audio: quietThenLoud, truth: { dropSec: 8, flashPeak: 8 } },
    r5b: { name: 'r5b-drop-no-event', shots: shots(3), joins: cuts([7, 9]), totalSec: 16, audio: quietThenLoud, truth: { dropSec: 8, eventAtDrop: false } },
    r6: {
      name: 'r6-slides-and-wipes',
      shots: [0, 3, 1, 6, 7, 4].map((source) => ({ source })),
      joins: ['slideup', 'slidedown', 'wipeleft', 'wiperight', 'slideup'].map((transition, i): JoinSpec => ({ type: 'xfade', transition, atSec: 2 * (i + 1), durationSec: 0.3 })),
      totalSec: 12.3,
      audio: clickTrack(120),
      truth: { motion: [{ axis: 'y', direction: 'up' }, { axis: 'y', direction: 'down' }, { axis: 'x', direction: 'left' }, { axis: 'x', direction: 'right' }, { axis: 'y', direction: 'up' }] },
    },
    r7: {
      name: 'r7-busy-single-shot',
      shots: [{ lavfi: `life=s=${W}x${H}:r=${FPS}:mold=10:ratio=0.3:seed=11:life_color=#ffd000:death_color=#103050[l];cellauto=s=${W}x${H / 3}:r=${FPS}:rule=30:seed=13[c];[l][c]overlay=0:${H / 3}[out0]`, filter: `crop=w=iw-60:h=ih-60:x='30+20*sin(7*t)':y='30+20*cos(5*t)'` }],
      joins: [],
      totalSec: 15,
      audio: clickTrack(120),
      truth: { joins: 0 },
    },
    r8: {
      name: 'r8-dark-end-screen',
      shots: [...shots(16), { lavfi: `color=c=0x101010:s=${W}x${H}:r=${FPS}`, filter: 'drawbox=x=220:y=440:w=100:h=60:color=white:t=fill', noise: 0, hue: 0 }],
      joins: cuts([...r1Cuts, 16]),
      totalSec: 19,
      audio: clickTrack(120),
      truth: { endScreenSec: 3, cuts: r1Cuts },
    },
    r9: { name: 'r9-talking', shots: shots(10), joins: cuts(range(1.5, 13.5, 1.5)), totalSec: 15, audio: SPEECH_LIKE, truth: { musicalBeat: false } },
    r10: { name: 'r10-124bpm-every-beat', shots: shots(r10Beats.length + 1), joins: cuts(r10Beats.map((t) => Math.round(t * FPS) / FPS)), totalSec: 15, audio: clickTrack(124), truth: { cuts: r10Beats, bpm: 124 } },
    r11: { name: 'r11-random-cuts', shots: shots(16), joins: cuts(r11Cuts), totalSec: 16, audio: clickTrack(120), truth: { cuts: r11Cuts, bpm: 120 } },
  };
}

/** R4: a static shot, a zoompan push-in 1.0 → 1.2 and a shot with a jump to a 1.25× crop at 1.5 s. */
export async function zoomFixture(dir: string): Promise<{ file: string; truthPushScale: number }> {
  const stillA = await buildStill(dir, 'a', `testsrc=s=${W}x${H}`);
  const stillB = await buildStill(dir, 'b', `mandelbrot=s=${2 * W}x${2 * H}:end_pts=1`);
  const stillC = await buildStill(dir, 'c', `smptehdbars=s=${W}x${H},drawgrid=w=40:h=40:t=2:c=white@0.8`);
  const zoomFrames = 90;
  const spec: FixtureSpec = {
    name: 'r4-zooms',
    shots: [
      { still: stillA },
      { still: stillB, filter: `zoompan=z='1+0.2*on/${zoomFrames - 1}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}` },
      { still: stillC },
      { still: stillC, filter: `crop=w=iw/1.25:h=ih/1.25:x=(iw-iw/1.25)/2:y=(ih-ih/1.25)/2` },
    ],
    joins: cuts([3, 6, 7.5]),
    totalSec: 9,
    audio: clickTrack(120),
    truth: { pushIns: 1, punchIns: 1, punchScale: 1.25 },
  };
  // zoompan scale between 15 % and 85 % of the analysed part of shot B (0.1 s ignored at each end).
  const z = (localSec: number) => 1 + (0.2 * Math.round(localSec * FPS)) / (zoomFrames - 1);
  const a = 0.1;
  const b = 2.9;
  const truthPushScale = z(a + 0.85 * (b - a)) / z(a + 0.15 * (b - a));
  return { file: await buildFixture(dir, spec), truthPushScale };
}

/**
 * X19: slides between similar-looking shots, windows of one detailed still (the Mandelbrot set's seahorse valley), each
 * 5–13 % of the frame from the one before: a slide moves the picture by a whole frame, a camera move by part of one.
 */
export async function similarShotsFixture(dir: string): Promise<{ file: string; motion: Array<{ axis: 'x' | 'y'; direction: string }> }> {
  const still = await buildStill(dir, 'seahorse', 'mandelbrot=s=1620x2880:start_x=-0.743643887037151:start_y=0.131825904205330:start_scale=0.03:maxiter=400:end_pts=1');
  const window = ([x, y]: readonly [number, number]): ShotSpec => ({ still, filter: `crop=w=540:h=960:x=${x}:y=${y},noise=alls=6:allf=t:all_seed=99` });
  const transitions = ['slideup', 'slideleft', 'slidedown', 'slideright', 'wiperight'];
  const motion = [{ axis: 'y' as const, direction: 'up' }, { axis: 'x' as const, direction: 'left' }, { axis: 'y' as const, direction: 'down' }, { axis: 'x' as const, direction: 'right' }, { axis: 'x' as const, direction: 'right' }];
  const spec: FixtureSpec = {
    name: 'x19-slides-between-similar-shots',
    shots: ([[500, 800], [560, 800], [560, 900], [500, 900], [530, 850], [600, 850]] as const).map(window),
    joins: transitions.map((transition, i): JoinSpec => ({ type: 'xfade', transition, atSec: 2 * (i + 1), durationSec: i === 1 ? 0.2 : 0.3 })),
    totalSec: 12.4,
    audio: PINK_NOISE,
    truth: { motion },
  };
  return { file: await buildFixture(dir, spec), motion };
}

/**
 * Edge cases from review (all SYNTHETIC, ground truth beside each): bright and dark shots joined by hard cuts (not
 * flashes or screens), dips to black, FFmpeg's zoomin, a horizontal blur, soft-edged wipes and cross-fades at 60 and
 * 25 fps with hard cuts on the beat.
 */
export function edgeFixtureSpecs(): Record<string, FixtureSpec> {
  const shots = (count: number) => Array.from({ length: count }, (_, i): ShotSpec => ({ source: i }));
  const xfades = (transition: string | string[], times: number[], durationSec: number): JoinSpec[] =>
    times.map((t, i): JoinSpec => ({ type: 'xfade', transition: Array.isArray(transition) ? transition[i % transition.length]! : transition, atSec: t, durationSec }));
  // Hard cuts on the 120 BPM beat with 1 s and 0.5 s cross-fades between steady, clearly different sources.
  const mixed: JoinSpec[] = [
    ...cuts([1, 2, 3]),
    { type: 'xfade', transition: 'fade', atSec: 4, durationSec: 1 },
    ...cuts([6, 7]),
    { type: 'xfade', transition: 'fade', atSec: 8, durationSec: 0.5 },
    ...cuts([9.5, 10.5, 11.5]),
    { type: 'xfade', transition: 'fade', atSec: 12.5, durationSec: 1 },
    ...cuts([14.5, 15.5]),
    { type: 'xfade', transition: 'fade', atSec: 16.5, durationSec: 0.5 },
    ...cuts([18, 19]),
  ];
  const mixedShots = Array.from({ length: mixed.length + 1 }, (_, i): ShotSpec => ({ source: [0, 1, 3, 4, 6, 7][i % 6] }));
  const mixedTruth = {
    cuts: [1, 2, 3, 6, 7, 9.5, 10.5, 11.5, 14.5, 15.5, 18, 19],
    crossFades: [{ atSec: 4, durationSec: 1 }, { atSec: 8, durationSec: 0.5 }, { atSec: 12.5, durationSec: 1 }, { atSec: 16.5, durationSec: 0.5 }],
    bpm: 120,
  };
  const textured = [0, 1, 3, 7, 0, 2].map((source): ShotSpec => ({ source }));
  // Cards (round 2): a black card and a white end card with text, as at the end of a phone edit.
  const blackCard: ShotSpec = {
    lavfi: `color=c=black:s=${W}x${H}:r=${FPS}`,
    filter: `drawtext=fontfile='${FONT}':text='THANKS FOR WATCHING':fontsize=34:fontcolor=0xdddddd:x=(w-tw)/2:y=(h-th)/2,drawbox=x=230:y=380:w=80:h=80:color=0xc0c0c0:t=fill`,
    noise: 20,
    hue: 0,
  };
  const whiteCard: ShotSpec = {
    lavfi: `color=c=white:s=${W}x${H}:r=${FPS}`,
    filter: `drawtext=fontfile='${FONT}':text='BOOK NOW':fontsize=44:fontcolor=0x222222:x=(w-tw)/2:y=(h-th)/2,drawtext=fontfile='${FONT}':text='link in bio':fontsize=26:fontcolor=0x555555:x=(w-tw)/2:y=(h-th)/2+60`,
    noise: 10,
    hue: 0,
  };
  /** A card whose dark (or light) banner, 31 % of the frame, fades in over 0.4 s from `at` seconds into the card. */
  const bannerCard = (colour: 'white' | 'black', at: number): ShotSpec => {
    const [banner, text] = colour === 'white' ? ['0x303030', '0x222222'] : ['0xdddddd', '0xdddddd'];
    return {
      lavfi: `color=c=${colour}:s=${W}x${H}:r=${FPS}[c];color=c=${banner}:s=${W}x300:r=${FPS},format=rgba,fade=t=in:st=${at}:d=0.4:alpha=1[b];[c][b]overlay=x=0:y=300,drawtext=fontfile='${FONT}':text='BOOK NOW':fontsize=44:fontcolor=${text}:x=(w-tw)/2:y=(h-th)/2+260[out0]`,
      noise: 4,
      hue: 0,
    };
  };
  const plainCard = (colour: 'white' | 'black', fps: number, filter = 'drawbox=x=220:y=440:w=100:h=60:color=0x303030:t=fill'): ShotSpec => ({ lavfi: `color=c=${colour}:s=${W}x${H}:r=${fps}`, filter, noise: 0, hue: 0 });
  // A light square growing in 10 steps between `start` and `end` seconds into the card (drawbox has no time variable).
  const growingSquare = (colour: string, start: number, end: number, final: number) =>
    Array.from({ length: 10 }, (_, i) => {
      const size = Math.round((final * (i + 1)) / 10);
      const from = start + ((end - start) * i) / 10;
      const to = i === 9 ? 999 : start + ((end - start) * (i + 1)) / 10;
      return `drawbox=x=${(W - size) / 2}:y=${(H - size) / 2}:w=${size}:h=${size}:color=${colour}:t=fill:enable='between(t,${from.toFixed(4)},${to.toFixed(4)})'`;
    }).join(',');
  const smoothGradient: ShotSpec = { lavfi: `gradients=s=${W}x${H}:r=${FPS}:speed=0.02:seed=3:c0=0xd9c5b2:c1=0x7d5a50` };
  /** A camera move of `by` pixels from `from` seconds, lasting `dur` seconds (linear), for a crop expression. */
  const move = (from: number, dur: number, by: number) => `${by}*clip((t-${from})/${dur},0,1)`;
  const greyWall: ShotSpec = { lavfi: `color=c=0x8a8a8a:s=${W}x${H}:r=${FPS}`, noise: 14, hue: 0 };
  // X2 with the last shot's gradient colours set to two pairs that lost a cut when FFmpeg still picked them at random.
  const x2LastShot = (c0: string, c1: string): ShotSpec[] => [
    { source: 0 },
    { source: 1, filter: 'eq=brightness=0.5' },
    { source: 2 },
    { source: 3, filter: 'eq=brightness=0.5' },
    { lavfi: `gradients=s=${W}x${H}:r=${FPS}:speed=0.02:seed=7:c0=0x${c0}:c1=0x${c1}` },
  ];
  return {
    x1: {
      name: 'x1-dark-and-bright-shots',
      shots: [{ source: 0 }, { source: 7, filter: 'eq=brightness=-0.55' }, { source: 2 }, { source: 3, filter: 'eq=brightness=0.6' }, { source: 1 }, { source: 6 }],
      joins: cuts([2, 4, 6, 8, 10]),
      totalSec: 12,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4, 6, 8, 10], flashes: 0, screens: 0 },
    },
    x2: {
      name: 'x2-bright-inserts',
      shots: [{ source: 0 }, { source: 1, filter: 'eq=brightness=0.5' }, { source: 2 }, { source: 3, filter: 'eq=brightness=0.5' }, { source: 4 }],
      joins: cuts([2, 2.3, 5, 5.3]),
      totalSec: 8,
      audio: PINK_NOISE,
      truth: { cuts: [2, 2.3, 5, 5.3], flashes: 0 },
    },
    x3: { name: 'x3-dips-to-black', shots: shots(6), joins: xfades('fadeblack', [2, 4, 6, 8, 10], 0.4), totalSec: 12.4, audio: PINK_NOISE, truth: { dips: 5, durationSec: 0.4 } },
    x4: { name: 'x4-zoomin', shots: textured, joins: xfades('zoomin', [2, 4, 6, 8, 10], 0.4), totalSec: 12.4, audio: PINK_NOISE, truth: { zooms: 5, flashes: 0 } },
    x5: { name: 'x5-horizontal-blur', shots: textured, joins: xfades('hblur', [2, 4, 6, 8, 10], 0.4), totalSec: 12.4, audio: PINK_NOISE, truth: { zooms: 0, crossFades: 0 } },
    x6: {
      name: 'x6-soft-wipes',
      shots: [0, 3, 1, 6, 7, 4].map((source) => ({ source })),
      joins: xfades(['smoothleft', 'smoothup', 'smoothright', 'smoothdown', 'smoothleft'], [2, 4, 6, 8, 10], 0.4),
      totalSec: 12.4,
      audio: PINK_NOISE,
      truth: { motion: [{ axis: 'x', direction: 'left' }, { axis: 'y', direction: 'up' }, { axis: 'x', direction: 'right' }, { axis: 'y', direction: 'down' }, { axis: 'x', direction: 'left' }] },
    },
    x7: { name: 'x7-cross-fades-and-beat-cuts-60fps', shots: mixedShots, joins: mixed, totalSec: 20, audio: clickTrack(120), truth: mixedTruth, fps: 60 },
    x8: { name: 'x8-cross-fades-and-beat-cuts-25fps', shots: mixedShots, joins: mixed, totalSec: 20, audio: clickTrack(120), truth: mixedTruth, fps: 25 },
    // The cut into a smooth light-to-blue gradient once read as a slide: shifting the frame halved the difference just
    // by cropping, although the shifted frames do not look alike.
    x9: { name: 'x9-bright-insert-then-smooth-shot', shots: x2LastShot('ecf0de1c', '1277d485'), joins: cuts([2, 2.3, 5, 5.3]), totalSec: 8, audio: PINK_NOISE, truth: { cuts: [2, 2.3, 5, 5.3], flashes: 0 } },
    // A light gradient that drifts towards a nearly uniform frame once made the insert and itself a white end screen.
    x10: { name: 'x10-bright-insert-then-light-shot', shots: x2LastShot('dffcc3a7', 'c7e014c1'), joins: cuts([2, 2.3, 5, 5.3]), totalSec: 8, audio: PINK_NOISE, truth: { cuts: [2, 2.3, 5, 5.3], flashes: 0, screens: 0 } },
    // A bright shot with detail, then a cut to a white end card: the card is an end screen, the bright shot keeps its cut.
    x11: {
      name: 'x11-bright-shot-then-white-end-card',
      shots: [{ source: 0 }, { source: 1, filter: 'eq=brightness=0.5' }, { source: 2 }, { source: 3, filter: 'eq=brightness=0.6' }, { lavfi: `color=c=white:s=${W}x${H}:r=${FPS}`, filter: 'drawbox=x=220:y=440:w=100:h=60:color=0x303030:t=fill', noise: 0, hue: 0 }],
      joins: cuts([2, 2.3, 5, 5.3]),
      totalSec: 8,
      audio: PINK_NOISE,
      truth: { cuts: [2, 2.3, 5], endScreenStartSec: 5.3, flashes: 0 },
    },
    // FFmpeg's steep fadeblack/fadewhite into a card: the last steps of the ramp score like a cut but are the fade into
    // the card (a mid-video black card: one dip; a white end card: an end screen from the fade).
    x12: {
      name: 'x12-steep-fades-into-cards',
      shots: [{ source: 0 }, { source: 3 }, blackCard, { source: 1 }, { source: 3 }, whiteCard],
      joins: [{ type: 'cut', atSec: 2 }, { type: 'xfade', transition: 'fadeblack', atSec: 4, durationSec: 0.5 }, ...cuts([6, 7.5]), { type: 'xfade', transition: 'fadewhite', atSec: 9, durationSec: 0.5 }],
      totalSec: 11.5,
      audio: PINK_NOISE,
      truth: { cuts: [2, 6, 7.5], dip: { atSec: 4, durationSec: 0.5 }, endScreenStartSec: 9 },
    },
    // At 60 fps a cut on a Pass A frame k with k mod 6 = 5 is looked up on the grey frame before it: a mid-video card
    // entered there, and an end card entered there.
    x13: {
      name: 'x13-cards-entered-on-odd-frames-60fps',
      shots: [{ source: 0 }, { source: 3 }, plainCard('white', 60), { source: 6 }, { source: 3 }, plainCard('white', 60)],
      joins: cuts([2, 305 / 60, 365 / 60, 8, 563 / 60]),
      totalSec: 11.5,
      audio: PINK_NOISE,
      truth: { cuts: [2, 305 / 60, 365 / 60, 8], endScreenStartSec: 563 / 60 },
      fps: 60,
    },
    // A white end card whose dark banner (27 % of the frame) fades in 0.4–0.8 s into it, as in CapCut-style outros.
    x14: {
      name: 'x14-end-card-banner-fades-in',
      shots: [
        { source: 0 },
        { source: 1 },
        { source: 3 },
        { lavfi: `color=c=white:s=${W}x${H}:r=${FPS}[w];color=c=0x303030:s=540x260:r=${FPS},format=rgba,fade=t=in:st=0.4:d=0.4:alpha=1[b];[w][b]overlay=x=0:y=350[out0]`, noise: 0, hue: 0 },
      ],
      joins: cuts([2, 4, 5.3]),
      totalSec: 8,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4], endScreenStartSec: 5.3 },
    },
    // A mid-video white card whose logo pops in 0.8 s into it (and a 1-frame glitch at 1.2 s), then a black end card
    // whose light logo grows in 10 steps 0.2–0.7 s into it: one join into and one out of the mid card, an end screen.
    x15: {
      name: 'x15-cards-with-overlays',
      shots: [
        { source: 0 },
        { source: 3 },
        plainCard('white', FPS, "drawbox=x=140:y=270:w=260:h=260:color=0x303030:t=fill:enable='gte(t,0.8)',drawbox=x=0:y=600:w=540:h=200:color=0x8a8a8a:t=fill:enable='between(t,1.19,1.21)'"),
        { source: 1 },
        { source: 7 },
        plainCard('black', FPS, growingSquare('0xdddddd', 0.2, 0.7, 300)),
      ],
      joins: cuts([2, 4, 6, 7.5, 9.3]),
      totalSec: 12,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4, 6, 7.5], midCard: [4, 6], endScreenStartSec: 9.3 },
    },
    // Cuts from a card to a different shot inside the same white or black run: each ends the card and counts. After a
    // white card: SMPTE bars brightened by 0.5 (more than half of the card's pixels change), and the Mandelbrot set
    // brightened and contrasted (a quarter changes, but across most rows and columns); after a black card: a test
    // pattern darkened to YAVG 16 (a sixth changes, in strips down every row).
    x16: {
      name: 'x16-cards-then-bright-or-dark-shots',
      shots: [
        { source: 0 },
        { source: 3 },
        whiteCard,
        { source: 3, filter: 'eq=brightness=0.5' },
        { source: 7 },
        whiteCard,
        { source: 1, filter: 'eq=brightness=0.5:contrast=1.5', hue: 141 },
        { source: 0 },
        blackCard,
        { source: 0, filter: 'eq=brightness=-0.55', hue: 141 },
        { source: 1 },
      ],
      joins: cuts([2, 4, 5.2, 6.4, 7.6, 8.8, 10, 11.2, 12.4, 13.6]),
      totalSec: 15,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4, 5.2, 6.4, 7.6, 8.8, 10, 11.2, 12.4, 13.6], screens: 0 },
    },
    // 0.15 s slides between smooth and textured shots: the picture moves about half the frame between the frames the
    // cut test compares, beyond a third of the frame.
    x17: {
      name: 'x17-fast-slides-smooth-and-textured',
      shots: [{ source: 0 }, { source: 3 }, smoothGradient, { source: 1 }, greyWall, { source: 7 }],
      joins: ['slideup', 'slideleft', 'slidedown', 'slideright', 'slideup'].map((transition, i): JoinSpec => ({ type: 'xfade', transition, atSec: 2 * (i + 1), durationSec: 0.15 })),
      totalSec: 12.15,
      audio: PINK_NOISE,
      truth: { motion: [{ axis: 'y', direction: 'up' }, { axis: 'x', direction: 'left' }, { axis: 'y', direction: 'down' }, { axis: 'x', direction: 'right' }, { axis: 'y', direction: 'up' }] },
    },
    // One shot with camera pans and tilts (a 540 × 960 window moving over a 1080 × 1920 picture): 0.2–0.5 s moves of
    // 31–56 % of the frame are the camera moving, not slides or wipes.
    x18: {
      name: 'x18-camera-pans-in-one-shot',
      shots: [{ lavfi: `testsrc2=s=1080x1920:r=${FPS}`, filter: `crop=w=540:h=960:x='100+${move(1.5, 0.3, 250)}-${move(5.5, 0.5, 300)}':y='400+${move(3.5, 0.2, 300)}-${move(7.5, 0.4, 500)}'` }],
      joins: [],
      totalSec: 9,
      audio: PINK_NOISE,
      truth: { joins: 0, moves: [{ axis: 'x', atSec: 1.5 }, { axis: 'y', atSec: 3.5 }, { axis: 'x', atSec: 5.5 }, { axis: 'y', atSec: 7.5 }] },
    },
    // A white end card reached by a 1 s linear cross-fade (the 0.5 s brightness baseline follows the ramp).
    x20: {
      name: 'x20-slow-fade-into-white-end-card',
      shots: [{ source: 0 }, { source: 1 }, { source: 3 }, whiteCard],
      joins: [...cuts([2, 4]), { type: 'xfade', transition: 'fade', atSec: 6, durationSec: 1 }],
      totalSec: 9.5,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4], endScreenStartSec: 6 },
    },
    // Slow fades into end cards whose banner fades in later: 1 s into a black card (its dark run starts late in the
    // fade), and 1.2 s into a white card with the banner 0.6 s after the fade (the fade reads as nothing, the banner as
    // a cross-fade).
    x21: {
      name: 'x21-slow-fade-into-black-end-card',
      shots: [{ source: 0 }, { source: 1 }, { source: 3 }, bannerCard('black', 1.6)],
      joins: [...cuts([2, 4]), { type: 'xfade', transition: 'fade', atSec: 6, durationSec: 1 }],
      totalSec: 10,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4], endScreenStartSec: 6 },
    },
    x22: {
      name: 'x22-slow-fade-into-white-end-card-with-banner',
      shots: [{ source: 0 }, { source: 1 }, { source: 3 }, bannerCard('white', 1.8)],
      joins: [...cuts([2, 4]), { type: 'xfade', transition: 'fade', atSec: 6, durationSec: 1.2 }],
      totalSec: 10.2,
      audio: PINK_NOISE,
      truth: { cuts: [2, 4], endScreenStartSec: 6 },
    },
  };
}
