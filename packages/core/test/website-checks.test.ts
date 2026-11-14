import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  doTheseFirst,
  findAddressConflicts,
  prepareChanges,
  prioritiseFindings,
  runWebsiteChecks,
  summariseAudit,
  WebsiteAuditResultSchema,
  type CrawlFacts,
  type Finding,
} from '../src/index.js';
import { cleanFacts, page, ROOT, studioSettings } from './website-fixtures.js';

const NOW = new Date('2026-11-14T00:00:00Z');
const settings = studioSettings();
const ids = (facts: CrawlFacts, s = settings) => runWebsiteChecks(facts, s, NOW).map((f) => f.checkId);
const home = (over: Parameters<typeof page>[1]) => [page(ROOT, over), page(`${ROOT}contact/`)];

describe('website check catalogue', () => {
  it('finds nothing on a clean site, and the result validates', () => {
    const facts = cleanFacts();
    const findings = runWebsiteChecks(facts, settings, NOW);
    expect(findings).toEqual([]);
    expect(WebsiteAuditResultSchema.safeParse({ ...facts, findings }).success).toBe(true);
  });

  const cases: Array<[string, CrawlFacts, string | string[]]> = [
    [
      'robots_blocks_google',
      cleanFacts({
        robots: {
          ...cleanFacts().robots,
          googlebotBlocksHome: true,
          googlebotBlockedPages: [ROOT],
        },
      }),
      'robots_blocks_google',
    ],
    ['robots_unreachable', cleanFacts({ robots: { ...cleanFacts().robots, status: 'unreachable' } }), 'robots_unreachable'],
    [
      'page_noindex',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { metaRobots: 'noindex, follow' })],
      }),
      'page_noindex',
    ],
    [
      'https_missing',
      cleanFacts({
        hostVariants: [
          {
            url: 'http://ivanhoebarber.example.com.au/',
            status: 200,
            redirectsTo: null,
          },
        ],
      }),
      'https_missing',
    ],
    [
      'host_variants_split',
      cleanFacts({
        hostVariants: [
          { url: ROOT, status: 200, redirectsTo: null },
          {
            url: 'https://www.ivanhoebarber.example.com.au/',
            status: 200,
            redirectsTo: null,
          },
        ],
        pages: home({ canonical: null }),
      }),
      ['host_variants_split', 'canonical_missing'],
    ],
    [
      'canonical_elsewhere',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { canonical: 'https://other.example.com/' })],
      }),
      'canonical_elsewhere',
    ],
    ['canonical_missing', cleanFacts({ pages: home({ canonical: null }) }), 'canonical_missing'],
    ['soft_404', cleanFacts({ soft404: { testedUrl: `${ROOT}x`, status: 200 } }), 'soft_404'],
    ['sitemap_missing', cleanFacts({ sitemap: { ...cleanFacts().sitemap, found: false } }), 'sitemap_missing'],
    ['sitemap_invalid', cleanFacts({ sitemap: { ...cleanFacts().sitemap, invalid: true } }), 'sitemap_invalid'],
    [
      'sitemap_bad_urls',
      cleanFacts({
        sitemap: {
          ...cleanFacts().sitemap,
          badUrls: [{ url: `${ROOT}old/`, reason: 'error', status: 404 }],
        },
      }),
      'sitemap_bad_urls',
    ],
    ['sitemap_not_in_robots', cleanFacts({ robots: { ...cleanFacts().robots, sitemaps: [] } }), 'sitemap_not_in_robots'],
    ['home_not_in_sitemap', cleanFacts({ sitemap: { ...cleanFacts().sitemap, homeListed: false } }), 'home_not_in_sitemap'],
    ['lang_missing', cleanFacts({ pages: home({ lang: null }) }), 'lang_missing'],
    [
      'title_missing',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { title: null })],
      }),
      'title_missing',
    ],
    [
      'title_length',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { title: 'Contact' })],
      }),
      'title_length',
    ],
    [
      'title_duplicate',
      cleanFacts({
        pages: [
          page(ROOT),
          page(`${ROOT}contact/`, {
            title: 'Ivanhoe Barber Co | Barber in Ivanhoe, VIC',
          }),
        ],
      }),
      'title_duplicate',
    ],
    ['title_home_local', cleanFacts({ pages: home({ title: 'Welcome to our studio | IBC' }) }), 'title_home_local'],
    [
      'meta_description_missing',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { metaDescription: null })],
      }),
      'meta_description_missing',
    ],
    [
      'meta_description_length',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { metaDescription: 'Too short.' })],
      }),
      'meta_description_length',
    ],
    [
      'meta_description_duplicate',
      cleanFacts({
        pages: [
          page(ROOT, {
            metaDescription: 'Same words on two pages for a barber studio in Ivanhoe, which is not ideal.',
          }),
          page(`${ROOT}contact/`, {
            metaDescription: 'Same words on two pages for a barber studio in Ivanhoe, which is not ideal.',
          }),
        ],
      }),
      'meta_description_duplicate',
    ],
    ['h1_missing', cleanFacts({ pages: [page(ROOT), page(`${ROOT}contact/`, { h1: [] })] }), 'h1_missing'],
    [
      'h1_multiple',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { h1: ['A', 'B'] })],
      }),
      'h1_multiple',
    ],
    [
      'heading_skips',
      cleanFacts({
        pages: [
          page(ROOT),
          page(`${ROOT}contact/`, {
            headings: [
              { level: 1, text: 'A' },
              { level: 3, text: 'B' },
            ],
          }),
        ],
      }),
      'heading_skips',
    ],
    ['home_thin', cleanFacts({ pages: home({ wordCount: 80 }) }), 'home_thin'],
    [
      'local_mentions_missing',
      cleanFacts({
        pages: [
          page(ROOT, { nap: { ...page(ROOT).nap, suburbFound: false } }),
          page(`${ROOT}contact/`, {
            nap: { ...page(ROOT).nap, suburbFound: false },
          }),
        ],
      }),
      ['local_mentions_missing', 'nap_address_missing'],
    ],
    [
      'booking_link_missing',
      cleanFacts({
        pages: [page(ROOT, { bookingLinkFound: false }), page(`${ROOT}contact/`, { bookingLinkFound: false })],
      }),
      'booking_link_missing',
    ],
    [
      'booking_link_broken',
      cleanFacts({
        links: {
          checked: 1,
          broken: [
            {
              url: 'https://book.example.com/ivanhoe',
              status: 404,
              error: null,
              internal: false,
              foundOn: [ROOT],
            },
          ],
          unverifiable: 0,
        },
      }),
      'booking_link_broken',
    ],
    [
      'nap_name_missing',
      cleanFacts({
        pages: [
          page(ROOT, { nap: { ...page(ROOT).nap, nameFound: false } }),
          page(`${ROOT}contact/`, {
            nap: { ...page(ROOT).nap, nameFound: false },
          }),
        ],
      }),
      'nap_name_missing',
    ],
    [
      'nap_phone_missing',
      cleanFacts({
        pages: [
          page(ROOT, { nap: { ...page(ROOT).nap, phones: [], telLinks: [] } }),
          page(`${ROOT}contact/`, {
            nap: { ...page(ROOT).nap, phones: [], telLinks: [] },
          }),
        ],
      }),
      'nap_phone_missing',
    ],
    [
      'nap_phone_mismatch',
      cleanFacts({
        pages: [
          page(ROOT),
          page(`${ROOT}contact/`, {
            nap: {
              ...page(ROOT).nap,
              phones: ['03 9499 1234', '(03) 9876-5432'],
            },
          }),
        ],
      }),
      'nap_phone_mismatch',
    ],
    [
      'nap_address_missing',
      cleanFacts({
        pages: [
          page(ROOT, { nap: { ...page(ROOT).nap, streetFound: false } }),
          page(`${ROOT}contact/`, {
            nap: { ...page(ROOT).nap, streetFound: false },
          }),
        ],
      }),
      'nap_address_missing',
    ],
    [
      'nap_address_mismatch',
      cleanFacts({
        pages: [
          page(ROOT),
          page(`${ROOT}contact/`, {
            nap: { ...page(ROOT).nap, addressConflicts: ['Ivanhoe VIC 3080'] },
          }),
        ],
      }),
      'nap_address_mismatch',
    ],
    [
      'tel_link_missing',
      cleanFacts({
        pages: [page(ROOT, { nap: { ...page(ROOT).nap, telLinks: [] } }), page(`${ROOT}contact/`, { nap: { ...page(ROOT).nap, telLinks: [] } })],
      }),
      'tel_link_missing',
    ],
    ['localbusiness_missing', cleanFacts({ pages: home({ jsonLd: [] }) }), 'localbusiness_missing'],
    [
      'jsonld_invalid',
      cleanFacts({
        pages: [
          page(ROOT),
          page(`${ROOT}contact/`, {
            jsonLd: [{ types: [], raw: '{"@type": "HairSalon",', valid: false }],
          }),
        ],
      }),
      'jsonld_invalid',
    ],
    [
      'localbusiness_mismatch',
      cleanFacts({
        pages: home({
          jsonLd: [
            {
              types: ['HairSalon'],
              raw: JSON.stringify({
                '@type': 'HairSalon',
                name: 'Old Name',
                telephone: '03 9000 0000',
              }),
              valid: true,
            },
          ],
        }),
      }),
      'localbusiness_mismatch',
    ],
    [
      'localbusiness_type_unrecognised',
      cleanFacts({
        pages: home({
          jsonLd: [
            {
              types: ['BarberShop'],
              raw: JSON.stringify({
                '@type': 'BarberShop',
                name: 'Ivanhoe Barber Co',
              }),
              valid: true,
            },
          ],
        }),
      }),
      'localbusiness_type_unrecognised',
    ],
    ['viewport_missing', cleanFacts({ pages: home({ viewport: null }) }), 'viewport_missing'],
    [
      'viewport_zoom_disabled',
      cleanFacts({
        pages: home({ viewport: 'width=device-width, user-scalable=no' }),
      }),
      'viewport_zoom_disabled',
    ],
    [
      'slow_response',
      cleanFacts({
        pages: [page(ROOT, { ttfbMs: 2500 }), page(`${ROOT}contact/`, { ttfbMs: 1900 })],
      }),
      'slow_response',
    ],
    ['page_heavy', cleanFacts({ pages: home({ estimatedWeightBytes: 4 * 1024 * 1024 }) }), 'page_heavy'],
    [
      'image_large',
      cleanFacts({
        pages: home({
          images: [
            {
              src: `${ROOT}big.jpg`,
              alt: 'x',
              widthAttr: true,
              heightAttr: true,
              bytes: 900_000,
              intrinsicWidth: 1200,
            },
          ],
        }),
      }),
      'image_large',
    ],
    [
      'image_oversized',
      cleanFacts({
        pages: home({
          images: [
            {
              src: `${ROOT}wide.jpg`,
              alt: 'x',
              widthAttr: true,
              heightAttr: true,
              bytes: 100_000,
              intrinsicWidth: 4000,
            },
          ],
        }),
      }),
      'image_oversized',
    ],
    [
      'image_missing_dimensions',
      cleanFacts({
        pages: home({
          images: [
            {
              src: `${ROOT}n.jpg`,
              alt: 'x',
              widthAttr: false,
              heightAttr: false,
              bytes: 1000,
              intrinsicWidth: 100,
            },
          ],
        }),
      }),
      'image_missing_dimensions',
    ],
    [
      'image_alt_missing',
      cleanFacts({
        pages: home({
          images: [
            {
              src: `${ROOT}n.jpg`,
              alt: null,
              widthAttr: true,
              heightAttr: true,
              bytes: 1000,
              intrinsicWidth: 100,
            },
          ],
        }),
      }),
      'image_alt_missing',
    ],
    ['no_compression', cleanFacts({ pages: home({ compressed: false }) }), 'no_compression'],
    ['render_blocking_scripts', cleanFacts({ pages: home({ headScripts: { total: 6, blocking: 5 } }) }), 'render_blocking_scripts'],
    [
      'broken_internal_link',
      cleanFacts({
        links: {
          checked: 3,
          broken: [
            {
              url: `${ROOT}gone/`,
              status: 404,
              error: null,
              internal: true,
              foundOn: [`${ROOT}contact/`],
            },
          ],
          unverifiable: 0,
        },
      }),
      'broken_internal_link',
    ],
    [
      'broken_external_link',
      cleanFacts({
        links: {
          checked: 3,
          broken: [
            {
              url: 'https://gone.example.org/',
              status: 410,
              error: null,
              internal: false,
              foundOn: [ROOT],
            },
          ],
          unverifiable: 0,
        },
      }),
      'broken_external_link',
    ],
    [
      'redirect_chain',
      cleanFacts({
        pages: [page(ROOT), page(`${ROOT}contact/`, { redirectChain: [`${ROOT}a`, `${ROOT}b`] })],
      }),
      'redirect_chain',
    ],
  ];
  it.each(cases)('%s produces exactly that finding', (_name, facts, checkId) => {
    expect(ids(facts)).toEqual(Array.isArray(checkId) ? checkId : [checkId]);
  });

  it('covers every check in the catalogue (site_unreachable, settings and profile reminders separately)', () => {
    const covered = new Set([...cases.flatMap((c) => c[2]), 'site_unreachable', 'settings_incomplete', 'profile_details_unchecked']);
    expect(Object.keys(CHECKS).filter((k) => !covered.has(k))).toEqual([]);
  });

  it('reports only an unreachable site when the home page did not answer', () => {
    const facts = cleanFacts({
      pages: [
        page(ROOT, {
          status: null,
          error: 'The server did not answer within 20 seconds',
        }),
      ],
    });
    const findings = runWebsiteChecks(facts, settings, NOW);
    expect(findings.map((f) => f.checkId)).toEqual(['site_unreachable']);
    expect(findings[0]?.severity).toBe('critical');
  });

  it('raises severity for the home page (noindex) and for links from the home page', () => {
    const noindexHome = runWebsiteChecks(cleanFacts({ pages: home({ metaRobots: 'noindex' }) }), settings, NOW).find((f) => f.checkId === 'page_noindex');
    expect(noindexHome?.severity).toBe('critical');
    const fromHome = runWebsiteChecks(
      cleanFacts({
        links: {
          checked: 1,
          broken: [
            {
              url: `${ROOT}gone`,
              status: 404,
              error: null,
              internal: true,
              foundOn: [ROOT],
            },
          ],
          unverifiable: 0,
        },
      }),
      settings,
      NOW,
    ).find((f) => f.checkId === 'broken_internal_link');
    expect(fromHome?.severity).toBe('high');
    const veryHeavy = runWebsiteChecks(cleanFacts({ pages: home({ estimatedWeightBytes: 7 * 1024 * 1024 }) }), settings, NOW).find((f) => f.checkId === 'page_heavy');
    expect(veryHeavy?.severity).toBe('high');
  });

  it('flags missing settings and an old Business Profile check as notes', () => {
    const bare = studioSettings({
      brandName: 'My Barber Studio',
      business: { phone: '', addressLine: '' },
      website: { profileDetailsCheckedAt: '2026-01-01T00:00:00.000Z' },
    });
    const found = ids(cleanFacts({}, bare), bare);
    expect(found).toContain('settings_incomplete');
    expect(found).toContain('profile_details_unchecked');
    expect(found).not.toContain('nap_name_missing');
    expect(found).not.toContain('nap_phone_missing');
  });

  it('does not count a 13/1300 number or an international form of the settings phone as different', () => {
    const facts = cleanFacts({
      pages: [
        page(ROOT, {
          nap: {
            ...page(ROOT).nap,
            phones: ['+61 3 9499 1234', '(03) 9499-1234'],
          },
        }),
        page(`${ROOT}contact/`),
      ],
    });
    expect(ids(facts)).toEqual([]);
  });

  it('keeps finding keys stable across checks', () => {
    const facts = cleanFacts({ pages: home({ canonical: null }) });
    expect(runWebsiteChecks(facts, settings, NOW)[0]?.key).toBe(runWebsiteChecks(facts, settings, NOW)[0]?.key);
  });

  it('finds conflicting postcodes and street numbers next to the address', () => {
    const snap = {
      addressLine: '12 Upper Heidelberg Rd',
      suburb: 'Ivanhoe',
      postcode: '3079',
    };
    expect(findAddressConflicts('Visit us at 14 Upper Heidelberg Rd, Ivanhoe VIC 3080.', snap)).toEqual(['Ivanhoe VIC 3080', '14 Upper Heidelberg']);
    expect(findAddressConflicts('12 Upper Heidelberg Rd, Ivanhoe VIC 3079', snap)).toEqual([]);
  });
});

