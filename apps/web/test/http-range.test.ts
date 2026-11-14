import { describe, expect, it } from 'vitest';
import { contentDispositionAttachment, parseRangeHeader } from '../src/lib/http-range';

describe('parseRangeHeader', () => {
  const size = 1000;
  it('returns null when there is no usable range', () => {
    expect(parseRangeHeader(null, size)).toBeNull();
    expect(parseRangeHeader('', size)).toBeNull();
    expect(parseRangeHeader('items=0-5', size)).toBeNull();
    expect(parseRangeHeader('bytes=0-1,5-9', size)).toBeNull();
    expect(parseRangeHeader('bytes=-', size)).toBeNull();
    expect(parseRangeHeader('bytes=abc', size)).toBeNull();
    expect(parseRangeHeader('bytes=500-100', size)).toBeNull();
  });
  it('parses closed ranges', () => {
    expect(parseRangeHeader('bytes=0-499', size)).toEqual({ start: 0, end: 499 });
    expect(parseRangeHeader('bytes = 10 - 10', size)).toEqual({ start: 10, end: 10 });
  });
  it('parses open-ended ranges (what Safari and Chrome send for video)', () => {
    expect(parseRangeHeader('bytes=0-', size)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=900-', size)).toEqual({ start: 900, end: 999 });
  });
  it('parses suffix ranges', () => {
    expect(parseRangeHeader('bytes=-100', size)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
  });
  it('clamps an end past the file size', () => {
    expect(parseRangeHeader('bytes=990-2000', size)).toEqual({ start: 990, end: 999 });
  });
  it('reports unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=1000-', size)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=5000-6000', size)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', size)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('contentDispositionAttachment', () => {
  it('quotes safely and includes a UTF-8 filename', () => {
    const v = contentDispositionAttachment('Jordan’s "fade" v2.mp4');
    expect(v).toBe(`attachment; filename="Jordan_s _fade_ v2.mp4"; filename*=UTF-8''Jordan%E2%80%99s%20%22fade%22%20v2.mp4`);
  });
});
