import { describe, expect, it } from 'vitest';
import {
  AppError,
  VERTICAL_1080,
  VERTICAL_PREVIEW,
  VERTICAL_SAFE_ZONE_1080x1920,
  computeTimeline,
  forbiddenAreasTouched,
  isSubtitleBoxSafe,
  isTextBoxSafe,
  rectWidth,
  safeZoneFor,
  type EditPlan,
  type SafeZone,
} from '@studio/core';
import {
  POP_SCALE,
  buildAssDocument,
  colourToAss,
  escapeAssText,
  formatAssTime,
  layoutAssDocument,
  textMetricsFor,
  wrapTextToWidth,
  type AssTextBox,
} from '../src/render/index.js';
import { TEST_BRAND, samplePlan } from './render-fixtures.js';

const FONTS = { headline: 'Inter Display', body: 'Inter' };

function previewLayout(plan = samplePlan(), brand = TEST_BRAND, zone: SafeZone = safeZoneFor(VERTICAL_PREVIEW.width, VERTICAL_PREVIEW.height)) {
  return { ...layoutAssDocument(plan, computeTimeline(plan), VERTICAL_PREVIEW, zone, brand, FONTS), zone };
}

function dialogueLines(doc: string): string[] {
  return doc.split('\n').filter((l) => l.startsWith('Dialogue:'));
}

function styleSize(doc: string, name: string): number {
  const line = doc.split('\n').find((l) => l.startsWith(`Style: ${name},`))!;
  return Number(line.split(',')[2]);
}

function boxFor(boxes: AssTextBox[], ref: string): AssTextBox {
  const found = boxes.find((b) => b.ref === ref);
  if (!found) throw new Error(`no box for ${ref}`);
  return found;
}

/** Every box must clear every forbidden area; head boxes must end above the action column; captions follow the subtitle rules. */
function expectAllSafe(boxes: AssTextBox[], zone: SafeZone) {
  for (const b of boxes) {
    expect(forbiddenAreasTouched(zone, b.box), `${b.ref} ${JSON.stringify(b.box)}`).toEqual([]);
    expect(isTextBoxSafe(zone, b.box)).toBe(true);
    if (b.region === 'head') expect(b.box.bottom).toBeLessThanOrEqual(zone.head.bottom);
    if (b.region === 'strict') expect(b.box.right).toBeLessThanOrEqual(zone.strict.right);
    if (b.region === 'subtitle') expect(isSubtitleBoxSafe(zone, b.box), `${b.ref} ${JSON.stringify(b.box)}`).toBe(true);
  }
}