describe('prepared changes from findings', () => {
  it('prepares a home title, descriptions, JSON-LD, a viewport line and the corrected phone number', () => {
    const facts = cleanFacts({
      pages: [
        page(ROOT, {
          title: 'Home',
          metaDescription: null,
          jsonLd: [],
          viewport: null,
        }),
        page(`${ROOT}contact/`, {
          nap: {
            ...page(ROOT).nap,
            phones: ['03 9499 1234', '(03) 9876 5432'],
          },
        }),
      ],
    });
    const findings = runWebsiteChecks(facts, settings, NOW);
    const changes = prepareChanges(facts, findings, {
      robotsText: 'User-agent: *\nDisallow: /private/',
      tagline: 'Fades and beard trims',
      instagramHandle: 'ivanhoebarber',
      tiktokHandle: '',
    });
    const kinds = changes.map((c) => c.change.kind);
    expect(kinds).toEqual(expect.arrayContaining(['page_title', 'meta_description', 'structured_data', 'head_snippet', 'text_replace']));
    const title = changes.find((c) => c.change.kind === 'page_title')!;
    expect(title.change.after).toBe('Ivanhoe Barber Co | Barber in Ivanhoe, VIC');
    expect(title.change.before).toBe('Home');
    const phone = changes.find((c) => c.change.kind === 'text_replace')!;
    expect(phone.change).toMatchObject({
      before: '(03) 9876 5432',
      after: '03 9499 1234',
    });
    const ld = changes.find((c) => c.change.kind === 'structured_data')!;
    expect(ld.change.after).toContain('"@type": "HairSalon"');
    expect(ld.change.after).toContain('https://www.instagram.com/ivanhoebarber');
    for (const c of changes) expect(findings.some((f) => f.key === c.findingKey)).toBe(true);
  });

  it('adds the sitemap line to robots.txt and removes the rule that blocks Google', () => {
    const facts = cleanFacts({
      robots: {
        ...cleanFacts().robots,
        sitemaps: [],
        googlebotBlocksHome: true,
        googlebotBlockedPages: [ROOT],
      },
    });
    const findings = runWebsiteChecks(facts, settings, NOW);
    const changes = prepareChanges(facts, findings, {
      robotsText: 'User-agent: *\nDisallow: /\n\nUser-agent: BadBot\nDisallow: /',
      tagline: '',
      instagramHandle: '',
      tiktokHandle: '',
    });
    const robots = changes.filter((c) => c.change.kind === 'robots_txt').map((c) => c.change.after);
    expect(robots.some((r) => r.endsWith(`Sitemap: ${ROOT}sitemap.xml`))).toBe(true);
    expect(robots).toContain('User-agent: *\n\nUser-agent: BadBot\nDisallow: /');
  });

  it('never prepares image descriptions (the owner writes them)', () => {
    const facts = cleanFacts({
      pages: home({
        images: [
          {
            src: `${ROOT}a.jpg`,
            alt: null,
            widthAttr: true,
            heightAttr: true,
            bytes: 1,
            intrinsicWidth: 1,
          },
        ],
      }),
    });
    const changes = prepareChanges(facts, runWebsiteChecks(facts, settings, NOW), { robotsText: null, tagline: '', instagramHandle: '', tiktokHandle: '' });
    expect(changes.filter((c) => c.change.kind === 'image_alt_text')).toEqual([]);
  });
});

