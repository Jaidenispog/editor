import { describe, expect, it } from 'vitest';
import {
  AppSettingsSchema,
  OpeningHoursSchema,
  findAuPhones,
  internationalAuPhone,
  isInScope,
  normaliseAuPhone,
  normaliseUrl,
  ownershipMatches,
  samePageOnSite,
  siteScopeFrom,
} from '../src/index.js';

describe('site scope and URLs', () => {
  it('derives host, twin and path prefix; reads a bare host as https', () => {
    expect(siteScopeFrom('IvanhoeBarber.com.au')).toEqual({
      rootUrl: 'https://ivanhoebarber.com.au/',
      scheme: 'https',
      host: 'ivanhoebarber.com.au',
      twinHost: 'www.ivanhoebarber.com.au',
      pathPrefix: '/',
    });
    expect(siteScopeFrom('http://www.example.com/shop/index.html')).toMatchObject({
      host: 'www.example.com',
      twinHost: 'example.com',
      pathPrefix: '/shop/',
      scheme: 'http',
    });
  });

  it('refuses credentials, odd ports, other schemes and non-hosts', () => {
    expect(siteScopeFrom('https://user:pw@example.com/')).toBeNull();
    expect(siteScopeFrom('https://example.com:8443/')).toBeNull();
    expect(siteScopeFrom('ftp://example.com/')).toBeNull();
    expect(siteScopeFrom('localhost')).toBeNull();
    expect(siteScopeFrom('')).toBeNull();
  });

  it('normalises tracking parameters, fragments, default ports and case', () => {
    expect(normaliseUrl('HTTPS://Example.com:443/Path/?utm_source=x&gclid=1&a=2#top')).toBe('https://example.com/Path/?a=2');
    expect(normaliseUrl('http://example.com:80/a?fbclid=z')).toBe('http://example.com/a');
    expect(normaliseUrl('/contact', 'https://example.com/x/')).toBe('https://example.com/contact');
    expect(normaliseUrl('mailto:a@b.c')).toBeNull();
  });

  it('keeps crawling in scope (twin host yes, other hosts and paths no)', () => {
    const scope = siteScopeFrom('https://example.com/shop/')!;
    expect(isInScope('http://www.example.com/shop/a', scope)).toBe(true);
    expect(isInScope('https://example.com/blog/', scope)).toBe(false);
    expect(isInScope('https://evil.example.org/shop/', scope)).toBe(false);
    expect(isInScope('https://example.com:8080/shop/', scope)).toBe(false);
  });

  it('matches ownership on the host without www', () => {
    expect(ownershipMatches(siteScopeFrom('https://www.example.com/'), 'example.com')).toBe(true);
    expect(ownershipMatches(siteScopeFrom('https://example.net/'), 'example.com')).toBe(false);
    expect(ownershipMatches(siteScopeFrom('https://example.com/'), null)).toBe(false);
    expect(samePageOnSite('https://www.example.com/about/', 'http://example.com/about')).toBe(true);
  });
});

describe('Australian phone numbers', () => {
  it.each([
    ['03 9499 1234', '03 9499 1234'],
    ['+61 3 9499 1234', '03 9499 1234'],
    ['(03) 9499-1234', '03 9499 1234'],
    ['0412 345 678', '0412 345 678'],
    ['+61412345678', '0412 345 678'],
    ['1300 123 456', '1300 123 456'],
    ['13 12 34', '13 12 34'],
  ])('%s → %s', (input, national) => {
    expect(normaliseAuPhone(input)?.national).toBe(national);
  });

  it('gives the international form and refuses non-numbers', () => {
    expect(internationalAuPhone(normaliseAuPhone('03 9499 1234')!)).toBe('+61 3 9499 1234');
    expect(normaliseAuPhone('03 9499 1234')!.e164).toBe('+61394991234');
    expect(normaliseAuPhone('12345')).toBeNull();
    expect(normaliseAuPhone('+1 415 555 0100')).toBeNull();
  });

  it('finds distinct numbers in page text', () => {
    expect(findAuPhones('Call (03) 9499 1234 or 03 9499 1234, mobile 0412 345 678. Since 2009.')).toEqual(['(03) 9499 1234', '0412 345 678']);
  });
});

describe('settings', () => {
  it('parses older settings with the website defaults and no opening hours', () => {
    const s = AppSettingsSchema.parse({ business: { suburb: 'Ivanhoe' } });
    expect(s.business.openingHours).toEqual([]);
    expect(s.website.serviceTerms).toContain('skin fade');
    expect(s.website.ownershipConfirmedHost).toBeNull();
  });

  it('validates opening hours: closes after opens, at most two non-overlapping ranges per day', () => {
    expect(
      OpeningHoursSchema.safeParse([
        { day: 'Mo', opens: '09:00', closes: '12:00' },
        { day: 'Mo', opens: '13:00', closes: '17:00' },
      ]).success,
    ).toBe(true);
    expect(OpeningHoursSchema.safeParse([{ day: 'Mo', opens: '12:00', closes: '09:00' }]).success).toBe(false);
    expect(
      OpeningHoursSchema.safeParse([
        { day: 'Mo', opens: '09:00', closes: '13:00' },
        { day: 'Mo', opens: '12:00', closes: '17:00' },
      ]).success,
    ).toBe(false);
    expect(
      OpeningHoursSchema.safeParse(
        ['09', '10', '11'].map((h) => ({
          day: 'Tu',
          opens: `${h}:00`,
          closes: `${h}:30`,
        })),
      ).success,
    ).toBe(false);
    expect(OpeningHoursSchema.safeParse([{ day: 'Mo', opens: '9am', closes: '17:00' }]).success).toBe(false);
  });
});
