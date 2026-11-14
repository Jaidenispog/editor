import { z } from 'zod';
import type { AppSettings } from './settings.js';

/**
 * Website check and local search (design `docs/design/website-local-search.md`, WP8): the JSON contracts stored in
 * `website_audits.result` and `website_edits.proposed_change`, the `website` settings section, site scope and URL
 * normalisation, Australian phone numbers, search-query grouping, the change lifecycle, AI-wording claim checks and
 * the copy-paste instructions. Everything here is pure and safe to import in the browser.
 */

// ---------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------

/** Finding severities, most serious first ("Urgent", "Important", "Worth doing", "Minor", "Note" in the UI). */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
/** How much work a fix is ("Quick fix", "Some work", "Needs your web developer"). */
export const EFFORTS = ['quick', 'moderate', 'developer'] as const;
export type Effort = (typeof EFFORTS)[number];
/** Finding categories, in display (and tie-break) order. */
export const CATEGORIES = ['indexing', 'business_info', 'content', 'structured_data', 'mobile', 'performance', 'links'] as const;
export type FindingCategory = (typeof CATEGORIES)[number];

/** Plain words for each category (filter chips). */
export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  indexing: 'Indexing',
  business_info: 'Business details',
  content: 'Titles and text',
  structured_data: 'Structured data',
  mobile: 'Mobile',
  performance: 'Speed',
  links: 'Links',
};
/** Plain words for each effort level. */
export const EFFORT_LABELS: Record<Effort, string> = {
  quick: 'Quick fix',
  moderate: 'Some work',
  developer: 'Needs your web developer',
};

/** Kinds of prepared change. */
export const WebsiteChangeKindSchema = z.enum(['page_title', 'meta_description', 'text_replace', 'image_alt_text', 'structured_data', 'head_snippet', 'robots_txt']);
export type WebsiteChangeKind = z.infer<typeof WebsiteChangeKindSchema>;

/** Statuses of one website check (`website_audits.status`). */
export const WEBSITE_AUDIT_STATUSES = ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled'] as const;
export type WebsiteAuditStatus = (typeof WEBSITE_AUDIT_STATUSES)[number];
/** Statuses of one prepared change (`website_edits.status`), design §6.9. */
export const WEBSITE_EDIT_STATUSES = ['proposed', 'approved', 'applying', 'applied', 'apply_failed', 'rejected', 'superseded'] as const;
export type WebsiteEditStatus = (typeof WEBSITE_EDIT_STATUSES)[number];
/** Open statuses: at most one open change per dedupe key (partial unique index). */
export const OPEN_EDIT_STATUSES = ['proposed', 'approved', 'applying', 'apply_failed'] as const satisfies readonly WebsiteEditStatus[];
/** Where a change's wording came from (labels in the UI; AI text is always labelled). */
export const WEBSITE_EDIT_SOURCES = ['audit_rule', 'ai_draft', 'owner', 'undo'] as const;
export type WebsiteEditSource = (typeof WEBSITE_EDIT_SOURCES)[number];
/** Platforms the check can recognise from public page markers ("looks like"). */
export const PLATFORM_HINTS = ['wordpress', 'squarespace', 'wix', 'shopify', 'webflow', 'unknown'] as const;
export type PlatformHint = (typeof PLATFORM_HINTS)[number];
/** Display names of the recognised platforms. */
export const WEBSITE_PLATFORM_NAMES: Record<PlatformHint, string> = {
  wordpress: 'WordPress',
  squarespace: 'Squarespace',
  wix: 'Wix',
  shopify: 'Shopify',
  webflow: 'Webflow',
  unknown: 'an unknown website builder',
};

// ---------------------------------------------------------------------------------------------
// Settings (the `website` section and `business.openingHours`)
// ---------------------------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Days in schema.org's two-letter form. */
export const OPENING_DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
export type OpeningDay = (typeof OPENING_DAYS)[number];
/** Full day names for the UI and JSON-LD. */
export const OPENING_DAY_NAMES: Record<OpeningDay, string> = {
  Mo: 'Monday',
  Tu: 'Tuesday',
  We: 'Wednesday',
  Th: 'Thursday',
  Fr: 'Friday',
  Sa: 'Saturday',
  Su: 'Sunday',
};

/** One opening range on one day (24-hour Melbourne time). */
export const OpeningRangeSchema = z
  .object({
    day: z.enum(OPENING_DAYS),
    opens: z.string().regex(HHMM, 'Use a 24-hour time like 09:00'),
    closes: z.string().regex(HHMM, 'Use a 24-hour time like 17:30'),
  })
  .refine((r) => r.opens < r.closes, {
    message: 'The closing time must be after the opening time',
    path: ['closes'],
  });