describe('prioritisation', () => {
  const f = (checkId: string, severity: Finding['severity'], effort: Finding['effort'], pages = 1, category: Finding['category'] = 'content'): Finding => ({
    key: `${checkId}:k`,
    checkId,
    category,
    severity,
    effort,
    title: checkId,
    detail: '',
    why: '',
    howToFix: [],
    pages: Array.from({ length: pages }, (_, i) => `${ROOT}p${i}`),
    evidence: {},
    editKind: null,
  });

  it('orders by severity, quick fixes, pages affected, then category and check id', () => {
    const list = [
      f('b_low', 'low', 'quick'),
      f('a_high_dev', 'high', 'developer'),
      f('c_high_quick', 'high', 'quick'),
      f('d_medium_many', 'medium', 'developer', 9),
      f('e_crit', 'critical', 'developer'),
      f('f_med_index', 'medium', 'developer', 1, 'indexing'),
      f('g_med_content', 'medium', 'developer', 1, 'content'),
    ];
    expect(prioritiseFindings(list).map((x) => x.checkId)).toEqual(['e_crit', 'c_high_quick', 'a_high_dev', 'd_medium_many', 'f_med_index', 'g_med_content', 'b_low']);
    expect(prioritiseFindings(list)).toEqual(prioritiseFindings([...list].reverse()));
  });

  it('"Do these first" is at most five findings of at least medium severity', () => {
    const list = [f('a', 'low', 'quick'), f('b', 'info', 'quick'), ...Array.from({ length: 7 }, (_, i) => f(`m${i}`, 'medium', 'quick'))];
    const top = doTheseFirst(list);
    expect(top).toHaveLength(5);
    expect(top.every((x) => x.severity === 'medium')).toBe(true);
    expect(doTheseFirst([f('a', 'low', 'quick')])).toEqual([]);
  });

  it('summarises counts by severity', () => {
    const facts = cleanFacts({
      pages: [page(ROOT), page(`${ROOT}x.pdf`, { skipped: 'non_html', status: 200 })],
    });
    const s = summariseAudit(
      {
        pages: facts.pages,
        findings: [f('a', 'high', 'quick'), f('b', 'high', 'quick'), f('c', 'info', 'quick')],
      },
      ['We stopped at 25 pages'],
    );
    expect(s).toEqual({
      pagesChecked: 1,
      pagesSkipped: 1,
      counts: { critical: 0, high: 2, medium: 0, low: 0, info: 1 },
      partialReasons: ['We stopped at 25 pages'],
    });
  });
});
