import { describe, it } from 'vitest';
import { execa } from 'execa';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMedia } from '../src/ffprobe.js';
import { makeProxy, makeThumbnail, extractFrames, detectScenes, measureQuality, analyseAudio, decodePcm, detectBeats, analyseMusic, speechStats, measureGreyFrame } from '../src/analysis/index.js';

const samples = fileURLToPath(new URL('../../../data/samples/', import.meta.url));
const S = (n: string) => path.join(samples, n);

async function lavfi(out: string, src: string, vf: string | null): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, ...(vf ? ['-vf', vf] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out];
  await execa('ffmpeg', args);
}

describe('calibration', () => {
  it('measures', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sa-cal-'));
    const t0 = Date.now();
    const sharp = path.join(dir, 'sharp.mp4');
    const blurred = path.join(dir, 'blur.mp4');
    const dark = path.join(dir, 'dark.mp4');
    await lavfi(sharp, 'testsrc2=size=320x568:rate=30:duration=3', null);
    await lavfi(blurred, 'testsrc2=size=320x568:rate=30:duration=3', 'gblur=sigma=6');
    await lavfi(dark, 'testsrc2=size=320x568:rate=30:duration=3', 'eq=brightness=-0.45');
    for (const f of [sharp, blurred, dark]) {
      const probe = await probeMedia(f);
      const q = await measureQuality(f, [{ startSec: 0, endSec: 3 }], { probe });
      console.log(path.basename(f), JSON.stringify(q));
    }
    console.log('synthetic clips ms', Date.now() - t0);

    const pb = await probeMedia(S('sample_b_rotated_hevc_hlg.mov'));
    const pa = await probeMedia(S('sample_a_portrait_sdr.mp4'));
    const pc = await probeMedia(S('sample_c_noaudio_scenes.mp4'));
    const pd = await probeMedia(S('sample_d_tiny.mp4'));
    let t = Date.now();
    const proxy = await makeProxy(S('sample_b_rotated_hevc_hlg.mov'), path.join(dir, 'proxy_b.mp4'), { probe: pb, onProgress: (f) => void f });
    console.log('proxy b', proxy, 'ms', Date.now() - t);
    const pp = await probeMedia(path.join(dir, 'proxy_b.mp4'));
    console.log('proxy probe', JSON.stringify(pp));
    const stats = await execa('ffmpeg', ['-hide_banner', '-i', path.join(dir, 'proxy_b.mp4'), '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-frames:v', '3', '-f', 'null', '-'], { reject: false });
    console.log('proxy YAVG', stats.stderr.split('\n').filter((l) => l.includes('YAVG')).slice(0, 3).join(' | '));
    t = Date.now();
    const proxyC = await makeProxy(S('sample_c_noaudio_scenes.mp4'), path.join(dir, 'proxy_c.mp4'), { probe: pc });
    console.log('proxy c', proxyC, 'ms', Date.now() - t, JSON.stringify((await probeMedia(path.join(dir, 'proxy_c.mp4'))).audio));
    t = Date.now();
    console.log('thumb', await makeThumbnail(S('sample_b_rotated_hevc_hlg.mov'), path.join(dir, 'thumb.jpg'), { probe: pb, timeSec: 3 }), 'ms', Date.now() - t);
    console.log('thumb probe', JSON.stringify((await probeMedia(path.join(dir, 'thumb.jpg'))).video));
    t = Date.now();
    const frames = await extractFrames(S('sample_b_rotated_hevc_hlg.mov'), [1, 5], path.join(dir, 'frames'), { probe: pb });
    console.log('frames', frames, 'ms', Date.now() - t);
    for (const f of frames) console.log('frame probe', JSON.stringify((await probeMedia(f.path)).video));
    t = Date.now();
    const scenes = await detectScenes(S('sample_c_noaudio_scenes.mp4'), { probe: pc });
    console.log('scenes c', JSON.stringify(scenes), 'ms', Date.now() - t);
    console.log('scenes a', JSON.stringify(await detectScenes(S('sample_a_portrait_sdr.mp4'), { probe: pa })));
    console.log('scenes d', JSON.stringify(await detectScenes(S('sample_d_tiny.mp4'), { probe: pd })));
    t = Date.now();
    console.log('quality c', JSON.stringify(await measureQuality(S('sample_c_noaudio_scenes.mp4'), scenes, { probe: pc })), 'ms', Date.now() - t);
    console.log('quality b', JSON.stringify(await measureQuality(S('sample_b_rotated_hevc_hlg.mov'), [{ startSec: 0, endSec: 10 }], { probe: pb })));
    console.log('quality a', JSON.stringify(await measureQuality(S('sample_a_portrait_sdr.mp4'), [{ startSec: 0, endSec: 12 }], { probe: pa })));
    t = Date.now();
    console.log('audio a', JSON.stringify(await analyseAudio(S('sample_a_portrait_sdr.mp4'), { probe: pa })), 'ms', Date.now() - t);
    console.log('audio b', JSON.stringify(await analyseAudio(S('sample_b_rotated_hevc_hlg.mov'), { probe: pb })));
    console.log('audio c', JSON.stringify(await analyseAudio(S('sample_c_noaudio_scenes.mp4'), { probe: pc })));
    console.log('audio d', JSON.stringify(await analyseAudio(S('sample_d_tiny.mp4'), { probe: pd })));

    // Synthetic speech-like signal: harmonic series with formant weighting, 4 Hz syllables, jittered F0.
    const sr = 16000;
    const speech = new Float32Array(sr * 6);
    let phase = 0;
    for (let i = 0; i < speech.length; i++) {
      const tt = i / sr;
      const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * tt);
      phase += (2 * Math.PI * f0) / sr;
      let v = 0;
      for (let h = 1; h <= 24; h++) {
        const fh = h * f0;
        const formant = Math.exp(-0.5 * ((fh - 600) / 250) ** 2) + 0.7 * Math.exp(-0.5 * ((fh - 1600) / 350) ** 2) + 0.3 * Math.exp(-0.5 * ((fh - 2600) / 400) ** 2);
        v += (formant / h ** 0.3) * Math.sin(h * phase);
      }
      const syll = Math.max(0, Math.sin(2 * Math.PI * 4 * tt)) ** 2;
      speech[i] = 0.3 * v * syll + 0.002 * (Math.random() - 0.5);
    }
    console.log('speech synthetic', JSON.stringify(speechStats(speech, sr)));
    const tone = new Float32Array(sr * 6);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
    console.log('speech tone', JSON.stringify(speechStats(tone, sr)));
    const pink = await decodePcm(S('sample_b_rotated_hevc_hlg.mov'), { sampleRate: 16000 });
    console.log('speech pink', JSON.stringify(speechStats(pink, sr)));

    // Beats: synthetic click track 120 BPM at 22050 Hz, 20 s.
    const bsr = 22050;
    const clicks = new Float32Array(bsr * 20);
    for (let i = 0; i < clicks.length; i++) clicks[i] = 0.005 * (Math.random() - 0.5);
    for (let b = 0; b * 0.5 < 20; b++) {
      const start = Math.round(b * 0.5 * bsr);
      for (let k = 0; k < 400 && start + k < clicks.length; k++) clicks[start + k]! += 0.8 * Math.exp(-k / 80) * Math.sin((2 * Math.PI * 1500 * k) / bsr);
    }
    t = Date.now();
    const beats = detectBeats(clicks, bsr);
    console.log('beats synthetic', beats.bpm, beats.confidence, 'ms', Date.now() - t, 'n', beats.beatTimesSec.length);
    const offsets = beats.beatTimesSec.map((bt) => bt - Math.round(bt / 0.5) * 0.5);
    console.log('offsets first 10', offsets.slice(0, 10).map((o) => (o * 1000).toFixed(1)).join(','), 'mean ms', ((offsets.reduce((a, b) => a + b, 0) / offsets.length) * 1000).toFixed(2), 'max abs ms', (Math.max(...offsets.map(Math.abs)) * 1000).toFixed(1));
    const silence = new Float32Array(bsr * 20);
    console.log('beats silence', JSON.stringify({ ...detectBeats(silence, bsr), energy: undefined }));
    const noise = new Float32Array(bsr * 20);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.05 * (Math.random() - 0.5);
    console.log('beats noise', JSON.stringify({ ...detectBeats(noise, bsr), energy: undefined, beatTimesSec: undefined }));
    t = Date.now();
    const pm = await probeMedia(S('sample_music_120bpm.mp3'));
    const music = await analyseMusic(S('sample_music_120bpm.mp3'), { probe: pm });
    console.log('music', music.bpm, music.confidence, music.durationSec, 'beats', music.beatTimesSec.length, 'first', music.beatTimesSec.slice(0, 8).join(','), 'ms', Date.now() - t);
    const moff = music.beatTimesSec.map((bt) => bt - Math.round(bt / 0.5) * 0.5);
    console.log('music offsets mean ms', ((moff.reduce((a, b) => a + b, 0) / moff.length) * 1000).toFixed(2), 'max abs', (Math.max(...moff.map(Math.abs)) * 1000).toFixed(1));
    console.log('total ms', Date.now() - t0);
  }, 300_000);
});
