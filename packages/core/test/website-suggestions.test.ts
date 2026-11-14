import { describe, expect, it } from 'vitest';
import {
  WebsiteChangeKindSchema,
  buildLocalBusinessJsonLd,
  checkCopyClaims,
  correctedBusinessJsonLd,
  renderEditInstructions,
  settingsSnapshot,
  suggestMetaDescription,
  suggestTitle,
  type WebsiteChange,
} from '../src/index.js';
import { ROOT, studioSettings } from './website-fixtures.js';

const snap = settingsSnapshot(studioSettings());

describe('suggestions built from settings', () => {
  it('home title falls back to shorter forms to stay within 60 characters', () => {
    expect(suggestTitle({ h1: [], title: null }, true, snap)).toBe('Ivanhoe Barber Co | Barber in Ivanhoe, VIC');
    const long = {
      ...snap,
      businessName: 'The Very Long Named Gentlemen’s Grooming Company',
    };
    expect(suggestTitle({ h1: [], title: null }, true, long)).toBe('The Very Long Named Gentlemen’s Grooming Company | Ivanhoe');
    for (const t of [
      suggestTitle({ h1: [], title: null }, true, long),
      suggestTitle(
        {
          h1: ['Prices and services for every kind of haircut we offer'],
          title: null,
        },
        false,
        snap,
      ),
    ]) {
      expect(t!.length).toBeLessThanOrEqual(60);
    }
  });

  it('other pages use their heading or trimmed title plus the business name; none without a real name', () => {
    expect(suggestTitle({ h1: ['Prices'], title: null }, false, snap)).toBe('Prices | Ivanhoe Barber Co');
    expect(suggestTitle({ h1: [], title: 'Contact – Ivanhoe Barber Co' }, false, snap)).toBe('Contact | Ivanhoe Barber Co');
    expect(
      suggestTitle({ h1: [], title: null }, true, {
        ...snap,
        businessName: 'My Barber Studio',
      }),
    ).toBeNull();
  });

  it('description is 50–160 characters and only uses settings', () => {
    const d = suggestMetaDescription(snap, 'Fades, tapers and beard trims')!;
    expect(d).toBe('Ivanhoe Barber Co is a barber studio in Ivanhoe, VIC. Fades, tapers and beard trims. Book online. Call 03 9499 1234.');
    expect(d.length).toBeGreaterThanOrEqual(50);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(suggestMetaDescription({ ...snap, businessName: 'IBC', state: '', phone: '', bookingLink: '' }, '')).toBeNull();
  });

  it('JSON-LD omits unset fields and never contains ratings, reviews, coordinates, prices or images', () => {
    const full = buildLocalBusinessJsonLd(snap, ROOT, {
      instagram: '@ivanhoebarber',
      tiktok: '',
    });
    const body = JSON.parse(full.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
    expect(body).toMatchObject({
      '@type': 'HairSalon',
      name: 'Ivanhoe Barber Co',
      telephone: '+61 3 9499 1234',
      address: { postalCode: '3079', addressCountry: 'AU' },
    });
    expect(body.openingHoursSpecification).toHaveLength(2);
    expect(body.sameAs).toEqual(['https://www.instagram.com/ivanhoebarber']);
    for (const banned of ['aggregateRating', 'review', 'geo', 'priceRange', 'image']) expect(body).not.toHaveProperty(banned);
    const bare = JSON.parse(
      buildLocalBusinessJsonLd(
        {
          ...snap,
          phone: '',
          addressLine: '',
          suburb: '',
          postcode: '',
          state: '',
          openingHours: [],
        },
        ROOT,
      )
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
    );
    expect(Object.keys(bare).sort()).toEqual(['@context', '@id', '@type', 'name', 'url']);
  });

  it('corrects an existing block and keeps the owner’s other properties', () => {
    const raw = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Site' },
        {
          '@type': 'BarberShop',
          name: 'Old',
          logo: 'https://x/logo.png',
          openingHours: 'Mo-Fr 09:00-17:00',
        },
      ],
    });
    const out = JSON.parse(
      correctedBusinessJsonLd(raw, snap, ROOT, { instagram: '', tiktok: '' })!
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
    );
    const biz = out['@graph'][1];
    expect(biz).toMatchObject({
      '@type': 'HairSalon',
      name: 'Ivanhoe Barber Co',
      logo: 'https://x/logo.png',
      telephone: '+61 3 9499 1234',
    });
    expect(biz).not.toHaveProperty('openingHours');
    expect(out['@graph'][0]).toEqual({ '@type': 'WebSite', name: 'Site' });
  });
});

