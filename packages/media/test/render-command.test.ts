import { describe, expect, it } from 'vitest';
import { computeTimeline } from '@studio/core';
import { atempoChain, buildRenderCommand, escapeFilterPath, formatNumber, segmentFrameCount, type RenderInputs } from '../src/render/index.js';
import { ASSET_IDS, FONTS_DIR, MUSIC_TRACK_ID, SAMPLE_FILES, TEST_BRAND, fakeProbe, samplePlan } from './render-fixtures.js';

function baseInputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    plan: samplePlan(),
    assets: {
      [ASSET_IDS.a]: { path: SAMPLE_FILES.a, probe: fakeProbe({ durationSec: 12, hasAudio: true }) },
      [ASSET_IDS.b]: { path: SAMPLE_FILES.b, probe: fakeProbe({ durationSec: 10, hasAudio: true, hdr: true, rotated: true }) },
      [ASSET_IDS.c]: { path: SAMPLE_FILES.c, probe: fakeProbe({ durationSec: 6, hasAudio: false }) },
    },
    music: { path: SAMPLE_FILES.music, durationSec: 40, trackId: MUSIC_TRACK_ID },
    quality: 'preview',
    brand: TEST_BRAND,
    fontsDir: FONTS_DIR,
    tmpDir: '/tmp/studio-render-tests',
    ...overrides,
  };
}