describe('layoutAssDocument', () => {
  it('declares the script at the output size and wraps lines itself', () => {
    const { document } = previewLayout();
    expect(document).toContain('PlayResX: 540');
    expect(document).toContain('PlayResY: 960');
    expect(document).toContain('WrapStyle: 2');
    expect(document).toContain('ScaledBorderAndShadow: yes');
    expect(document).toContain('[V4+ Styles]');
    expect(document).toContain('[Events]');
  });

  it('keeps every line, at every animation frame, out of the forbidden areas', () => {
    for (const style of ['minimal', 'bold', 'editorial'] as const) {
      for (const output of [VERTICAL_PREVIEW, VERTICAL_1080]) {
        const plan = samplePlan();
        plan.captions = [
          { text: 'Clean skin fade today', startSec: 0.5, endSec: 2.2 },
          { text: 'Blending the sides into the top with a two guard and a little texture', startSec: 2.5, endSec: 5.5 },
        ];
        const zone = safeZoneFor(output.width, output.height);
        const { boxes } = layoutAssDocument(plan, computeTimeline(plan), output, zone, { ...TEST_BRAND, videoTextStyle: style }, FONTS);
        expect(boxes.length).toBe(7);
        expectAllSafe(boxes, zone);
      }
    }
  });

  it('puts top text in the wide head region above the action column, centred on it', () => {
    const { document, boxes, zone } = previewLayout();
    const top = dialogueLines(document).find((l) => l.includes('Fresh skin fade'))!;
    expect(top).toMatch(/\{\\an8\\move\(270,(\d+),270,(\d+),0,350\)\\fad\(200,250\)\}Fresh skin fade$/);
    const [, fromY, toY] = /\\move\(\d+,(\d+),\d+,(\d+),/.exec(top)!.map(Number);
    expect(fromY! - toY!).toBe(20); // 40 px at 1920 tall, halved for the preview
    const box = boxFor(boxes, 't1');
    expect(box.region).toBe('head');
    expect(box.box.top).toBeGreaterThanOrEqual(zone.head.top);
    // The box covers the whole rise: it reaches at least one line height below the starting point.
    expect(box.box.bottom).toBeGreaterThanOrEqual(fromY! + box.fontSize);
    expect(box.box.bottom).toBeLessThanOrEqual(zone.head.bottom);
  });

  it('falls back to R_strict for top text that cannot end above the action column', () => {
    const preview = safeZoneFor(VERTICAL_PREVIEW.width, VERTICAL_PREVIEW.height);
    // A zone whose head region is too shallow for a headline forces the fallback.
    const shallow: SafeZone = { ...preview, head: { ...preview.head, bottom: preview.head.top + 20 } };
    const { document, boxes } = previewLayout(samplePlan(), TEST_BRAND, shallow);
    const box = boxFor(boxes, 't1');
    expect(box.region).toBe('strict');
    expect(box.box.right).toBeLessThanOrEqual(shallow.strict.right);
    expect(dialogueLines(document).find((l) => l.includes(box.lines.join('\\N')))).toMatch(/\\an8\\move\(225,/);
  });

  it('puts centre and lower text in R_strict, centred on it, with the right animation', () => {
    const { document, boxes, zone } = previewLayout();
    const lines = dialogueLines(document);
    const lower = lines.find((l) => l.includes("Ivanhoe's"))!;
    const centre = lines.find((l) => l.includes('BEFORE'))!;
    expect(lower).toContain('HeadlineAccent');
    expect(lower).toMatch(/\{\\an2\\pos\(225,\d+\)\\fad\(120,200\)\\t\(0,180,\\fscx108\\fscy108\)\\t\(180,320,\\fscx100\\fscy100\)\}/);
    expect(POP_SCALE).toBe(1.08);
    const lowerBox = boxFor(boxes, 't2');
    expect(lowerBox.region).toBe('strict');
    expect(lowerBox.box.bottom).toBeLessThanOrEqual(zone.strict.bottom);
    expect(lowerBox.box.bottom).toBeGreaterThan(zone.strict.bottom - 10);
    expect(centre).toContain('Label');
    expect(centre).toMatch(/\{\\an5\\pos\(225,\d+\)\\fad\(250,250\)\}BEFORE$/);
    const centreY = Number(/\\pos\(\d+,(\d+)\)/.exec(centre)![1]);
    expect(Math.abs(centreY - (zone.strict.top + zone.strict.bottom) / 2)).toBeLessThanOrEqual(2);
    expect(lines.find((l) => l.includes('Book online'))).toContain(',Subtitle,');
  });

  it('shrinks text that would not fit and never lets a pop or rise cross the edge', () => {
    const plan = samplePlan();
    plan.captions = [];
    plan.textOverlays = [
      { id: 'long-pop', text: 'Transformations', startSec: 0.5, endSec: 2, placement: 'lower', style: 'headline', animation: 'pop', emphasis: 'normal' },
      { id: 'long-rise', text: 'Skin fades, tapers, beard trims and hot towel shaves all week', startSec: 2, endSec: 4, placement: 'centre', style: 'headline', animation: 'rise', emphasis: 'normal' },
      { id: 'huge-word', text: 'Supercalifragilisticexpialidocious', startSec: 4, endSec: 6, placement: 'lower', style: 'headline', animation: 'pop', emphasis: 'normal' },
    ];
    const { document, boxes, zone } = previewLayout(plan, { ...TEST_BRAND, socialHandle: '' });
    expectAllSafe(boxes, zone);
    const pop = boxFor(boxes, 'long-pop');
    expect(pop.lines).toEqual(['Transformations']);
    expect(pop.fontSize).toBeLessThan(styleSize(document, 'Headline'));
    expect(dialogueLines(document)[0]).toContain(`{\\fs${pop.fontSize}}Transformations`);
    const rise = boxFor(boxes, 'long-rise');
    expect(rise.lines.length).toBeGreaterThan(1);
    expect(rise.lines.length).toBeLessThanOrEqual(3);
    expect(dialogueLines(document)[1]).toContain(rise.lines.join('\\N'));
    // A word too wide even at the smallest size is split between characters rather than refused.
    const huge = boxFor(boxes, 'huge-word');
    expect(huge.lines.length).toBeGreaterThan(1);
    expect(huge.lines.join('')).toBe('Supercalifragilisticexpialidocious');
  });

  it('refuses text that cannot fit at all', () => {
    const preview = safeZoneFor(VERTICAL_PREVIEW.width, VERTICAL_PREVIEW.height);
    const tiny: SafeZone = { ...preview, strict: { left: 60, top: 135, right: 70, bottom: 145 }, head: { left: 60, top: 135, right: 70, bottom: 145 } };
    const err = (() => {
      try {
        previewLayout(samplePlan(), TEST_BRAND, tiny);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION');
    expect((err as AppError).message).toMatch(/too long to fit/);
  });

  it('converts the brand colour for accent styles', () => {
    const { document } = previewLayout();
    expect(document).toMatch(/^Style: HeadlineAccent,Inter Display,\d+,&H004AA2C8,&H004AA2C8,&H00000000,&H80000000,700,/m);
    expect(document).toMatch(/^Style: Headline,Inter Display,\d+,&H00FFFFFF,/m);
    expect(document).toMatch(/^Style: Caption,Inter,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,600,/m);
  });

  it('scales type and strokes with the output size and treatment, with R_strict as the style margins', () => {
    const plan = samplePlan();
    const zone = VERTICAL_SAFE_ZONE_1080x1920;
    const full = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, TEST_BRAND, FONTS);
    expect(full).toMatch(/^Style: Headline,Inter Display,100,.*,700,0,0,0,100,100,0,0,1,3,1,2,120,300,672,1$/m);
    const bold = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, { ...TEST_BRAND, videoTextStyle: 'bold' }, FONTS);
    expect(bold).toMatch(/^Style: Headline,Inter Display,115,.*,800,/m);
    const editorial = buildAssDocument(plan, computeTimeline(plan), VERTICAL_1080, zone, { ...TEST_BRAND, videoTextStyle: 'editorial' }, FONTS);
    expect(editorial).toMatch(/^Style: Headline,Inter Display,95,.*,500,0,0,0,100,100,3\.84,/m);
    const { document } = previewLayout();
    expect(document).toMatch(/^Style: Headline,Inter Display,50,.*,2,60,150,336,1$/m);
  });

  it('escapes braces, backslashes and line breaks in user text', () => {
    const plan = samplePlan();
    plan.textOverlays = [{ id: 'x', text: 'Fresh {fade}\nback\\Nslash', startSec: 0.5, endSec: 2, placement: 'lower', style: 'headline', animation: 'none', emphasis: 'normal' }];
    const { document } = previewLayout(plan, { ...TEST_BRAND, socialHandle: '' });
    const line = dialogueLines(document)[0]!;
    expect(line.endsWith('}Fresh \\{fade\\}\\Nback\\⁠Nslash')).toBe(true);
    expect(line).toMatch(/\{\\an2\\pos\(\d+,\d+\)\}Fresh/);
    expect(escapeAssText('{a}')).toBe('\\{a\\}');
    expect(escapeAssText('one\r\ntwo')).toBe('one\\Ntwo');
  });

  it('sets captions by the subtitle rules: centred, at most 480 px wide (scaled), at least 56 px type, above y 1248', () => {
    const plan = samplePlan();
    plan.captions = [
      { text: 'Clean fade', startSec: 0.5, endSec: 2.2 },
      { text: 'Blending the sides into the top', startSec: 2.5, endSec: 5.5 },
    ];
    for (const output of [VERTICAL_PREVIEW, VERTICAL_1080]) {
      const zone = safeZoneFor(output.width, output.height);
      const { document, boxes } = layoutAssDocument(plan, computeTimeline(plan), output, zone, TEST_BRAND, FONTS);
      const captionSize = styleSize(document, 'Caption');
      expect(captionSize * textMetricsFor('Inter').emPerSize).toBeGreaterThanOrEqual(zone.subtitle.minTypePx);
      const captions = dialogueLines(document).filter((l) => l.includes(',Caption,'));
      expect(captions).toHaveLength(2);
      expect(captions[0]).toMatch(new RegExp(`^Dialogue: 0,0:00:00\\.50,0:00:02\\.20,Caption,,0,0,0,,\\{\\\\an2\\\\pos\\(${zone.subtitle.centreX},\\d+\\)\\\\fad\\(60,60\\)\\}Clean fade$`));
      const long = boxFor(boxes, 'caption-1');
      expect(long.lines.length).toBeGreaterThanOrEqual(2);
      expect(long.lines.join(' ')).toBe('Blending the sides into the top');
      expect(long.fontSize).toBeGreaterThanOrEqual(Math.ceil(zone.subtitle.minTypePx / textMetricsFor('Inter').emPerSize));
      expect(rectWidth(long.box)).toBeLessThanOrEqual(zone.subtitle.maxWidth);
      expect(long.box.bottom).toBeLessThanOrEqual(zone.subtitle.maxBottom);
      expect(long.box.bottom).toBeGreaterThan(zone.subtitle.maxBottom - 4 * (output.width / 540));
      expect(captions[1]).toContain(long.lines.join('\\N'));
      // The lower headline that shares time with the first caption sits above the caption box.
      const lowerHeadline = boxFor(boxes, 't2');
      expect(lowerHeadline.box.bottom).toBeLessThan(boxFor(boxes, 'caption-0').box.top);
    }
  });

  it('shows the brand handle at the end only where there is room, and never twice', () => {
    const { document, boxes } = previewLayout();
    const handle = dialogueLines(document).filter((l) => l.includes('@ivanhoe.barber'));
    // "Book online" occupies the lower slot at the end, so the handle moves to the top of R_strict.
    expect(handle).toHaveLength(1);
    expect(handle[0]).toMatch(/^Dialogue: 1,0:00:06\.10,0:00:08\.60,Handle,,0,0,0,,\{\\an8\\pos\(225,\d+\)\\fad\(250,250\)\}@ivanhoe\.barber$/);
    expect(boxFor(boxes, 'handle').region).toBe('strict');

    const plan = samplePlan();
    plan.textOverlays = [{ id: 'cta', text: 'Follow @ivanhoe.barber', startSec: 6.8, endSec: 8.4, placement: 'lower', style: 'subtitle', animation: 'fade', emphasis: 'normal' }];
    expect(dialogueLines(previewLayout(plan).document).filter((l) => l.includes(',Handle,'))).toHaveLength(0);

    const quiet = samplePlan();
    quiet.textOverlays = [];
    const lowerHandle = dialogueLines(previewLayout(quiet).document).find((l) => l.includes(',Handle,'))!;
    expect(lowerHandle).toMatch(/\{\\an2\\pos\(225,/);
    expect(dialogueLines(previewLayout(quiet, { ...TEST_BRAND, socialHandle: '  ' }).document)).toHaveLength(0);
  });

  it('buildAssDocument returns the same document', () => {
    const plan: EditPlan = samplePlan();
    const zone = safeZoneFor(VERTICAL_PREVIEW.width, VERTICAL_PREVIEW.height);
    expect(buildAssDocument(plan, computeTimeline(plan), VERTICAL_PREVIEW, zone, TEST_BRAND, FONTS)).toBe(previewLayout(plan).document);
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

describe('wrapTextToWidth', () => {
  // Ten pixels per character keeps the arithmetic obvious.
  const measure = (line: string) => line.length * 10;

  it('wraps to the pixel width and balances the lines', () => {
    expect(wrapTextToWidth('Clean skin fade today', 300, measure)).toEqual(['Clean skin fade today']);
    // Greedy alone would give "Blending the sides into the" / "top"; balancing evens it out.
    expect(wrapTextToWidth('Blending the sides into the top', 270, measure)).toEqual(['Blending the sides', 'into the top']);
    for (const line of wrapTextToWidth('Blending the sides into the top with a two guard and a little texture', 200, measure)!) {
      expect(measure(line)).toBeLessThanOrEqual(200);
    }
  });

  it('keeps explicit line breaks, drops empty paragraphs and refuses words wider than the line', () => {
    expect(wrapTextToWidth('One\n\ntwo', 300, measure)).toEqual(['One', 'two']);
    expect(wrapTextToWidth('   ', 300, measure)).toEqual([]);
    expect(wrapTextToWidth('Supercalifragilisticexpialidocious today', 100, measure)).toBeNull();
  });

  it('splits an over-wide word between characters only when asked', () => {
    expect(wrapTextToWidth('Supercalifragilisticexpialidocious today', 100, measure, true)).toEqual(['Supercalif', 'ragilistic', 'expialidoc', 'ious today']);
    expect(wrapTextToWidth('W', 5, measure, true)).toBeNull();
  });

  it('terminates and balances with fractional widths', () => {
    const fractional = (line: string) => line.length * 10.37;
    const lines = wrapTextToWidth('Skin fades tapers beard trims and hot towel shaves', 200.5, fractional)!;
    expect(lines.join(' ')).toBe('Skin fades tapers beard trims and hot towel shaves');
    for (const line of lines) expect(fractional(line)).toBeLessThanOrEqual(200.5);
  });
});