export type OpeningRange = z.infer<typeof OpeningRangeSchema>;

/** Opening hours in Settings → Business: up to two ranges per day; a day with no range is "Closed". */
export const OpeningHoursSchema = z
  .array(OpeningRangeSchema)
  .max(14)
  .superRefine((ranges, ctx) => {
    for (const day of OPENING_DAYS) {
      const own = ranges.filter((r) => r.day === day).sort((a, b) => a.opens.localeCompare(b.opens));
      if (own.length > 2)
        ctx.addIssue({
          code: 'custom',
          message: `${OPENING_DAY_NAMES[day]} has more than two opening times`,
          path: [],
        });
      for (let i = 1; i < own.length; i++) {
        if ((own[i]?.opens ?? '') < (own[i - 1]?.closes ?? ''))
          ctx.addIssue({
            code: 'custom',
            message: `${OPENING_DAY_NAMES[day]}'s opening times overlap`,
            path: [],
          });
      }
    }
  })
  .default([]);
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

/** Service words used to group searches (owner-editable). */
export const DEFAULT_SERVICE_TERMS = [
  'barber',
  'barbers',
  'barbershop',
  'barber shop',
  'haircut',
  'hair cut',
  'mens haircut',
  "men's haircut",
  'fade',
  'skin fade',
  'taper',
  'buzz cut',
  'beard trim',
  'beard',
  'shave',
  'hairdresser',
  'mens hairdresser',
] as const;

/**
 * The `website` settings section. `ownershipConfirmedHost`/`ownershipConfirmedAt` are written only by
 * `POST /api/website/ownership` (never by `PUT /api/settings`).
 */
export const WebsiteSettingsSchema = z.object({
  ownershipConfirmedHost: z.string().max(253).nullable().default(null),
  ownershipConfirmedAt: z.string().datetime().nullable().default(null),
  profileDetailsCheckedAt: z.string().datetime().nullable().default(null),
  brandTerms: z.array(z.string().trim().min(2).max(60)).max(10).default([]),
  placeTerms: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  serviceTerms: z
    .array(z.string().trim().min(2).max(40))
    .max(40)
    .default([...DEFAULT_SERVICE_TERMS]),
  checkExternalLinks: z.boolean().default(true),
});
export type WebsiteSettings = z.infer<typeof WebsiteSettingsSchema>;
/** Fields of the `website` section only the server writes. */
export const SERVER_ONLY_WEBSITE_FIELDS = ['ownershipConfirmedHost', 'ownershipConfirmedAt'] as const;

// ---------------------------------------------------------------------------------------------
// Stored JSON contracts (design §5.4)
// ---------------------------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);

