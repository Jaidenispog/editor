import { AppSettingsSchema, type AppSettings, type CrawlFacts, type PageSummary } from '../src/index.js';

/** Settings for a fully described studio (synthetic test data). */
export function studioSettings(
  overrides: {
    business?: Partial<AppSettings['business']>;
    website?: Partial<AppSettings['website']>;
    brandName?: string;
  } = {},
): AppSettings {
  return AppSettingsSchema.parse({
    brand: {
      businessName: overrides.brandName ?? 'Ivanhoe Barber Co',
      tagline: 'Fades, tapers and beard trims',
    },
    business: {
      website: 'https://ivanhoebarber.example.com.au/',
      phone: '03 9499 1234',
      addressLine: '12 Upper Heidelberg Rd',
      suburb: 'Ivanhoe',
      state: 'VIC',
      postcode: '3079',
      bookingLink: 'https://book.example.com/ivanhoe',
      openingHours: [
        { day: 'Tu', opens: '09:00', closes: '17:30' },
        { day: 'Sa', opens: '08:00', closes: '14:00' },
      ],
      ...overrides.business,
    },
    website: {
      profileDetailsCheckedAt: '2026-11-01T00:00:00.000Z',
      ...overrides.website,
    },
  });
}

export const ROOT = 'https://ivanhoebarber.example.com.au/';

/** A clean page: nothing any check should flag. */
export function page(url: string, over: Partial<PageSummary> = {}): PageSummary {
  const isHome = url === ROOT;
  return {
    url,
    finalUrl: url,
    status: 200,
    error: null,
    skipped: null,
    redirectChain: [],
    ttfbMs: 120,
    totalMs: 300,
    htmlBytes: 20_000,
    compressed: true,
    title: isHome ? 'Ivanhoe Barber Co | Barber in Ivanhoe, VIC' : `Contact and bookings ${url.length} | Ivanhoe Barber Co`,
    metaDescription: `Ivanhoe Barber Co is a barber studio in Ivanhoe, VIC. Book online or call 03 9499 1234. Page ${url.length}.`,
    h1: ['Welcome'],
    headings: [
      { level: 1, text: 'Welcome' },
      { level: 2, text: 'Services' },
    ],
    canonical: url,
    metaRobots: null,
    xRobotsTag: null,
    lang: 'en-AU',
    viewport: 'width=device-width, initial-scale=1',
    jsonLd: isHome
      ? [
          {
            types: ['HairSalon'],
            raw: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'HairSalon',
              name: 'Ivanhoe Barber Co',
              telephone: '+61 3 9499 1234',
              address: {
                '@type': 'PostalAddress',
                streetAddress: '12 Upper Heidelberg Rd',
                addressLocality: 'Ivanhoe',
                postalCode: '3079',
              },
            }),
            valid: true,
          },
        ]
      : [],
    microdataTypes: [],
    nap: {
      phones: ['03 9499 1234'],
      telLinks: ['0394991234'],
      nameFound: true,
      suburbFound: true,
      postcodeFound: true,
      streetFound: true,
      addressConflicts: [],
    },
    bookingLinkFound: true,
    images: [
      {
        src: `${ROOT}img/chair.jpg`,
        alt: 'Barber chair',
        widthAttr: true,
        heightAttr: true,
        bytes: 80_000,
        intrinsicWidth: 1200,
      },
    ],
    headScripts: { total: 1, blocking: 0 },
    estimatedWeightBytes: 400_000,
    wordCount: 400,
    textSample: 'Ivanhoe Barber Co is a barber studio in Ivanhoe.',
    internalLinks: [],
    ...over,
  };
}

/** Facts for a clean two-page site. */
export function cleanFacts(over: Partial<CrawlFacts> = {}, settings: AppSettings = studioSettings()): CrawlFacts {
  return {
    version: 1,
    siteRoot: ROOT,
    settingsSnapshot: {
      businessName: settings.brand.businessName,
      addressLine: settings.business.addressLine,
      suburb: settings.business.suburb,
      state: settings.business.state,
      postcode: settings.business.postcode,
      phone: settings.business.phone,
      website: settings.business.website,
      bookingLink: settings.business.bookingLink,
      openingHours: settings.business.openingHours,
    },
    platformHint: 'unknown',
    robots: {
      status: 'ok',
      sitemaps: [`${ROOT}sitemap.xml`],
      googlebotBlocksHome: false,
      blockedForUs: [],
      crawlDelaySec: null,
      googlebotBlockedPages: [],
    },
    sitemap: {
      found: true,
      sources: [`${ROOT}sitemap.xml`],
      urlCount: 2,
      invalid: false,
      sample: [ROOT],
      homeListed: true,
      badUrls: [],
    },
    hostVariants: [
      {
        url: 'http://ivanhoebarber.example.com.au/',
        status: 301,
        redirectsTo: ROOT,
      },
      { url: ROOT, status: 200, redirectsTo: null },
      {
        url: 'http://www.ivanhoebarber.example.com.au/',
        status: 301,
        redirectsTo: ROOT,
      },
      {
        url: 'https://www.ivanhoebarber.example.com.au/',
        status: 301,
        redirectsTo: ROOT,
      },
    ],
    soft404: {
      testedUrl: `${ROOT}studio-assistant-check-abcd1234`,
      status: 404,
    },
    pages: [page(ROOT), page(`${ROOT}contact/`)],
    links: { checked: 4, broken: [], unverifiable: 0 },
    limits: {
      maxPages: 25,
      hitPageLimit: false,
      requests: 12,
      durationMs: 4000,
    },
    ...over,
  };
}