describe('checkCopyClaims', () => {
  const input = {
    kind: 'meta_description' as const,
    businessName: 'Ivanhoe Barber Co',
    phone: '03 9499 1234',
  };
  const ok = 'Ivanhoe Barber Co is a barber studio in Ivanhoe, VIC. Book online or call 03 9499 1234.';
  it('passes plain factual wording', () => {
    expect(checkCopyClaims(ok, input)).toEqual([]);
  });
  it.each(['best', '#1', 'number one', 'no. 1', 'top-rated', 'top rated', 'award', 'guarantee', 'rank', 'first page', 'cheapest', 'google'])('rejects “%s”', (phrase) => {
    expect(checkCopyClaims(`${ok.slice(0, 60)} The ${phrase} barber.`, input).length).toBeGreaterThan(0);
  });
  it('rejects addresses, emails and other phone numbers, and titles without the business name', () => {
    expect(checkCopyClaims(`${ok} Visit www.example.com`, input).join(' ')).toContain('web address');
    expect(checkCopyClaims(`${ok} Email hi@example.com`, input).join(' ')).toContain('email');
    expect(checkCopyClaims(ok.replace('03 9499 1234', '0412 345 678'), input).join(' ')).toContain('phone');
    expect(
      checkCopyClaims('Barber in Ivanhoe, VIC', {
        ...input,
        kind: 'page_title',
      }).join(' '),
    ).toContain('business name');
    expect(checkCopyClaims('Too short', input).join(' ')).toContain('50–170');
  });
  it('does not flag words that merely contain a banned word', () => {
    expect(checkCopyClaims(`${ok.slice(0, 70)} Bestow a fresh cut; frank advice.`, input)).toEqual([]);
  });
});

describe('copy-paste instructions', () => {
  const page = `${ROOT}`;
  const changes: Record<string, WebsiteChange> = {
    page_title: {
      kind: 'page_title',
      pageUrl: page,
      before: 'Home',
      after: 'Ivanhoe Barber Co | Barber in Ivanhoe, VIC',
    },
    meta_description: {
      kind: 'meta_description',
      pageUrl: page,
      before: null,
      after: 'x'.repeat(60),
    },
    text_replace: {
      kind: 'text_replace',
      pageUrl: page,
      before: '03 9000 0000',
      after: '03 9499 1234',
    },
    image_alt_text: {
      kind: 'image_alt_text',
      pageUrl: page,
      imageSrc: `${ROOT}a.jpg`,
      before: null,
      after: 'Skin fade',
    },
    structured_data: {
      kind: 'structured_data',
      pageUrl: page,
      before: null,
      after: '<script type="application/ld+json">{}</script>',
    },
    head_snippet: {
      kind: 'head_snippet',
      pageUrl: page,
      before: null,
      after: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    },
    robots_txt: {
      kind: 'robots_txt',
      pageUrl: `${ROOT}robots.txt`,
      before: null,
      after: 'Sitemap: x',
    },
  };
  it('renders every kind, with and without a platform hint', () => {
    for (const kind of WebsiteChangeKindSchema.options) {
      const change = changes[kind]!;
      const plain = renderEditInstructions(change, null);
      expect(plain.text).toContain(change.after);
      expect(plain.text).toContain("I've made this change");
      expect(plain.markdown.length).toBeGreaterThan(0);
      expect(renderEditInstructions(change, 'squarespace').text).toContain("looks like it's built with Squarespace");
      expect(renderEditInstructions(change, 'unknown').text).not.toContain('looks like');
    }
    expect(renderEditInstructions(changes['page_title']!, null).text).toContain('Replace:  Home');
    expect(renderEditInstructions(changes['robots_txt']!, null).text).toContain('web developer');
  });
});