function lastValueAfter(args: string[], flag: string): string | undefined {
  const idx = args.lastIndexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('buildRenderCommand', () => {
  const inputs = baseInputs();
  const command = buildRenderCommand(inputs, '/tmp/out/preview.mp4', '/tmp/studio-render-tests/overlay.ass');
  const timeline = computeTimeline(inputs.plan);

  it('seeks each segment on its own input and adds the music last', () => {
    const { args } = command;
    expect(args.slice(0, 6)).toEqual(['-ss', '0.500', '-t', '3.000', '-i', SAMPLE_FILES.a]);
    const inputPaths = args.filter((_, i) => args[i - 1] === '-i');
    expect(inputPaths).toEqual([SAMPLE_FILES.a, SAMPLE_FILES.b, SAMPLE_FILES.c, SAMPLE_FILES.a, SAMPLE_FILES.music]);
    expect(args.slice(args.indexOf(SAMPLE_FILES.b) - 5, args.indexOf(SAMPLE_FILES.b))).toEqual(['-ss', '1.000', '-t', '2.500', '-i']);
  });

  it('places xfade offsets at the timeline start times and uses concat for hard cuts', () => {
    const offsets = [...command.filterComplex.matchAll(/xfade=transition=(\w+):duration=([\d.]+):offset=([\d.]+)/g)];
    expect(offsets.map((m) => m[1])).toEqual(['fade', 'wipeleft']);
    expect(Number(offsets[0]?.[3])).toBeCloseTo(timeline.segments[1]!.startSec, 6);
    expect(Number(offsets[1]?.[3])).toBeCloseTo(timeline.segments[2]!.startSec, 6);
    expect(Number(offsets[0]?.[3])).toBeCloseTo(1.5, 6);
    expect(Number(offsets[1]?.[3])).toBeCloseTo(3.6, 6);
    expect(command.filterComplex).toContain('[v_0][v_1]xfade=');
    expect(command.filterComplex).toContain('[x_1][v_2]xfade=');
    expect(command.filterComplex).toContain('[x_2][v_3]concat=n=2:v=1:a=0,settb=1/30[x_3]');
    expect(command.filterComplex.match(/concat=/g)).toHaveLength(1);
  });

  it('trims the output to the timeline total', () => {
    expect(command.totalDurationSec).toBeCloseTo(8.6, 3);
    expect(lastValueAfter(command.args, '-t')).toBe(formatNumber(timeline.totalDurationSec));
    expect(command.args.at(-1)).toBe('/tmp/out/preview.mp4');
    expect(command.args.slice(-3)).toEqual(['-f', 'mp4', '/tmp/out/preview.mp4']);
  });

  it('tone-maps only HDR clips and keeps the chain per segment in order', () => {
    const chains = command.filterComplex.split(';');
    const chain0 = chains.find((c) => c.startsWith('[0:v]'))!;
    const chain1 = chains.find((c) => c.startsWith('[1:v]'))!;
    const chain2 = chains.find((c) => c.startsWith('[2:v]'))!;
    expect(chain1).toContain('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    expect(chain0).not.toContain('zscale');
    expect(chain2).not.toContain('zscale');
    expect(chain0).toContain('[0:v]setpts=PTS-STARTPTS,setpts=PTS/1.5,fps=30,trim=end_frame=60,scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2');
    expect(chain0).toContain("zoompan=z='1+(1.1-1)*min(on/59,1)':x='(iw-iw/zoom)*0.5':y='(ih-ih/zoom)*0.5':d=1:s=540x960:fps=30");
    expect(chain0).toContain('eq=contrast=1.03:saturation=1.05');
    expect(chain0.endsWith('setsar=1,settb=1/30[v_0]')).toBe(true);
    expect(chain2).toContain('crop=540:960:x=(iw-540)*0.3:y=(ih-960)*0.4');
    expect(chain1).toContain('crop=540:960:x=(iw-540)*0.5:y=(ih-960)*0.5');
    expect(chain1).not.toContain('zoompan');
  });

  it('builds the music stem with fades and ducking, mixes in kept original sound and normalises loudness', () => {
    const fc = command.filterComplex;
    expect(fc).toContain('[4:a]atrim=start=2:end=10.6,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.85,afade=t=in:st=0:d=0.3,afade=t=out:st=7.4:d=1.2');
    expect(fc).toContain("volume=0.25:enable='between(t,0,2)'");
    expect(fc).toContain('[0:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atempo=1.5,');
    expect(fc).toContain('adelay=0|0,apad,atrim=end=8.6[o_0]');
    expect(fc).toContain('[music][o_0]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]');
    expect(fc).not.toContain('[o_1]');
    expect(fc).not.toContain('[o_3]');
    const { args } = command;
    expect(args).toContain('[aout]');
    expect(args.slice(args.indexOf('[aout]') + 1, args.indexOf('[aout]') + 9)).toEqual(['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']);
    expect(args).not.toContain('-an');
  });

  it('burns the ASS file through libass with an escaped path and fonts directory', () => {
    expect(command.filterComplex).toContain(`[x_3]ass=filename=${escapeFilterPath('/tmp/studio-render-tests/overlay.ass')}:fontsdir=${escapeFilterPath(FONTS_DIR)}[vout]`);
    const noText = buildRenderCommand(inputs, '/tmp/out/preview.mp4', null);
    expect(noText.filterComplex).toContain('[x_3]null[vout]');
    expect(noText.filterComplex).not.toContain('ass=');
    expect(noText.args).toContain('[vout]');
  });

  it('encodes previews fast and exports at full quality', () => {
    const preview = command.args;
    expect(preview).toEqual(expect.arrayContaining(['-preset', 'veryfast', '-crf', '27', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-bf', '2', '-movflags', '+faststart']));
    expect(preview.slice(preview.indexOf('-colorspace'), preview.indexOf('-colorspace') + 6)).toEqual(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']);
    expect(preview).not.toContain('-threads');
    expect(preview).not.toContain('-filter_threads');

    const exportCommand = buildRenderCommand(baseInputs({ quality: 'export', threads: 2 }), '/tmp/out/export.mp4', null);
    expect(exportCommand.args).toEqual(expect.arrayContaining(['-preset', 'slow', '-crf', '18', '-level', '4.2', '-filter_threads', '2', '-threads', '2']));
    expect(exportCommand.filterComplex).toContain('scale=1080:1920:force_original_aspect_ratio=increase');
    expect(exportCommand.filterComplex).toContain('s=1080x1920');
    expect(exportCommand.args.indexOf('-filter_threads')).toBe(0);
  });

  it('omits audio entirely when nothing in the plan makes a sound', () => {
    const plan = samplePlan();
    plan.segments = [{ ...plan.segments[2]!, transitionIn: null, inSec: 0.5, outSec: 4.5 }];
    plan.textOverlays = [];
    plan.audio.music = null;
    const silent = buildRenderCommand(baseInputs({ plan, music: null }), '/tmp/out/silent.mp4', null);
    expect(silent.args).toContain('-an');
    expect(silent.args).not.toContain('[aout]');
    expect(silent.filterComplex).not.toContain('amix');
    expect(silent.filterComplex).not.toContain('loudnorm');
    expect(silent.filterComplex).toBe(
      '[0:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=120,scale=540:960:force_original_aspect_ratio=increase:force_divisible_by=2:flags=bicubic,crop=540:960:x=(iw-540)*0.3:y=(ih-960)*0.4,format=yuv420p,eq=contrast=1.03:saturation=1.05,setsar=1,settb=1/30[v_0];[v_0]null[vout]',
    );
    expect(lastValueAfter(silent.args, '-t')).toBe('4');
  });

  it('keeps original sound for every segment when it is enabled globally, and ignores clips without audio', () => {
    const plan = samplePlan();
    plan.audio.originalSound = { enabled: true, volume: 0.6 };
    plan.audio.music = null;
    const fc = buildRenderCommand(baseInputs({ plan, music: null }), '/tmp/out/original.mp4', null).filterComplex;
    expect(fc).toContain('[o_0]');
    expect(fc).toContain('[o_1]');
    expect(fc).not.toContain('[o_2]');
    expect(fc).toContain('[o_3]');
    expect(fc).toContain('volume=0.6,adelay=6600|6600');
    expect(fc).toContain('[1:a]asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,afade=t=in:st=0:d=0.5,afade=t=out:st=2.1:d=0.4,volume=0.6,adelay=1500|1500');
    expect(fc).toContain('amix=inputs=3:normalize=0:duration=longest');
  });

  it('rejects a plan that refers to a clip it was not given', () => {
    const plan = samplePlan();
    plan.segments[0]!.assetId = 'missing';
    expect(() => buildRenderCommand(baseInputs({ plan }), '/tmp/out/x.mp4', null)).toThrow(/not available/);
  });
});

describe('atempoChain', () => {
  it('splits speed changes into stages within 0.5–2', () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(1.5)).toEqual(['atempo=1.5']);
    expect(atempoChain(2)).toEqual(['atempo=2']);
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5']);
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2']);
    expect(atempoChain(0.5)).toEqual(['atempo=0.5']);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(atempoChain(0.3)).toEqual(['atempo=0.5', 'atempo=0.6']);
    expect(() => atempoChain(0)).toThrow(RangeError);
  });
});

describe('escapeFilterPath', () => {
  it('escapes the characters both FFmpeg parsing levels care about', () => {
    expect(escapeFilterPath('/plain/path/overlay.ass')).toBe('/plain/path/overlay.ass');
    expect(escapeFilterPath('C:/a')).toBe('C\\\\:/a');
    expect(escapeFilterPath("it's")).toBe("it\\\\\\'s");
    expect(escapeFilterPath('a\\b')).toBe('a\\\\\\\\b');
    expect(escapeFilterPath('x,y;z[1]')).toBe('x\\,y\\;z\\[1\\]');
    expect(escapeFilterPath('my dir/f.ass')).toBe('my\\\\\\ dir/f.ass');
  });
});

describe('frame maths', () => {
  it('quantises play durations to whole frames and formats numbers plainly', () => {
    expect(segmentFrameCount(2, 30)).toBe(60);
    expect(segmentFrameCount(2.5 / 1.5, 30)).toBe(50);
    expect(segmentFrameCount(0.01, 30)).toBe(1);
    expect(formatNumber(8.6)).toBe('8.6');
    expect(formatNumber(1 / 3)).toBe('0.333333');
    expect(formatNumber(2)).toBe('2');
    expect(formatNumber(-0.0000001)).toBe('0');
  });
});
