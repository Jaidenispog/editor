import { describe, expect, it } from 'vitest';
import { buildQueryClassifier, classifyQuery, normaliseQueryText, notListedRemainder } from '../src/index.js';
import { studioSettings } from './website-fixtures.js';

describe('search-query grouping', () => {
  const cfg = buildQueryClassifier(
    studioSettings({
      website: { brandTerms: ['IBC'], placeTerms: ['Heidelberg'] },
    }),
  );

  it.each([
    ['Ivanhoe Barber Co', 'brand'],
    ['ivanhoe barber co hours', 'brand'],
    ['ibc fades', 'brand'],
    ['ivanhoebarber', 'brand'],
    ['barber ivanhoe', 'local'],
    ['barber near me', 'local'],
    ['skin fade heidelberg', 'local'],
    ['barber 3079', 'local'],
    ['skin fade', 'service'],
    ['barber', 'service'],
    ['faded jeans', 'other'],
    ['ivanhoe library', 'other'],
  ])('%s → %s', (query, group) => {
    expect(classifyQuery(query, cfg)).toBe(group);
  });

  it('counts the business name plus the suburb as a brand search', () => {
    expect(classifyQuery('ivanhoe barber co ivanhoe', cfg)).toBe('brand');
  });

  it('flags a business name made of everyday words and then needs the full name', () => {
    const generic = buildQueryClassifier(
      studioSettings({
        brandName: 'Ivanhoe Barbers',
        business: { website: 'https://example.com.au/' },
      }),
    );
    expect(generic.brandAmbiguous).toBe(true);
    expect(classifyQuery('barbers ivanhoe', generic)).toBe('local');
    expect(classifyQuery('ivanhoe barbers', generic)).toBe('brand');
    // "Ivanhoe Barber Co" is itself only a place, a service word and "co": the domain stem and owner terms carry it.
    expect(cfg.brandAmbiguous).toBe(true);
    const distinct = buildQueryClassifier(
      studioSettings({
        brandName: 'Fade Republic Ivanhoe',
        business: { website: 'https://example.com.au/' },
      }),
    );
    expect(distinct.brandAmbiguous).toBe(false);
    expect(classifyQuery('republic haircut', distinct)).toBe('brand');
  });

  it('normalises diacritics, apostrophes and ampersands', () => {
    expect(normaliseQueryText('Men’s Haircut & Shave — Ivanhoé')).toBe('mens haircut and shave ivanhoe');
    expect(classifyQuery("men's haircut ivanhoé", cfg)).toBe('local');
  });

  it('applies edited lists', () => {
    const edited = buildQueryClassifier(studioSettings({ website: { serviceTerms: ['mullet'] } }));
    expect(classifyQuery('mullet ivanhoe', edited)).toBe('local');
    expect(classifyQuery('haircut ivanhoe', edited)).toBe('other');
  });

  it('clamps the not-listed remainder at zero', () => {
    expect(notListedRemainder({ clicks: 10, impressions: 500 }, { clicks: 7, impressions: 420 })).toEqual({ clicks: 3, impressions: 80 });
    expect(notListedRemainder({ clicks: 1, impressions: 10 }, { clicks: 3, impressions: 12 })).toEqual({ clicks: 0, impressions: 0 });
  });
});
