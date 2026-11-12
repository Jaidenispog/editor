import { describe, expect, it } from 'vitest';
import { VERTICAL_1080, VERTICAL_PREVIEW, VERTICAL_SAFE_ZONE_1080x1920, computeTimeline, safeArea, scaleSafeZone } from '@studio/core';
import { buildAssDocument, colourToAss, escapeAssText, formatAssTime, wrapCaptionText } from '../src/render/index.js';
import { TEST_BRAND, samplePlan } from './render-fixtures.js';

const FONTS = { headline: 'Inter Display', body: 'Inter' };

function buildPreviewDoc(plan = samplePlan(), brand = TEST_BRAND) {
  const zone = scaleSafeZone(VERTICAL_SAFE_ZONE_1080x1920, VERTICAL_PREVIEW.width, VERTICAL_PREVIEW.height);
  return { doc: buildAssDocument(plan, computeTimeline(plan), VERTICAL_PREVIEW, zone, brand, FONTS), zone };
}

function dialogueLines(doc: string): string[] {
  return doc.split('\n').filter((l) => l.startsWith('Dialogue:'));
}

describe('buildAssDocument', () => {
  it('declares the script at the output size with libass-friendly settings', () => {
    const { doc } = buildPreviewDoc();
    expect(doc).toContain('PlayResX: 540');
    expect(doc).toContain('PlayResY: 960');
    expect(doc).toContain('WrapStyle: 0');
    expect(doc).toContain('ScaledBorderAndShadow: yes');
    expect(doc).toContain('[V4+ Styles]');
    expect(doc).toContain('[Events]');
  });

  it('keeps every positioned line inside the safe area and wraps within its margins', () => {
    const { doc, zone } = buildPreviewDoc();
    const area = safeArea(zone);
    const lines = dialogueLines(doc);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const points: Array<[number, number]> = [];
    for (const line of lines) {
      const pos = /\\pos\((-?\d+),(-?\d+)\)/.exec(line);
      const move = /\\move\((-?\d+),(-?\d+),(-?\d+),(-?\d+),/.exec(line);
      expect(pos ?? move).not.toBeNull();
      if (pos) points.push([Number(pos[1]), Number(pos[2])]);
      if (move) {
        points.push([Number(move[1]), Number(move[2])]);
        points.push([Number(move[3]), Number(move[4])]);
      }
    }
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(area.x);
      expect(x).toBeLessThanOrEqual(area.x + area.width);
      expect(y).toBeGreaterThanOrEqual(area.y);
      expect(y).toBeLessThanOrEqual(area.y + area.height);
    }
    // Horizontally centred on the safe area (which is off-centre because of the right rail).
    const centreX = Math.round(area.x + area.width / 2);
    expect(points.every(([x]) => x === centreX)).toBe(true);
    // Styles carry the safe-zone margins so libass wraps long lines inside them.
    for (const style of doc.split('\n').filter((l) => l.startsWith('Style:'))) {
      const fields = style.split(',');
      expect(Number(fields[19])).toBe(zone.left);
      expect(Number(fields[20])).toBe(zone.right);
    }
  });

  it('places top, lower and centre text where the placement says, with the right animation', () => {
    const { doc, zone } = buildPreviewDoc();
    const area = safeArea(zone);
    const lines = dialogueLines(doc);
    const top = lines.find((l) => l.includes('Fresh skin fade'))!;
    const lower = lines.find((l) => l.includes("Ivanhoe's finest"))!;
    const centre = lines.find((l) => l.includes('BEFORE'))!;
    expect(top).toMatch(/\{\\an8\\move\(\d+,\d+,\d+,\d+,0,350\)\\fad\(200,250\)\}/);
    const topY = Number(/\\move\(\d+,\d+,\d+,(\d+),/.exec(top)![1]);
    expect(topY).toBeLessThan(area.y + area.height * 0.1);
    expect(lower).toContain('HeadlineAccent');
    expect(lower).toMatch(/\{\\an2\\pos\(\d+,\d+\)\\fad\(120,200\)\\t\(0,180,\\fscx108\\fscy108\)\\t\(180,320,\\fscx100\\fscy100\)\}/);
    const lowerY = Number(/\\pos\(\d+,(\d+)\)/.exec(lower)![1]);
    expect(lowerY).toBeGreaterThan(area.y + area.height * 0.9);
    expect(lowerY).toBeLessThanOrEqual(area.y + area.height);
    expect(centre).toContain('Label');
    expect(centre).toMatch(/\{\\an5\\pos\(\d+,\d+\)\\fad\(250,250\)\}BEFORE$/);
    const centreY = Number(/\\pos\(\d+,(\d+)\)/.exec(centre)![1]);
    expect(centreY).toBe(Math.round(area.y + area.height / 2));
    expect(lines.find((l) => l.includes('Book online'))).toContain(',Subtitle,');
  });

  it('converts the brand colour for accent styles', () => {
    const { doc } = buildPreviewDoc();
    expect(doc).toMatch(/^Style: HeadlineAccent,Inter Display,\d+,&H004AA2C8,&H004AA2C8,&H00000000,&H80000000,700,/m);
    expect(doc).toMatch(/^Style: Headline,Inter Display,\d+,&H00FFFFFF,/m);
    expect(doc).toMatch(/^Style: Caption,Inter,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,600,/m);
  });

  it('scales type and strokes with the output size and treatment', () => {
    const plan = samplePlan();
    const zone = scaleSafeZone(VERTICAL_SAFE_ZONE_1080x1920, VERTICAL_1080.width, VERTICAL_1080.height);
    const full = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, TEST_BRAND, FONTS);
    expect(full).toMatch(/^Style: Headline,Inter Display,100,.*,700,0,0,0,100,100,0,0,1,3,1,2,70,150,/m);
    const bold = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, { ...TEST_BRAND, videoTextStyle: 'bold' }, FONTS);
    expect(bold).toMatch(/^Style: Headline,Inter Display,115,.*,800,/m);
    const editorial = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, { ...TEST_BRAND, videoTextStyle: 'editorial' }, FONTS);
    expect(editorial).toMatch(/^Style: Headline,Inter Display,95,.*,500,0,0,0,100,100,3\.84,/m);
  });

  it('escapes braces, backslashes and line breaks in user text', () => {
    const plan = samplePlan();
    plan.textOverlays = [{ id: 'x', text: 'Fresh {fade}\nback\\Nslash', startSec: 0.5, endSec: 2, placement: 'lower', style: 'headline', animation: 'none', emphasis: 'normal' }];
    const { doc } = buildPreviewDoc(plan, { ...TEST_BRAND, socialHandle: '' });
    const line = dialogueLines(doc)[0]!;
    expect(line.endsWith('}Fresh \\{fade\\}\\Nback\\⁠Nslash')).toBe(true);
    expect(line).toMatch(/\{\\an2\\pos\(\d+,\d+\)\}Fresh/);
    expect(escapeAssText('{a}')).toBe('\\{a\\}');
    expect(escapeAssText('one\r\ntwo')).toBe('one\\Ntwo');
  });

  it('puts captions in the Caption style at the bottom of the safe area, wrapped to two lines', () => {
    const plan = samplePlan();
    plan.captions = [
      { text: 'Clean skin fade today', startSec: 0.5, endSec: 2.2 },
      { text: 'Blending the sides into the top with a two guard and a little texture', startSec: 2.5, endSec: 5.5 },
    ];
    const { doc, zone } = buildPreviewDoc(plan);
    const area = safeArea(zone);
    const captions = dialogueLines(doc).filter((l) => l.includes(',Caption,'));
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatch(/^Dialogue: 0,0:00:00\.50,0:00:02\.20,Caption,,0,0,0,,\{\\an2\\pos\(\d+,\d+\)\\fad\(60,60\)\}Clean skin fade today$/);
    const long = captions[1]!;
    expect(long.split('\\N')).toHaveLength(2);
    expect(long).toContain('\\fs');
    const y = Number(/\\pos\(\d+,(\d+)\)/.exec(long)![1]);
    expect(y).toBeLessThanOrEqual(area.y + area.height);
    expect(y).toBeGreaterThan(area.y + area.height - 30);
    // The lower headline that shares time with the first caption is lifted above the caption block.
    const lowerHeadline = dialogueLines(doc).find((l) => l.includes("Ivanhoe's finest"))!;
    const lowerY = Number(/\\pos\(\d+,(\d+)\)/.exec(lowerHeadline)![1]);
    expect(lowerY).toBeLessThan(y - 60);
  });

  it('shows the brand handle at the end only where there is room, and never twice', () => {
    const { doc } = buildPreviewDoc();
    const handle = dialogueLines(doc).filter((l) => l.includes('@ivanhoe.barber'));
    // "Book online" occupies the lower slot at the end, so the handle moves to the top.
    expect(handle).toHaveLength(1);
    expect(handle[0]).toMatch(/^Dialogue: 1,0:00:06\.10,0:00:08\.60,Handle,,0,0,0,,\{\\an8\\pos\(\d+,\d+\)\\fad\(250,250\)\}@ivanhoe\.barber$/);

    const plan = samplePlan();
    plan.textOverlays = [{ id: 'cta', text: 'Follow @ivanhoe.barber', startSec: 6.8, endSec: 8.4, placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal' }];
    expect(dialogueLines(buildPreviewDoc(plan).doc).filter((l) => l.includes(',Handle,'))).toHaveLength(0);

    const quiet = samplePlan();
    quiet.textOverlays = [];
    const lowerHandle = dialogueLines(buildPreviewDoc(quiet).doc).find((l) => l.includes(',Handle,'))!;
    expect(lowerHandle).toMatch(/\{\\an2\\pos\(/);
    expect(dialogueLines(buildPreviewDoc(quiet, { ...TEST_BRAND, socialHandle: '  ' }).doc)).toHaveLength(0);
  });
});

describe('colourToAss', () => {
  it('converts #RRGGBB to &HAABBGGRR', () => {
    expect(colourToAss('#C8A24A')).toBe('&H004AA2C8');
    expect(colourToAss('#ffffff')).toBe('&H00FFFFFF');
    expect(colourToAss('#000000', 128)).toBe('&H80000000');
    expect(colourToAss('123456')).toBe('&H00563412');
    expect(() => colourToAss('#12345')).toThrow(/hex colour/);
    expect(() => colourToAss('red')).toThrow(/hex colour/);
  });
});

describe('formatAssTime', () => {
  it('formats h:mm:ss.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00');
    expect(formatAssTime(61.257)).toBe('0:01:01.26');
    expect(formatAssTime(3600)).toBe('1:00:00.00');
    expect(formatAssTime(-2)).toBe('0:00:00.00');
    expect(formatAssTime(8.6)).toBe('0:00:08.60');
  });
});

describe('wrapCaptionText', () => {
  it('wraps greedily at the character limit and widens rather than exceeding the line limit', () => {
    expect(wrapCaptionText('Clean skin fade today')).toEqual(['Clean skin fade today']);
    expect(wrapCaptionText('Blending the sides into the top with a two guard')).toEqual(['Blending the sides into', 'the top with a two guard']);
    const long = wrapCaptionText('Blending the sides into the top with a two guard and a little texture on top');
    expect(long).toHaveLength(2);
    expect(long.join(' ')).toBe('Blending the sides into the top with a two guard and a little texture on top');
    expect(wrapCaptionText('   ')).toEqual([]);
    expect(wrapCaptionText('Supercalifragilisticexpialidocious today', 10, 2)).toEqual(['Supercalifragilisticexpialidocious', 'today']);
  });
});