/** One problem found by one check. `key` is stable across checks (`checkId:hash`). */
export const FindingSchema = z.object({
  key: text(120),
  checkId: text(60),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  effort: z.enum(EFFORTS),
  title: text(140),
  detail: text(1000),
  why: text(500),
  howToFix: z.array(text(300)).max(6),
  pages: z.array(z.string().url()).max(25),
  evidence: z.record(z.string(), z.union([text(300), z.number(), z.boolean(), z.null()])),
  editKind: WebsiteChangeKindSchema.nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Facts extracted from one page (never its HTML). */
export const PageSummarySchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  status: z.number().int().nullable(),
  error: text(200).nullable(),
  skipped: z.enum(['robots', 'non_html', 'too_large', 'out_of_scope', 'page_limit']).nullable(),
  redirectChain: z.array(z.string().url()).max(6),
  ttfbMs: z.number().int().nullable(),
  totalMs: z.number().int().nullable(),
  htmlBytes: z.number().int().nullable(),
  compressed: z.boolean().nullable(),
  title: text(300).nullable(),
  metaDescription: text(500).nullable(),
  h1: z.array(text(200)).max(10),
  headings: z.array(z.object({ level: z.number().int(), text: text(200) })).max(40),
  canonical: text(500).nullable(),
  metaRobots: text(200).nullable(),
  xRobotsTag: text(200).nullable(),
  lang: text(20).nullable(),
  viewport: text(200).nullable(),
  jsonLd: z
    .array(
      z.object({
        types: z.array(text(80)).max(10),
        raw: text(5000),
        valid: z.boolean(),
      }),
    )
    .max(10),
  microdataTypes: z.array(text(120)).max(10),
  nap: z.object({
    phones: z.array(text(40)).max(10),
    telLinks: z.array(text(40)).max(10),
    nameFound: z.boolean(),
    suburbFound: z.boolean(),
    postcodeFound: z.boolean(),
    streetFound: z.boolean(),
    /** Postcodes or street numbers written next to the suburb or street name that differ from Settings. */
    addressConflicts: z.array(text(120)).max(5).default([]),
  }),
  bookingLinkFound: z.boolean(),
  images: z
    .array(
      z.object({
        src: text(500),
        alt: text(300).nullable(),
        widthAttr: z.boolean(),
        heightAttr: z.boolean(),
        bytes: z.number().int().nullable(),
        intrinsicWidth: z.number().int().nullable(),
      }),
    )
    .max(60),
  headScripts: z.object({
    total: z.number().int(),
    blocking: z.number().int(),
  }),
  estimatedWeightBytes: z.number().int().nullable(),
  wordCount: z.number().int(),
  textSample: text(1500).nullable(),
  internalLinks: z.array(z.string().url()).max(200),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

/** The business details a check compared the site against (as they were at the time of the check). */
export const SettingsSnapshotSchema = z.object({
  businessName: text(80),
  addressLine: text(160),
  suburb: text(80),
  state: text(40),
  postcode: text(10),
  phone: text(40),
  website: text(300),
  bookingLink: text(500),
  openingHours: z.array(z.object({ day: z.enum(OPENING_DAYS), opens: text(5), closes: text(5) })).max(14),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshotSchema>;

/** The full stored result of one website check (`website_audits.result`). */
export const WebsiteAuditResultSchema = z.object({
  version: z.literal(1),
  siteRoot: z.string().url(),
  settingsSnapshot: SettingsSnapshotSchema,
  platformHint: z.enum(PLATFORM_HINTS),
  robots: z.object({
    status: z.enum(['ok', 'missing', 'unreachable', 'error']),
    sitemaps: z.array(text(500)).max(10),
    googlebotBlocksHome: z.boolean(),
    blockedForUs: z.array(text(500)).max(50),
    crawlDelaySec: z.number().nullable(),
    /** Key pages (contact, booking, services) Googlebot is asked not to read, home first. */
    googlebotBlockedPages: z.array(text(500)).max(10).default([]),
  }),
  sitemap: z.object({
    found: z.boolean(),
    sources: z.array(text(500)).max(5),
    urlCount: z.number().int(),
    invalid: z.boolean(),
    sample: z.array(text(500)).max(25),
    /** Whether the site root is listed (null when the sitemap could not be read). */
    homeListed: z.boolean().nullable().default(null),
    /** Sampled sitemap addresses that are not a plain, indexable page on this site. */
    badUrls: z
      .array(
        z.object({
          url: text(500),
          reason: z.enum(['error', 'redirect', 'noindex', 'out_of_scope']),
          status: z.number().int().nullable(),
        }),
      )
      .max(25)
      .default([]),
  }),
  hostVariants: z
    .array(
      z.object({
        url: text(500),
        status: z.number().int().nullable(),
        redirectsTo: text(500).nullable(),
      }),
    )
    .max(4),
  soft404: z.object({ testedUrl: text(500), status: z.number().int().nullable() }).nullable(),
  pages: z.array(PageSummarySchema).max(40),
  links: z.object({
    checked: z.number().int(),
    broken: z
      .array(
        z.object({
          url: text(500),
          status: z.number().int().nullable(),
          error: text(200).nullable(),
          internal: z.boolean(),
          foundOn: z.array(text(500)).max(5),
        }),
      )
      .max(100),
    unverifiable: z.number().int(),
  }),
  findings: z.array(FindingSchema).max(300),
  limits: z.object({
    maxPages: z.number().int(),
    hitPageLimit: z.boolean(),
    requests: z.number().int(),
    durationMs: z.number().int(),
  }),
});
export type WebsiteAuditResult = z.infer<typeof WebsiteAuditResultSchema>;
/** Everything a check gathers before the checks run (the result minus findings). */
export type CrawlFacts = Omit<WebsiteAuditResult, 'findings'>;

/** Counts and limits kept on every audit row (`website_audits.summary`), so history lists never load results. */
export const AuditSummarySchema = z.object({
  pagesChecked: z.number().int().default(0),
  pagesSkipped: z.number().int().default(0),
  counts: z
    .object({
      critical: z.number().int(),
      high: z.number().int(),
      medium: z.number().int(),
      low: z.number().int(),
      info: z.number().int(),
    })
    .default({ critical: 0, high: 0, medium: 0, low: 0, info: 0 }),
  partialReasons: z.array(z.string().max(300)).max(10).default([]),
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;

/** A concrete proposed edit (`website_edits.proposed_change`). Lengths are Zod checks only, never sent to an AI schema. */
export const WebsiteChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page_title'),
    pageUrl: z.string().url(),
    before: text(300).nullable(),
    after: z.string().trim().min(10).max(70),
  }),
  z.object({
    kind: z.literal('meta_description'),
    pageUrl: z.string().url(),
    before: text(500).nullable(),
    after: z.string().trim().min(50).max(170),
  }),
  z.object({
    kind: z.literal('text_replace'),
    pageUrl: z.string().url(),
    before: z.string().min(1).max(500),
    after: text(500),
  }),
  z.object({
    kind: z.literal('image_alt_text'),
    pageUrl: z.string().url(),
    imageSrc: text(500),
    before: text(300).nullable(),
    after: z.string().trim().min(3).max(125),
  }),
  z.object({
    kind: z.literal('structured_data'),
    pageUrl: z.string().url(),
    before: text(5000).nullable(),
    after: text(5000),
  }),
  z.object({
    kind: z.literal('head_snippet'),
    pageUrl: z.string().url(),
    before: text(500).nullable(),
    after: text(500),
  }),
  z.object({
    kind: z.literal('robots_txt'),
    pageUrl: z.string().url(),
    before: text(5000).nullable(),
    after: text(5000),
  }),
]);
export type WebsiteChange = z.infer<typeof WebsiteChangeSchema>;

/** Outcomes of an apply attempt (`website_edits.apply_result.outcome`). */
export const APPLY_OUTCOMES = ['applied', 'already_applied', 'conflict', 'not_found', 'auth', 'forbidden', 'unsupported', 'error'] as const;
export type ApplyOutcome = (typeof APPLY_OUTCOMES)[number];
/** Whether an applied change was seen afterwards. */
export const VERIFICATIONS = ['pending', 'confirmed_api', 'confirmed_public', 'not_visible', 'not_found'] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/** What an apply (or "I've made this change") recorded. Never holds credentials or whole page content. */
export const ApplyResultSchema = z.object({
  adapter: z.string().max(40).optional(),
  resourceType: z.string().max(20).optional(),
  resourceId: z.string().max(40).optional(),
  revisionNote: z.string().max(200).optional(),
  outcome: z.enum(APPLY_OUTCOMES).optional(),
  message: z.string().max(500).optional(),
  verification: z.enum(VERIFICATIONS).optional(),
  verifiedAt: z.string().optional(),
  /**
   * The durable "a write was sent" marker (design §7.4.1 exactly-once): stored, conditional on `applying`, right
   * before the write request, with the SHA-256 of the page content the write was computed from. A retry trusts only
   * this record, never the page text alone, to decide whether an earlier attempt already wrote.
   */
  writeSentAt: z.string().optional(),
  preWriteHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

// ---------------------------------------------------------------------------------------------
// Hashing (browser-safe)
// ---------------------------------------------------------------------------------------------

/** A short, stable, non-cryptographic hash (two FNV-1a passes, 12 hex characters) for keys. */
export function shortHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// Site scope and URLs (design §6.1)
// ---------------------------------------------------------------------------------------------

/** The part of the web a check may read: the saved host, its www./bare twin, http or https, under one path prefix. */
export interface SiteScope {
  /** The saved address, normalised (`https://example.com.au/`). */
  rootUrl: string;
  scheme: 'http' | 'https';
  host: string;
  twinHost: string;
  /** Always starts and ends with `/`. */
  pathPrefix: string;
}

const TRACKING_PARAMS = /^(utm_[a-z0-9_]*|gclid|fbclid|msclkid)$/i;

/** Lower-case host without a leading `www.` (the ownership host). */
export function ownershipHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * The scope of a website address from Settings → Business, or null when it is not a plain public http(s) address
 * (credentials, a port other than 80/443, or not a URL). An address typed without a scheme is read as https.
 */
export function siteScopeFrom(website: string): SiteScope | null {
  const raw = website.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.')) return null;
  const twinHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  const pathPrefix = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/';
  const scheme = u.protocol === 'http:' ? 'http' : 'https';
  return {
    rootUrl: `${scheme}://${host}${pathPrefix}`,
    scheme,
    host,
    twinHost,
    pathPrefix,
  };
}

/**
 * Normalises a URL for comparison and de-duplication: no fragment, lower-case scheme and host, no default port,
 * no tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`); path case and trailing slash kept. Null when the
 * value is not an absolute http(s) URL.
 */
export function normaliseUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  if ([...u.searchParams.keys()].length === 0) u.search = '';
  return u.toString();
}

/** True when the URL is on the scope's host or its twin, over http(s), under the scope's path prefix. */
export function isInScope(url: string, scope: SiteScope): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== scope.host && host !== scope.twinHost) return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  return u.pathname.startsWith(scope.pathPrefix);
}

/** True when the owner's ownership confirmation matches the scope's host (www. ignored). */
export function ownershipMatches(scope: SiteScope | null, confirmedHost: string | null | undefined): boolean {
  return Boolean(scope && confirmedHost && ownershipHost(scope.host) === confirmedHost.toLowerCase());
}

/** True when two URLs name the same page after normalisation (a trailing slash on the root is ignored). */
export function sameUrl(a: string, b: string): boolean {
  const na = normaliseUrl(a);
  const nb = normaliseUrl(b);
  if (!na || !nb) return false;
  const strip = (s: string) => s.replace(/\/$/, '');
  return na === nb || strip(na) === strip(nb);
}

/** Same page, also treating the www./bare twins and http/https as one site (WordPress `link` values vary). */
export function samePageOnSite(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const pa = ua.pathname.replace(/\/$/, '') || '/';
    const pb = ub.pathname.replace(/\/$/, '') || '/';
    return ownershipHost(ua.hostname) === ownershipHost(ub.hostname) && pa === pb && ua.search === ub.search;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Australian phone numbers (design §6.6)
// ---------------------------------------------------------------------------------------------

/** One Australian phone number in its usual forms. */
export interface AuPhone {
  /** National display form: `03 9499 1234`, `0412 345 678`, `1300 123 456`, `13 12 34`. */
  national: string;
  /** International form: `+61394991234` (empty for 13 numbers, which have none). */
  e164: string;
  /** National digits only (comparison key): `0394991234`. */
  digits: string;
}

/** Reads an Australian phone number in any common written form, or null when it is not one. */
export function normaliseAuPhone(input: string): AuPhone | null {
  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (/[^\d]/.test(digits)) return null;
  if (digits.startsWith('61') && (digits.length === 11 || (digits.length === 12 && digits[2] === '0'))) digits = `0${digits.slice(digits.length - 9)}`;
  if (/^1[38]00\d{6}$/.test(digits))
    return {
      national: `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`,
      e164: `+61${digits}`,
      digits,
    };
  if (/^13\d{4}$/.test(digits))
    return {
      national: `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}`,
      e164: '',
      digits,
    };
  if (/^04\d{8}$/.test(digits))
    return {
      national: `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`,
      e164: `+61${digits.slice(1)}`,
      digits,
    };
  if (/^0[2378]\d{8}$/.test(digits))
    return {
      national: `${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`,
      e164: `+61${digits.slice(1)}`,
      digits,
    };
  return null;
}

/** International display form of a number: `+61 3 9499 1234`, `+61 412 345 678`. */
export function internationalAuPhone(phone: AuPhone): string {
  const d = phone.digits;
  if (d.startsWith('04')) return `+61 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (/^0[2378]/.test(d)) return `+61 ${d.slice(1, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  return phone.national;
}

const PHONE_PATTERN = /(?:\+?61[\s.-]?\(?0?\)?[\s.-]?[2-478](?:[\s.-]?\d){8}|\(?0[2-478]\)?(?:[\s.-]?\d){8}|1[38]00(?:[\s.-]?\d){6}|\b13(?:[\s.-]?\d){4}\b)/g;

/** Every distinct Australian phone number written in a text (as written, up to `max`). */
export function findAuPhones(textValue: string, max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of textValue.matchAll(PHONE_PATTERN)) {
    const parsed = normaliseAuPhone(m[0]);
    if (!parsed || seen.has(parsed.digits)) continue;
    seen.add(parsed.digits);
    out.push(m[0].trim().slice(0, 40));
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Search-query grouping (design §6.5)
// ---------------------------------------------------------------------------------------------

/** The groups searches are shown in. "Not listed" is computed separately and never redistributed. */
export const QUERY_GROUPS = ['brand', 'local', 'service', 'other'] as const;
export type QueryGroup = (typeof QUERY_GROUPS)[number];

/** Normalises a search or term: NFKD, no diacritics, lower case, `&` → `and`, apostrophes removed, other punctuation → space. */
export function normaliseQueryText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set(['the', 'and', 'co', 'studio', 'shop', 'salon', 'lounge', 'mens', 'men', 'of', 'a']);
const NEAR_TERMS = ['near me', 'nearby', 'close to me', 'closest'];

/** Ready-to-use word lists for {@link classifyQuery}. */
export interface QueryClassifier {
  brandPhrases: string[];
  placeTerms: string[];
  serviceTerms: string[];
  /** The business name is only everyday words, so only the full name counts as a brand search. */
  brandAmbiguous: boolean;
}

/** Builds the word lists once from settings (business name, owner-listed terms, domain stem, handles, suburb, postcode). */
export function buildQueryClassifier(settings: Pick<AppSettings, 'brand' | 'business' | 'website'>): QueryClassifier {
  const norm = (v: string) => normaliseQueryText(v);
  const serviceTerms = uniq(settings.website.serviceTerms.map(norm));
  const placeTerms = uniq([settings.business.suburb, settings.business.postcode, ...settings.website.placeTerms].map(norm));
  const name = norm(settings.brand.businessName);
  const brandPhrases = [name, ...settings.website.brandTerms.map(norm)];
  const scope = siteScopeFrom(settings.business.website);
  if (scope) {
    const stem = ownershipHost(scope.host).split('.')[0] ?? '';
    if (stem.length >= 4) brandPhrases.push(stem.replace(/-/g, ' '), stem.replace(/-/g, ''));
  }
  for (const handle of [settings.business.instagramHandle, settings.business.tiktokHandle]) {
    const h = norm(handle.replace(/^@/, ''));
    if (h.length >= 4) brandPhrases.push(h);
  }
  const serviceWords = new Set(serviceTerms.flatMap((t) => t.split(' ')));
  const placeWords = new Set(placeTerms.flatMap((t) => t.split(' ')));
  const core = name.split(' ').filter((w) => w && !STOP_WORDS.has(w) && !serviceWords.has(w) && !placeWords.has(w));
  const brandAmbiguous = core.length === 0;
  if (!brandAmbiguous) brandPhrases.push(core.join(' '));
  return {
    brandPhrases: uniq(brandPhrases.filter((p) => p.length >= 2)),
    placeTerms: uniq([...placeTerms, ...NEAR_TERMS]),
    serviceTerms,
    brandAmbiguous,
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** True when `phrase` appears in `query` as a whole-word sequence (both normalised). */
export function containsPhrase(query: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${query} `.includes(` ${phrase} `);
}

/** Groups one search: brand → local (service + place) → service → other. A search naming the business and the suburb is brand. */
export function classifyQuery(query: string, cfg: QueryClassifier): QueryGroup {
  const q = normaliseQueryText(query);
  if (cfg.brandPhrases.some((p) => containsPhrase(q, p))) return 'brand';
  const service = cfg.serviceTerms.some((t) => containsPhrase(q, t));
  if (service && cfg.placeTerms.some((t) => containsPhrase(q, t))) return 'local';
  if (service) return 'service';
  return 'other';
}

/** Searches Google counted in the day's total but did not list individually: total minus listed, clamped at 0. */
export function notListedRemainder(total: { clicks: number; impressions: number }, listed: { clicks: number; impressions: number }): { clicks: number; impressions: number } {
  return {
    clicks: Math.max(0, total.clicks - listed.clicks),
    impressions: Math.max(0, total.impressions - listed.impressions),
  };
}

// ---------------------------------------------------------------------------------------------
// Prepared changes: dedupe, refresh, supersede and verification (design §6.9)
// ---------------------------------------------------------------------------------------------

const ONE_PER_PAGE: ReadonlySet<WebsiteChangeKind> = new Set(['page_title', 'meta_description', 'structured_data', 'head_snippet', 'robots_txt']);

/** One open change per page per kind (titles, descriptions, …), or per target text / image for the others. */
export function editDedupeKey(change: WebsiteChange): string {
  const page = normaliseUrl(change.pageUrl) ?? change.pageUrl;
  if (ONE_PER_PAGE.has(change.kind)) return `${change.kind}:${page}:${change.kind}`;
  const target = change.kind === 'image_alt_text' ? change.imageSrc : change.before;
  return `${change.kind}:${page}:${shortHash(target ?? '')}`;
}

/**
 * The stored change after a newer check prepared the same one: `before` always follows the latest page facts;
 * `after` is refreshed only when the wording is still the rule's own (owner and AI wording is kept).
 */
export function refreshChange(existing: WebsiteChange, source: WebsiteEditSource, fresh: WebsiteChange): WebsiteChange {
  if (existing.kind !== fresh.kind) return existing;
  if (source === 'audit_rule') return fresh;
  return { ...existing, before: fresh.before } as WebsiteChange;
}

/** Whether the change's old and new text are on the page right now; null when the check cannot tell. */
export interface ChangeObservation {
  beforePresent: boolean;
  afterPresent: boolean;
}

/**
 * What a check saw of a change's target on its page. `textHits` holds the watched strings found in the page's full
 * visible text (the crawl records them for open and pending changes, since summaries keep only a sample).
 */
export function observeChange(change: WebsiteChange, page: PageSummary | undefined, textHits?: ReadonlySet<string>): ChangeObservation | null {
  if (!page || page.status === null || page.status >= 400 || page.skipped) return null;
  const eq = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();
  switch (change.kind) {
    case 'page_title':
      return {
        beforePresent: eq(page.title, change.before),
        afterPresent: eq(page.title, change.after),
      };
    case 'meta_description':
      return {
        beforePresent: eq(page.metaDescription, change.before),
        afterPresent: eq(page.metaDescription, change.after),
      };
    case 'image_alt_text': {
      const img = page.images.find((i) => i.src === change.imageSrc);
      if (!img) return { beforePresent: false, afterPresent: false };
      return {
        beforePresent: eq(img.alt, change.before),
        afterPresent: eq(img.alt, change.after),
      };
    }
    case 'text_replace': {
      if (!textHits) return null;
      return {
        beforePresent: textHits.has(change.before),
        afterPresent: change.after.length > 0 && textHits.has(change.after),
      };
    }
    case 'structured_data': {
      const after = change.after.replace(/\s+/g, '');
      const present = page.jsonLd.some((b) => b.raw.replace(/\s+/g, '') === after || after.includes(b.raw.replace(/\s+/g, '')));
      return {
        beforePresent: change.before !== null && page.jsonLd.some((b) => b.raw === change.before),
        afterPresent: present,
      };
    }
    default:
      return null;
  }
}

/** The supersede reason for an open change after a check, or null to keep it open. */
export function supersedeReason(input: {
  status: WebsiteEditStatus;
  source: WebsiteEditSource;
  change: WebsiteChange;
  findingKey: string | null;
  currentFindingKeys: ReadonlySet<string>;
  observation: ChangeObservation | null;
}): 'finding_gone' | 'page_changed' | null {
  if (input.status !== 'proposed' && input.status !== 'apply_failed') return null;
  if (input.source === 'audit_rule' && input.findingKey && !input.currentFindingKeys.has(input.findingKey)) return 'finding_gone';
  const o = input.observation;
  if (o && input.change.before !== null && input.change.before !== '' && !o.beforePresent && !o.afterPresent) return 'page_changed';
  return null;
}

/** Verification of an applied change from the latest check: `after` seen → confirmed; `before` still seen → not visible yet. */
export function verificationFromObservation(observation: ChangeObservation | null): Verification | null {
  if (!observation) return null;
  if (observation.afterPresent) return 'confirmed_public';
  if (observation.beforePresent) return 'not_visible';
  return null;
}

// ---------------------------------------------------------------------------------------------
// AI wording claim checks (design §6.7)
// ---------------------------------------------------------------------------------------------

const BANNED_PHRASES = [
  'best',
  '#1',
  'number one',
  'no. 1',
  'no 1',
  'top-rated',
  'top rated',
  'award',
  'awards',
  'award-winning',
  'guarantee',
  'guaranteed',
  'rank',
  'ranking',
  'ranked',
  'first page',
  'cheapest',
  'google',
];
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|au|net|org|io|co)\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Length limits per kind for wording (titles 10–70, descriptions 50–170). */
export const COPY_LIMITS: Partial<Record<WebsiteChangeKind, { min: number; max: number }>> = {
  page_title: { min: 10, max: 70 },
  meta_description: { min: 50, max: 170 },
  image_alt_text: { min: 3, max: 125 },
};

/**
 * Rules every AI wording option must pass (and soft warnings for the owner's own text): length, no web or email
 * address, no phone number other than the studio's, no ranking or superiority claims, and a title must name the
 * business. Returns the problems in plain words (empty = passes).
 */
export function checkCopyClaims(value: string, input: { kind: WebsiteChangeKind; businessName: string; phone: string }): string[] {
  const problems: string[] = [];
  const v = value.trim();
  const limits = COPY_LIMITS[input.kind];
  if (limits && (v.length < limits.min || v.length > limits.max)) problems.push(`It should be ${limits.min}–${limits.max} characters (it is ${v.length}).`);
  const lower = ` ${v.toLowerCase().replace(/[^\p{L}\p{N}#.-]+/gu, ' ')} `;
  for (const phrase of BANNED_PHRASES) {
    const hit = phrase.startsWith('#') ? lower.includes(phrase) : lower.includes(` ${phrase} `) || lower.includes(` ${phrase}.`);
    if (hit) {
      problems.push(`It says “${phrase}”, which is a claim we don't make (rankings, awards or “best”).`);
      break;
    }
  }
  if (URL_RE.test(v)) problems.push('It contains a web address.');
  if (EMAIL_RE.test(v)) problems.push('It contains an email address.');
  const own = normaliseAuPhone(input.phone);
  for (const p of findAuPhones(v)) {
    if (normaliseAuPhone(p)?.digits !== own?.digits) {
      problems.push('It contains a phone number that is not the studio’s.');
      break;
    }
  }
  if (input.kind === 'page_title' && input.businessName.trim() && !normaliseQueryText(v).includes(normaliseQueryText(input.businessName))) {
    problems.push('A page title should include the business name.');
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Copy-paste instructions (design §6.8)
// ---------------------------------------------------------------------------------------------

/** Instructions for making a change by hand: plain text (for copying) and Markdown (for display). */
export interface EditInstructions {
  text: string;
  markdown: string;
}

const KIND_INTRO: Record<WebsiteChangeKind, string> = {
  page_title: 'Change the page title of',
  meta_description: 'Change the search description of',
  text_replace: 'Change the text on',
  image_alt_text: 'Add a description to an image on',
  structured_data: 'Update the business details code (structured data) on',
  head_snippet: 'Change a setting in the page header code of',
  robots_txt: "Change your site's robots.txt (it applies to",
};

/** Generic, builder-neutral steps for making a change by hand (no researched menu paths, so none are invented). */
export function renderEditInstructions(change: WebsiteChange, platformHint: PlatformHint | null): EditInstructions {
  const lines: string[] = [];
  const heading = change.kind === 'robots_txt' ? `${KIND_INTRO.robots_txt} ${change.pageUrl})` : `${KIND_INTRO[change.kind]} ${change.pageUrl}`;
  const steps: string[] = [];
  const before = change.before ?? '(nothing yet)';
  switch (change.kind) {
    case 'page_title':
      steps.push(
        "Open your website editor and go to this page's settings.",
        'Find the search or SEO title setting (often called "SEO title", "Page title" or "Title tag").',
        `Replace:  ${before}\n   With:     ${change.after}`,
        'Save and publish.',
      );
      break;
    case 'meta_description':
      steps.push(
        "Open your website editor and go to this page's settings.",
        'Find the search description setting (often called "SEO description" or "Meta description").',
        `Replace:  ${before}\n   With:     ${change.after}`,
        'Save and publish.',
      );
      break;
    case 'text_replace':
      steps.push('Open this page in your website editor.', `Find the text:  ${change.before}`, `Change it to:   ${change.after}`, 'Save and publish.');
      break;
    case 'image_alt_text':
      steps.push(
        'Open this page in your website editor and select the image:',
        `   ${change.imageSrc}`,
        'Find its description setting (often called "Alt text" or "Image description").',
        `Enter:  ${change.after}`,
        'Save and publish.',
      );
      break;
    case 'structured_data':
      steps.push(
        "Open your site's header code (code injection) setting, or your SEO plugin's schema setting, for the home page only.",
        change.before ? 'Replace the existing business details block with the code below.' : 'Paste the code below.',
        `${change.after}`,
        "Save and publish, then test the page with Google's Rich Results Test.",
      );
      break;
    case 'head_snippet':
      steps.push("Open your site's header code (code injection) setting for this page.", `Replace:  ${before}\n   With:     ${change.after}`, 'Save and publish.');
      break;
    case 'robots_txt':
      steps.push('Open the robots.txt file at the root of your site (your host or SEO plugin may manage it).', 'Change it to read:', change.after, 'Save it.');
      break;
  }
  steps.push('Back in Studio Assistant, press "I\'ve made this change". Your next website check confirms it.');
  const builder =
    platformHint && platformHint !== 'unknown'
      ? `Your site looks like it's built with ${WEBSITE_PLATFORM_NAMES[platformHint]}, so the setting names below may differ slightly.`
      : null;
  const developer =
    change.kind === 'robots_txt' || change.kind === 'head_snippet' || change.kind === 'structured_data'
      ? "If you don't manage your site's code, send these steps to your web developer."
      : null;
  lines.push(heading);
  if (builder) lines.push(builder);
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (developer) lines.push(developer);
  const md: string[] = [`**${heading}**`];
  if (builder) md.push(`_${builder}_`);
  steps.forEach((s, i) => md.push(`${i + 1}. ${s.includes('\n') || s.length > 200 ? `\n\n\`\`\`\n${s.replace(/`/g, "'")}\n\`\`\`` : s}`));
  if (developer) md.push(developer);
  return { text: lines.join('\n'), markdown: md.join('\n') };
}

/** Plain title for a prepared change (card heading). */
export function changeTitle(change: WebsiteChange, siteRoot: string | null): string {
  const isHome = siteRoot ? sameUrl(change.pageUrl, siteRoot) : false;
  const page = isHome ? 'home page' : 'page';
  switch (change.kind) {
    case 'page_title':
      return `Rewrite the ${page} title`;
    case 'meta_description':
      return `Write a search description for the ${page}`;
    case 'text_replace':
      return `Correct text on the ${page}`;
    case 'image_alt_text':
      return `Describe an image on the ${page}`;
    case 'structured_data':
      return `Update the business details code on the ${page}`;
    case 'head_snippet':
      return `Change the ${page} header code`;
    case 'robots_txt':
      return 'Update robots.txt';
  }
}
