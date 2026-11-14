import { robotsWithoutBlocking } from './robots.js';
import type { AppSettings } from './settings.js';
import {
  CATEGORIES,
  OPENING_DAY_NAMES,
  changeTitle,
  internationalAuPhone,
  normaliseAuPhone,
  normaliseQueryText,
  containsPhrase,
  sameUrl,
  shortHash,
  siteScopeFrom,
  isInScope,
  ownershipHost,
  type AuditSummary,
  type CrawlFacts,
  type Effort,
  type Finding,
  type FindingCategory,
  type OpeningHours,
  type PageSummary,
  type Severity,
  type SettingsSnapshot,
  type WebsiteChange,
  type WebsiteChangeKind,
} from './website.js';

/**
 * The website check catalogue (design §6.3), prioritisation (§6.4) and the changes prepared from settings without
 * AI (§6.6). Every function is pure: the worker gathers {@link CrawlFacts}, these turn them into findings and
 * prepared changes. Wording never promises rankings (§10.4).
 */

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

export const TITLE_MIN = 20;
export const TITLE_MAX = 65;
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 170;
export const HOME_THIN_WORDS = 150;
export const SLOW_TTFB_MS = 1_500;
export const HEAVY_PAGE_BYTES = 3 * 1024 * 1024;
export const VERY_HEAVY_PAGE_BYTES = 6 * 1024 * 1024;
export const LARGE_IMAGE_BYTES = 500 * 1024;
export const BIG_IMAGE_BYTES = 200 * 1024;
export const OVERSIZED_IMAGE_WIDTH = 2_400;
export const BLOCKING_SCRIPTS_MAX = 3;
export const PROFILE_CHECK_MAX_DAYS = 180;
/** The default business name: still equal to it means "not entered yet". */
export const DEFAULT_BUSINESS_NAME = 'My Barber Studio';

/** schema.org types of the LocalBusiness family a barber's site may use (to our knowledge; design open question §15.5). */
export const LOCAL_BUSINESS_TYPES = new Set(
  ['LocalBusiness', 'HealthAndBeautyBusiness', 'HairSalon', 'BeautySalon', 'DaySpa', 'NailSalon', 'TattooParlor', 'HealthClub', 'ProfessionalService', 'Store'].map((t) =>
    t.toLowerCase(),
  ),
);
/** Types people use for barbers that schema.org does not define (as far as we know): flagged, not trusted. */
export const UNRECOGNISED_BUSINESS_TYPES = new Set(['barbershop', 'barber', 'barbersalon']);

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

interface CheckDef {
  category: FindingCategory;
  severity: Severity;
  effort: Effort;
  title: string;
  why: string;
  howToFix: string[];
  editKind: WebsiteChangeKind | null;
}

/** Every check: category, default severity, effort, plain title, why it matters and how to fix it. */
export const CHECKS = {
  site_unreachable: {
    category: 'indexing',
    severity: 'critical',
    effort: 'developer',
    title: "We couldn't reach your website",
    why: 'If the site does not answer, visitors and Google cannot see it either.',
    howToFix: ['Check the website address in Settings → Business.', 'Open the site on your phone. If it does not load, contact your website host.'],
    editKind: null,
  },
  robots_blocks_google: {
    category: 'indexing',
    severity: 'critical',
    effort: 'quick',
    title: 'Your robots.txt asks Google not to read important pages',
    why: "This is how Google is likely to read your robots.txt: pages it is asked not to read usually can't appear properly in search results.",
    howToFix: ['Remove the robots.txt rule that blocks these pages (a prepared version is below).', 'If someone else manages your site, send them the steps.'],
    editKind: 'robots_txt',
  },
  robots_unreachable: {
    category: 'indexing',
    severity: 'high',
    effort: 'developer',
    title: "Your robots.txt didn't answer",
    why: 'When robots.txt gives a server error, search engines may treat the whole site as off-limits until it answers again.',
    howToFix: ['Ask your website host why /robots.txt returns an error.', 'A missing robots.txt (not found) is fine; an error is not.'],
    editKind: null,
  },
  page_noindex: {
    category: 'indexing',
    severity: 'high',
    effort: 'quick',
    title: 'Pages ask search engines not to list them',
    why: 'A "noindex" setting tells Google not to show the page in search results.',
    howToFix: [
      'In your website editor, find the page\'s search visibility setting (often "Hide from search engines" or "noindex").',
      'Turn it off for pages customers should find, then publish.',
    ],
    editKind: null,
  },
  https_missing: {
    category: 'indexing',
    severity: 'high',
    effort: 'developer',
    title: "Your site isn't always on a secure (https) address",
    why: 'Browsers warn visitors about pages that are not secure, and people may leave.',
    howToFix: ['Ask your host to turn on a free security certificate (https).', 'Make the http:// address forward to https://.'],
    editKind: null,
  },
  host_variants_split: {
    category: 'indexing',
    severity: 'medium',
    effort: 'developer',
    title: 'Your site answers on two addresses',
    why: 'With and without "www." both showing the site can split how Google counts your pages.',
    howToFix: ['Choose one address (with or without "www.").', 'Ask your host to forward the other one to it.'],
    editKind: null,
  },
  canonical_elsewhere: {
    category: 'indexing',
    severity: 'high',
    effort: 'moderate',
    title: 'Pages point search engines to a different address',
    why: 'A "canonical" link to another page or website tells Google to show that one instead.',
    howToFix: ['Check your SEO plugin or page settings for a canonical address.', 'Each page should point to its own address on your site.'],
    editKind: null,
  },
  canonical_missing: {
    category: 'indexing',
    severity: 'low',
    effort: 'moderate',
    title: "The home page doesn't name its main address",
    why: 'A canonical link tells search engines which address is the main one when a page can be reached in several ways.',
    howToFix: ["Add the canonical line below to the home page's header code, or turn it on in your SEO plugin."],
    editKind: 'head_snippet',
  },
  soft_404: {
    category: 'indexing',
    severity: 'medium',
    effort: 'developer',
    title: 'Missing pages look like real pages',
    why: 'An address that does not exist should say "not found". If it shows a normal page instead, search engines can get confused about which pages are real.',
    howToFix: ['Ask your web developer to make unknown addresses return a "404 Not Found" page.'],
    editKind: null,
  },
  sitemap_missing: {
    category: 'indexing',
    severity: 'medium',
    effort: 'moderate',
    title: 'No sitemap found',
    why: 'A sitemap lists your pages so search engines can find them all.',
    howToFix: ['Most website builders and SEO plugins can create a sitemap; turn it on.', 'Then add it in Google Search Console.'],
    editKind: null,
  },
  sitemap_invalid: {
    category: 'indexing',
    severity: 'medium',
    effort: 'developer',
    title: "Your sitemap couldn't be read",
    why: 'A sitemap that is not valid XML is ignored by search engines.',
    howToFix: ['Ask your web developer or SEO plugin to regenerate the sitemap.'],
    editKind: null,
  },
  sitemap_bad_urls: {
    category: 'indexing',
    severity: 'medium',
    effort: 'moderate',
    title: "Your sitemap lists addresses that aren't normal pages",
    why: 'A sitemap should list only pages that load, are on your site and may appear in search.',
    howToFix: ['Remove or fix the listed addresses in your sitemap settings.'],
    editKind: null,
  },
  sitemap_not_in_robots: {
    category: 'indexing',
    severity: 'low',
    effort: 'quick',
    title: "Your robots.txt doesn't mention your sitemap",
    why: 'Naming the sitemap in robots.txt helps search engines find it.',
    howToFix: ['Add the "Sitemap:" line shown below to robots.txt.'],
    editKind: 'robots_txt',
  },
  home_not_in_sitemap: {
    category: 'indexing',
    severity: 'low',
    effort: 'moderate',
    title: "Your home page isn't in your sitemap",
    why: 'The sitemap should include your most important page.',
    howToFix: ['Check your sitemap settings and include the home page.'],
    editKind: null,
  },
  lang_missing: {
    category: 'content',
    severity: 'low',
    effort: 'developer',
    title: "The site doesn't say which language it is in",
    why: 'The page language helps browsers, screen readers and search engines read your text correctly.',
    howToFix: ['Set the site language to English (Australia) in your website settings, or ask your developer to add lang="en-AU".'],
    editKind: null,
  },
  title_missing: {
    category: 'content',
    severity: 'high',
    effort: 'quick',
    title: 'Pages without a title',
    why: 'Google often shows the page title in search results. A clear title that says what you do and where helps people choose you.',
    howToFix: ['Give each page a title in its page or SEO settings (a suggestion is prepared below).'],
    editKind: 'page_title',
  },
  title_length: {
    category: 'content',
    severity: 'low',
    effort: 'quick',
    title: 'Page titles that are very short or long',
    why: 'Titles of roughly 30–60 characters usually show in full. Google decides how much to show, so this is approximate.',
    howToFix: ['Rewrite the title to say what the page is, the business name and the suburb.'],
    editKind: 'page_title',
  },
  title_duplicate: {
    category: 'content',
    severity: 'medium',
    effort: 'quick',
    title: 'Several pages share the same title',
    why: 'When pages share a title, people (and Google) cannot tell them apart in search results.',
    howToFix: ['Give each page its own title that says what is on it.'],
    editKind: 'page_title',
  },
  title_home_local: {
    category: 'content',
    severity: 'medium',
    effort: 'quick',
    title: "The home page title doesn't say what you do and where",
    why: 'People searching for a barber nearby look for the service and the suburb in the results. Including both can help them find you.',
    howToFix: ['Use a home page title like the one prepared below.'],
    editKind: 'page_title',
  },
  meta_description_missing: {
    category: 'content',
    severity: 'medium',
    effort: 'quick',
    title: 'Pages without a search description',
    why: 'Google sometimes shows this description under your title. Without one it picks text from the page.',
    howToFix: ["Add a one- or two-sentence description in each page's SEO settings."],
    editKind: 'meta_description',
  },
  meta_description_length: {
    category: 'content',
    severity: 'low',
    effort: 'quick',
    title: 'Search descriptions that are very short or long',
    why: 'Descriptions of roughly 70–160 characters usually show in full; Google decides how much to show.',
    howToFix: ['Rewrite the description in one or two plain sentences.'],
    editKind: 'meta_description',
  },
  meta_description_duplicate: {
    category: 'content',
    severity: 'low',
    effort: 'quick',
    title: 'Several pages share the same search description',
    why: 'Each page is easier to recognise in search results with its own description.',
    howToFix: ['Write a description that fits each page.'],
    editKind: 'meta_description',
  },
  h1_missing: {
    category: 'content',
    severity: 'medium',
    effort: 'moderate',
    title: 'Pages without a main heading',
    why: 'A main heading (H1) tells visitors and search engines what the page is about.',
    howToFix: ['Make the first big heading on each page a "Heading 1" in your editor.'],
    editKind: null,
  },
  h1_multiple: {
    category: 'content',
    severity: 'low',
    effort: 'moderate',
    title: 'Pages with more than one main heading',
    why: 'One main heading per page keeps the page structure clear.',
    howToFix: ['Keep one "Heading 1" and make the others "Heading 2".'],
    editKind: null,
  },
  heading_skips: {
    category: 'content',
    severity: 'info',
    effort: 'moderate',
    title: 'Headings skip levels',
    why: 'Headings in order (H1, H2, H3) help people using screen readers.',
    howToFix: ['Use heading levels in order without skipping.'],
    editKind: null,
  },
  home_thin: {
    category: 'content',
    severity: 'low',
    effort: 'moderate',
    title: 'The home page has very little text',
    why: 'A few sentences about your services, suburb and how to book help visitors and search engines understand the studio.',
    howToFix: ['Add a short paragraph: what you offer, where you are, opening hours and how to book.'],
    editKind: null,
  },
  local_mentions_missing: {
    category: 'content',
    severity: 'medium',
    effort: 'quick',
    title: "Your suburb isn't mentioned on the home or contact page",
    why: 'Saying where you are helps people searching nearby recognise you.',
    howToFix: ['Add a sentence like the one in "What we found" to your home or contact page.'],
    editKind: null,
  },
  booking_link_missing: {
    category: 'business_info',
    severity: 'medium',
    effort: 'quick',
    title: "Your booking link isn't on your website",
    why: 'Visitors who are ready to book should find the button straight away.',
    howToFix: ['Add a "Book now" button that opens your booking link on the home page and in the menu.'],
    editKind: null,
  },
  booking_link_broken: {
    category: 'links',
    severity: 'high',
    effort: 'quick',
    title: "Your booking link doesn't work",
    why: 'People who try to book and hit an error may go elsewhere.',
    howToFix: ['Open the booking link from Settings → Business yourself.', 'Copy the current link from your booking system and update it in Settings and on your site.'],
    editKind: null,
  },
  nap_name_missing: {
    category: 'business_info',
    severity: 'medium',
    effort: 'quick',
    title: "Your business name isn't on the home or contact page",
    why: 'The same name on your website and Google listing helps people and Google connect them.',
    howToFix: ['Show the business name exactly as in Settings on the home and contact pages.'],
    editKind: null,
  },
  nap_phone_missing: {
    category: 'business_info',
    severity: 'high',
    effort: 'quick',
    title: "Your phone number isn't on your website",
    why: 'Customers often want to call. The same number everywhere also avoids confusion.',
    howToFix: ['Add the phone number from Settings to the contact page and footer.'],
    editKind: null,
  },
  nap_phone_mismatch: {
    category: 'business_info',
    severity: 'high',
    effort: 'quick',
    title: 'Your website shows a different phone number',
    why: 'A different number confuses customers and Google.',
    howToFix: ['Replace the old number with the one in Settings (a prepared change is below).', 'If the other number is also yours, you can dismiss this.'],
    editKind: 'text_replace',
  },
  nap_address_missing: {
    category: 'business_info',
    severity: 'high',
    effort: 'quick',
    title: "Your address isn't on the home or contact page",
    why: 'Your street, suburb and postcode help people find you and match your Google listing.',
    howToFix: ['Show the full address from Settings on the contact page (and ideally in the footer).'],
    editKind: null,
  },
  nap_address_mismatch: {
    category: 'business_info',
    severity: 'high',
    effort: 'quick',
    title: 'Your website shows a different address',
    why: 'A different postcode or street number confuses customers and Google.',
    howToFix: ['Correct the address on the listed pages to match Settings.'],
    editKind: null,
  },
  tel_link_missing: {
    category: 'mobile',
    severity: 'medium',
    effort: 'quick',
    title: "Your phone number can't be tapped to call",
    why: 'On a phone, a tappable number lets customers call in one tap.',
    howToFix: ['Make the phone number a link to "tel:" followed by the number (most editors have a "phone link" option).'],
    editKind: null,
  },
  profile_details_unchecked: {
    category: 'business_info',
    severity: 'info',
    effort: 'quick',
    title: 'Check your Google Business Profile matches these details',
    why: 'We cannot read your Business Profile without Google approval, so this one is a manual check.',
    howToFix: ['Open your Business Profile on Google, compare name, address, phone and hours, then tick "I\'ve checked" on this page.'],
    editKind: null,
  },
  settings_incomplete: {
    category: 'business_info',
    severity: 'info',
    effort: 'quick',
    title: 'Some business details are missing in Settings',
    why: 'We compare your website with these details, so some checks were skipped.',
    howToFix: ['Add the missing details in Settings → Business (and the business name in Branding).'],
    editKind: null,
  },
  localbusiness_missing: {
    category: 'structured_data',
    severity: 'medium',
    effort: 'moderate',
    title: 'No business details code (structured data) on the home page',
    why: 'Structured data describes your business (name, address, phone, hours) in a form search engines read directly.',
    howToFix: ['Add the code prepared below to the home page header, or fill in the business details in your SEO plugin.'],
    editKind: 'structured_data',
  },
  jsonld_invalid: {
    category: 'structured_data',
    severity: 'high',
    effort: 'developer',
    title: 'Broken structured data',
    why: 'Code with a mistake in it is ignored by search engines.',
    howToFix: ['Ask your developer or SEO plugin to fix or remove the broken "application/ld+json" block.'],
    editKind: null,
  },
  localbusiness_mismatch: {
    category: 'structured_data',
    severity: 'medium',
    effort: 'moderate',
    title: "Your business details code doesn't match Settings",
    why: 'Search engines read these details directly, so they should match your real name, address, phone and hours.',
    howToFix: ['Replace the business details code with the corrected version below.'],
    editKind: 'structured_data',
  },
  localbusiness_type_unrecognised: {
    category: 'structured_data',
    severity: 'low',
    effort: 'quick',
    title: 'Business type not recognised',
    why: 'As far as we know, schema.org has no "BarberShop" type; "HairSalon" is the closest standard type. Confirm on schema.org.',
    howToFix: ['Change the type to "HairSalon" (a corrected version is below).'],
    editKind: 'structured_data',
  },
  viewport_missing: {
    category: 'mobile',
    severity: 'high',
    effort: 'developer',
    title: "Pages aren't set up for phones",
    why: 'Without a mobile viewport setting, phones show a tiny desktop page.',
    howToFix: ['Add the viewport line below to the page header, or ask your developer.'],
    editKind: 'head_snippet',
  },
  viewport_zoom_disabled: {
    category: 'mobile',
    severity: 'low',
    effort: 'developer',
    title: 'Zooming is turned off on phones',
    why: 'Some people need to zoom in to read. Blocking zoom makes the site harder to use.',
    howToFix: ['Remove "user-scalable=no" and "maximum-scale" from the viewport line.'],
    editKind: 'head_snippet',
  },
  slow_response: {
    category: 'performance',
    severity: 'medium',
    effort: 'developer',
    title: 'Your server is slow to start answering',
    why: 'Measured from our server, not from a phone in Ivanhoe. A slow first response delays every page.',
    howToFix: ['Ask your host about caching or a faster plan.'],
    editKind: null,
  },
  page_heavy: {
    category: 'performance',
    severity: 'medium',
    effort: 'developer',
    title: 'Heavy pages',
    why: 'Large pages take longer to load on mobile data.',
    howToFix: ['Use smaller images and remove unused scripts.'],
    editKind: null,
  },
  image_large: {
    category: 'performance',
    severity: 'low',
    effort: 'moderate',
    title: 'Large image files',
    why: 'Big image files slow pages down on phones.',
    howToFix: ['Export photos as JPEG or WebP at the size they are shown (usually under 200 KB).'],
    editKind: null,
  },
  image_oversized: {
    category: 'performance',
    severity: 'low',
    effort: 'moderate',
    title: 'Images much wider than any screen',
    why: 'Images over 2,400 pixels wide are rarely needed on a website.',
    howToFix: ['Resize photos to about 1,600–2,000 pixels wide before uploading.'],
    editKind: null,
  },
  image_missing_dimensions: {
    category: 'performance',
    severity: 'low',
    effort: 'developer',
    title: 'Images without a set size',
    why: 'Without width and height, the page can jump around while images load.',
    howToFix: ['Ask your developer to add width and height to images (many builders do this automatically).'],
    editKind: null,
  },
  image_alt_missing: {
    category: 'content',
    severity: 'medium',
    effort: 'quick',
    title: 'Images without a description',
    why: 'Descriptions (alt text) are read aloud to people who cannot see the image and help search engines understand it.',
    howToFix: ['Describe what is in each image in a few words, for example "Skin fade with a textured top".', 'Decorative images can have an empty description.'],
    editKind: 'image_alt_text',
  },
  no_compression: {
    category: 'performance',
    severity: 'low',
    effort: 'developer',
    title: "Pages aren't compressed",
    why: 'Compressed pages download faster.',
    howToFix: ['Ask your host to turn on gzip or Brotli compression.'],
    editKind: null,
  },
  render_blocking_scripts: {
    category: 'performance',
    severity: 'low',
    effort: 'developer',
    title: 'Scripts that hold up the page',
    why: 'Several scripts in the page header without "async" or "defer" delay the first view.',
    howToFix: ['Ask your developer to load these scripts with "defer" or remove unused ones.'],
    editKind: null,
  },
  broken_internal_link: {
    category: 'links',
    severity: 'medium',
    effort: 'quick',
    title: 'Broken links on your site',
    why: 'Links that lead nowhere frustrate visitors.',
    howToFix: ['Fix or remove the links listed below.'],
    editKind: null,
  },
  broken_external_link: {
    category: 'links',
    severity: 'low',
    effort: 'quick',
    title: 'Links to other websites that no longer work',
    why: 'Visitors who follow them hit an error page.',
    howToFix: ['Update or remove the links listed below.'],
    editKind: null,
  },
  redirect_chain: {
    category: 'links',
    severity: 'low',
    effort: 'moderate',
    title: 'Links that go through several redirects',
    why: 'Each extra redirect makes the page slower to open.',
    howToFix: ['Point links straight at the final address.'],
    editKind: null,
  },
} as const satisfies Record<string, CheckDef>;
export type CheckId = keyof typeof CHECKS;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Builds one finding from the catalogue entry (key `checkId:hash(scopeKey)`), with the given detail and pages. */
export function buildFinding(
  checkId: CheckId,
  scopeKey: string,
  input: {
    detail: string;
    pages?: string[];
    evidence?: Finding['evidence'];
    severity?: Severity;
    editKind?: WebsiteChangeKind | null;
  },
): Finding {
  const def: CheckDef = CHECKS[checkId];
  return {
    key: `${checkId}:${shortHash(scopeKey)}`,
    checkId,
    category: def.category,
    severity: input.severity ?? def.severity,
    effort: def.effort,
    title: def.title,
    detail: clip(input.detail, 1000),
    why: def.why,
    howToFix: [...def.howToFix],
    pages: [...new Set(input.pages ?? [])].slice(0, 25),
    evidence: Object.fromEntries(Object.entries(input.evidence ?? {}).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 300) : v])),
    editKind: input.editKind === undefined ? def.editKind : input.editKind,
  };
}

function listPages(urls: string[]): string {
  const shown = urls.slice(0, 5).join(', ');
  return urls.length > 5 ? `${shown} and ${urls.length - 5} more` : shown;
}

/** Pages that were fetched and answered with a normal HTML page. */
export function fetchedPages(facts: Pick<CrawlFacts, 'pages'>): PageSummary[] {
  return facts.pages.filter((p) => p.skipped === null && p.error === null && p.status !== null && p.status >= 200 && p.status < 300);
}

/** The site root's page summary (the first page that is the root), if it was fetched. */
export function homePage(facts: Pick<CrawlFacts, 'pages' | 'siteRoot'>): PageSummary | undefined {
  return facts.pages.find((p) => sameUrl(p.url, facts.siteRoot) || sameUrl(p.finalUrl, facts.siteRoot));
}

const KEY_PAGE_RE = /\/(contact|contact-us|book|booking|bookings|book-now|services|prices|pricing|location|find-us|about)(\/|$|\.)/i;
/** Contact, booking and services pages, found by their address. */
export function isKeyPage(url: string): boolean {
  try {
    return KEY_PAGE_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
/** The contact page (by its address), if one was fetched. */
export function contactPage(pages: PageSummary[]): PageSummary | undefined {
  return pages.find((p) => /\/(contact|contact-us|find-us|location)(\/|$|\.)/i.test(safePath(p.finalUrl)));
}
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** The business details a check compares the site against. */
export function settingsSnapshot(settings: Pick<AppSettings, 'brand' | 'business'>): SettingsSnapshot {
  const b = settings.business;
  return {
    businessName: settings.brand.businessName.slice(0, 80),
    addressLine: b.addressLine.slice(0, 160),
    suburb: b.suburb.slice(0, 80),
    state: b.state.slice(0, 40),
    postcode: b.postcode.slice(0, 10),
    phone: b.phone.slice(0, 40),
    website: b.website.slice(0, 300),
    bookingLink: b.bookingLink.slice(0, 500),
    openingHours: (b.openingHours ?? []).map((r) => ({
      day: r.day,
      opens: r.opens,
      closes: r.closes,
    })),
  };
}

/** The business name, or '' while it is still the default placeholder. */
export function realBusinessName(name: string): string {
  const n = name.trim();
  return n && n !== DEFAULT_BUSINESS_NAME ? n : '';
}

/** Lower-case type names of a JSON-LD block (`HairSalon`, `https://schema.org/HairSalon` → `hairsalon`). */
function plainType(t: string): string {
  return t
    .replace(/^https?:\/\/schema\.org\//i, '')
    .trim()
    .toLowerCase();
}

/** Every object in a parsed JSON-LD value (arrays and `@graph` flattened). */
export function jsonLdObjects(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((v) => jsonLdObjects(v, depth + 1));
  const obj = value as Record<string, unknown>;
  const out = [obj];
  if (Array.isArray(obj['@graph'])) out.push(...jsonLdObjects(obj['@graph'], depth + 1));
  return out;
}

function typesOf(obj: Record<string, unknown>): string[] {
  const t = obj['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string').map(plainType);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/**
 * Runs every check on the gathered facts and returns the findings (unsorted; see {@link prioritiseFindings}).
 * `now` decides the Business Profile reminder. A site that did not answer gives only `site_unreachable`.
 */
export function runWebsiteChecks(facts: CrawlFacts, settings: Pick<AppSettings, 'brand' | 'business' | 'website'>, now: Date = new Date()): Finding[] {
  const out: Finding[] = [];
  const home = homePage(facts);
  if (!home || home.status === null || home.status >= 500 || home.error) {
    out.push(
      buildFinding('site_unreachable', 'site', {
        detail: home?.error
          ? `${facts.siteRoot}: ${home.error}`
          : home?.status
            ? `${facts.siteRoot} answered with an error (HTTP ${home.status}).`
            : `${facts.siteRoot} did not answer.`,
        pages: [facts.siteRoot],
        evidence: { status: home?.status ?? null, error: home?.error ?? null },
      }),
    );
    return out;
  }
  const pages = fetchedPages(facts);
  const homeOk = pages.includes(home);
  const snap = facts.settingsSnapshot;
  const name = realBusinessName(snap.businessName);
  const contact = contactPage(pages);
  const napPages = [home, ...(contact && contact !== home ? [contact] : [])].filter((p) => pages.includes(p));

  // --- Indexing
  if (facts.robots.googlebotBlocksHome || facts.robots.googlebotBlockedPages.length > 0) {
    const blocked = facts.robots.googlebotBlockedPages.length ? facts.robots.googlebotBlockedPages : [facts.siteRoot];
    out.push(
      buildFinding('robots_blocks_google', 'robots', {
        detail: `Pages Google is asked not to read: ${listPages(blocked)}.`,
        pages: blocked,
        evidence: { homeBlocked: facts.robots.googlebotBlocksHome },
      }),
    );
  }
  if (facts.robots.status === 'unreachable')
    out.push(
      buildFinding('robots_unreachable', 'robots', {
        detail: `${new URL('/robots.txt', facts.siteRoot).toString()} gave a server error or did not answer.`,
      }),
    );
  const noindex = pages.filter((p) => /\b(noindex|none)\b/i.test(`${p.metaRobots ?? ''} ${p.xRobotsTag ?? ''}`));
  if (noindex.length) {
    const homeNo = noindex.includes(home);
    out.push(
      buildFinding('page_noindex', 'pages', {
        detail: `${homeNo ? 'Your home page and ' : ''}${noindex.length} page${noindex.length === 1 ? '' : 's'} ask${noindex.length === 1 ? 's' : ''} not to be listed: ${listPages(noindex.map((p) => p.finalUrl))}.`,
        pages: noindex.map((p) => p.finalUrl),
        severity: homeNo ? 'critical' : 'high',
        evidence: { homeNoindex: homeNo },
      }),
    );
  }
  const httpVariant = facts.hostVariants.find(
    (v) =>
      v.url.startsWith('http://') &&
      ownershipHost(new URL(v.url).hostname) === ownershipHost(new URL(facts.siteRoot).hostname) &&
      !new URL(v.url).hostname.startsWith('www.') === !new URL(facts.siteRoot).hostname.startsWith('www.'),
  );
  const siteIsHttp = facts.siteRoot.startsWith('http://') && !home.finalUrl.startsWith('https://');
  const httpNotRedirected = httpVariant && httpVariant.status !== null && httpVariant.status < 300;
  if (siteIsHttp || httpNotRedirected) {
    out.push(
      buildFinding('https_missing', 'https', {
        detail: siteIsHttp ? `Your site opens on ${home.finalUrl} (not secure).` : `${httpVariant?.url} shows the site instead of forwarding to the secure address.`,
        evidence: {
          siteRoot: facts.siteRoot,
          httpStatus: httpVariant?.status ?? null,
        },
      }),
    );
  }
  const httpsVariants = facts.hostVariants.filter((v) => v.url.startsWith('https://'));
  if (httpsVariants.length === 2 && httpsVariants.every((v) => v.status !== null && v.status >= 200 && v.status < 300) && !home.canonical) {
    out.push(
      buildFinding('host_variants_split', 'hosts', {
        detail: `Both ${httpsVariants.map((v) => v.url).join(' and ')} show the site without forwarding to one address.`,
      }),
    );
  }
  const canonicalOff = pages.filter((p) => {
    if (!p.canonical) return false;
    try {
      const c = new URL(p.canonical, p.finalUrl);
      const f = new URL(p.finalUrl);
      if (ownershipHost(c.hostname) !== ownershipHost(f.hostname)) return true;
      return (c.pathname.replace(/\/$/, '') || '/') !== (f.pathname.replace(/\/$/, '') || '/');
    } catch {
      return false;
    }
  });
  if (canonicalOff.length) {
    out.push(
      buildFinding('canonical_elsewhere', 'pages', {
        detail: canonicalOff
          .slice(0, 5)
          .map((p) => `${p.finalUrl} points to ${p.canonical}`)
          .join('; '),
        pages: canonicalOff.map((p) => p.finalUrl),
      }),
    );
  }
  if (homeOk && !home.canonical)
    out.push(
      buildFinding('canonical_missing', 'home', {
        detail: 'The home page has no canonical link.',
        pages: [home.finalUrl],
      }),
    );
  if (facts.soft404 && facts.soft404.status !== null && facts.soft404.status >= 200 && facts.soft404.status < 300) {
    out.push(
      buildFinding('soft_404', 'site', {
        detail: `${facts.soft404.testedUrl} (an address that does not exist) showed a normal page (HTTP ${facts.soft404.status}).`,
        evidence: { testedUrl: facts.soft404.testedUrl },
      }),
    );
  }
  if (!facts.sitemap.found)
    out.push(
      buildFinding('sitemap_missing', 'site', {
        detail: 'No sitemap in robots.txt, at /sitemap.xml or at /sitemap_index.xml.',
      }),
    );
  else if (facts.sitemap.invalid)
    out.push(
      buildFinding('sitemap_invalid', 'site', {
        detail: `${facts.sitemap.sources[0] ?? 'The sitemap'} is not a valid sitemap file.`,
      }),
    );
  else {
    if (facts.sitemap.badUrls.length) {
      const reasons: Record<string, string> = {
        error: 'does not load',
        redirect: 'redirects',
        noindex: 'asks not to be listed',
        out_of_scope: 'is not on your site',
      };
      out.push(
        buildFinding('sitemap_bad_urls', 'sitemap', {
          detail: facts.sitemap.badUrls
            .slice(0, 5)
            .map((b) => `${b.url} ${reasons[b.reason]}`)
            .join('; '),
          evidence: { count: facts.sitemap.badUrls.length },
        }),
      );
    }
    if (facts.robots.sitemaps.length === 0 && (facts.robots.status === 'ok' || facts.robots.status === 'missing')) {
      out.push(
        buildFinding('sitemap_not_in_robots', 'robots', {
          detail: `Your sitemap is at ${facts.sitemap.sources[0] ?? ''}, but robots.txt doesn't say so.`,
          evidence: { sitemap: facts.sitemap.sources[0] ?? null },
        }),
      );
    }
    if (facts.sitemap.homeListed === false)
      out.push(
        buildFinding('home_not_in_sitemap', 'site', {
          detail: `${facts.siteRoot} is not listed in the sitemap.`,
        }),
      );
  }

  // --- Content
  if (homeOk && !home.lang)
    out.push(
      buildFinding('lang_missing', 'home', {
        detail: 'The home page has no language setting.',
      }),
    );
  else if (homeOk && home.lang && !/^en(-au)?$/i.test(home.lang))
    out.push(
      buildFinding('lang_missing', 'home', {
        detail: `The home page says its language is "${home.lang}", not English (Australia).`,
        severity: 'info',
      }),
    );
  const noTitle = pages.filter((p) => !p.title?.trim());
  if (noTitle.length)
    out.push(
      buildFinding('title_missing', 'pages', {
        detail: `${noTitle.length} page${noTitle.length === 1 ? ' has' : 's have'} no title: ${listPages(noTitle.map((p) => p.finalUrl))}.`,
        pages: noTitle.map((p) => p.finalUrl),
      }),
    );
  const badLength = pages.filter((p) => p.title?.trim() && (p.title.trim().length < TITLE_MIN || p.title.trim().length > TITLE_MAX));
  if (badLength.length) {
    out.push(
      buildFinding('title_length', 'pages', {
        detail: badLength
          .slice(0, 5)
          .map((p) => `${p === home ? 'Home page' : p.finalUrl} title: "${clip(p.title ?? '', 80)}" (${p.title?.trim().length ?? 0} characters)`)
          .join('; '),
        pages: badLength.map((p) => p.finalUrl),
      }),
    );
  }
  for (const [title, group] of groupBy(
    pages.filter((p) => p.title?.trim()),
    (p) => normaliseQueryText(p.title ?? ''),
  )) {
    if (group.length < 2 || !title) continue;
    out.push(
      buildFinding('title_duplicate', `title:${title}`, {
        detail: `${group.length} pages use the title "${clip(group[0]?.title ?? '', 80)}": ${listPages(group.map((p) => p.finalUrl))}.`,
        pages: group.map((p) => p.finalUrl),
      }),
    );
  }
  if (homeOk && home.title?.trim()) {
    const t = normaliseQueryText(home.title);
    const hasSuburb = snap.suburb.trim() !== '' && containsPhrase(t, normaliseQueryText(snap.suburb));
    const hasService = settings.website.serviceTerms.some((s) => containsPhrase(t, normaliseQueryText(s)));
    if (!hasSuburb || !hasService) {
      out.push(
        buildFinding('title_home_local', 'home', {
          detail: `Home page title: "${clip(home.title, 120)}". It ${!hasSuburb && !hasService ? `doesn't mention ${snap.suburb || 'your suburb'} or a service` : !hasSuburb ? `doesn't mention ${snap.suburb || 'your suburb'}` : "doesn't mention a service such as barber"}.`,
          pages: [home.finalUrl],
        }),
      );
    }
  }
  const noDesc = pages.filter((p) => !p.metaDescription?.trim());
  if (noDesc.length)
    out.push(
      buildFinding('meta_description_missing', 'pages', {
        detail: `${noDesc.length} page${noDesc.length === 1 ? ' has' : 's have'} no search description: ${listPages(noDesc.map((p) => p.finalUrl))}.`,
        pages: noDesc.map((p) => p.finalUrl),
      }),
    );
  const descLength = pages.filter((p) => p.metaDescription?.trim() && (p.metaDescription.trim().length < DESCRIPTION_MIN || p.metaDescription.trim().length > DESCRIPTION_MAX));
  if (descLength.length) {
    out.push(
      buildFinding('meta_description_length', 'pages', {
        detail: descLength
          .slice(0, 5)
          .map((p) => `${p.finalUrl}: ${p.metaDescription?.trim().length ?? 0} characters`)
          .join('; '),
        pages: descLength.map((p) => p.finalUrl),
      }),
    );
  }
  for (const [desc, group] of groupBy(
    pages.filter((p) => p.metaDescription?.trim()),
    (p) => normaliseQueryText(p.metaDescription ?? ''),
  )) {
    if (group.length < 2 || !desc) continue;
    out.push(
      buildFinding('meta_description_duplicate', `desc:${desc}`, {
        detail: `${group.length} pages share one search description: ${listPages(group.map((p) => p.finalUrl))}.`,
        pages: group.map((p) => p.finalUrl),
      }),
    );
  }
  const noH1 = pages.filter((p) => p.h1.length === 0);
  if (noH1.length)
    out.push(
      buildFinding('h1_missing', 'pages', {
        detail: `No main heading on: ${listPages(noH1.map((p) => p.finalUrl))}.`,
        pages: noH1.map((p) => p.finalUrl),
      }),
    );
  const manyH1 = pages.filter((p) => p.h1.length > 1);
  if (manyH1.length)
    out.push(
      buildFinding('h1_multiple', 'pages', {
        detail: `More than one main heading on: ${listPages(manyH1.map((p) => p.finalUrl))}.`,
        pages: manyH1.map((p) => p.finalUrl),
      }),
    );
  const skips = pages.filter((p) => p.headings.some((h, i) => i > 0 && h.level > (p.headings[i - 1]?.level ?? h.level) + 1));
  if (skips.length)
    out.push(
      buildFinding('heading_skips', 'pages', {
        detail: `Heading levels skip on: ${listPages(skips.map((p) => p.finalUrl))}.`,
        pages: skips.map((p) => p.finalUrl),
      }),
    );
  if (homeOk && home.wordCount < HOME_THIN_WORDS)
    out.push(
      buildFinding('home_thin', 'home', {
        detail: `The home page has about ${home.wordCount} words of text.`,
        pages: [home.finalUrl],
        evidence: { words: home.wordCount },
      }),
    );
  if (snap.suburb.trim() && napPages.length && !napPages.some((p) => p.nap.suburbFound)) {
    const sentence = `${name || 'We'} ${name ? 'is a barber studio' : 'are a barber studio'} in ${snap.suburb}${snap.state ? `, ${snap.state}` : ''}.`;
    out.push(
      buildFinding('local_mentions_missing', 'nap', {
        detail: `Neither the home page nor the contact page mentions ${snap.suburb}. A sentence you could add: "${sentence}"`,
        pages: napPages.map((p) => p.finalUrl),
      }),
    );
  }

  // --- Business details
  const missingSettings: string[] = [];
  if (!name) missingSettings.push('business name');
  if (!snap.phone.trim()) missingSettings.push('phone number');
  if (!snap.addressLine.trim()) missingSettings.push('street address');
  if (!snap.suburb.trim() || !snap.postcode.trim()) missingSettings.push('suburb and postcode');
  if (missingSettings.length)
    out.push(
      buildFinding('settings_incomplete', 'settings', {
        detail: `Missing in Settings: ${missingSettings.join(', ')}. Checks that need them were skipped.`,
      }),
    );
  if (snap.bookingLink.trim()) {
    const brokenBooking = facts.links.broken.find((l) => sameUrl(l.url, snap.bookingLink));
    if (brokenBooking) {
      out.push(
        buildFinding('booking_link_broken', 'booking', {
          detail: `${snap.bookingLink} ${brokenBooking.status ? `answered with an error (HTTP ${brokenBooking.status})` : `could not be opened${brokenBooking.error ? ` (${brokenBooking.error})` : ''}`}.`,
          evidence: { status: brokenBooking.status },
        }),
      );
    }
    if (!pages.some((p) => p.bookingLinkFound))
      out.push(
        buildFinding('booking_link_missing', 'booking', {
          detail: `None of the ${pages.length} checked pages links to ${snap.bookingLink}.`,
        }),
      );
  }
  if (name && napPages.length && !napPages.some((p) => p.nap.nameFound))
    out.push(
      buildFinding('nap_name_missing', 'nap', {
        detail: `"${name}" doesn't appear on the home or contact page.`,
        pages: napPages.map((p) => p.finalUrl),
      }),
    );
  const own = normaliseAuPhone(snap.phone);
  if (own) {
    const allPhones = pages.flatMap((p) =>
      [...p.nap.phones, ...p.nap.telLinks].map((raw) => ({
        raw,
        page: p,
        parsed: normaliseAuPhone(raw),
      })),
    );
    if (!allPhones.some((x) => x.parsed?.digits === own.digits))
      out.push(
        buildFinding('nap_phone_missing', 'nap', {
          detail: `${own.national} doesn't appear on any of the ${pages.length} checked pages.`,
        }),
      );
    const wrong = allPhones.filter((x) => x.parsed && x.parsed.digits !== own.digits && x.page.nap.phones.includes(x.raw));
    if (wrong.length) {
      const numbers = [...new Set(wrong.map((w) => w.parsed?.national ?? w.raw))];
      out.push(
        buildFinding('nap_phone_mismatch', 'nap', {
          detail: `Your website shows ${numbers.slice(0, 3).join(', ')}${numbers.length > 3 ? ' and more' : ''}; Settings say ${own.national}.`,
          pages: wrong.map((w) => w.page.finalUrl),
          evidence: {
            settingsPhone: own.national,
            found: numbers.slice(0, 5).join(', '),
          },
        }),
      );
    }
  }
  if (napPages.length && (snap.addressLine.trim() || (snap.suburb.trim() && snap.postcode.trim()))) {
    const streetMissing = snap.addressLine.trim() !== '' && !napPages.some((p) => p.nap.streetFound);
    const areaMissing = snap.suburb.trim() !== '' && snap.postcode.trim() !== '' && !napPages.some((p) => p.nap.suburbFound && p.nap.postcodeFound);
    if (streetMissing || areaMissing) {
      out.push(
        buildFinding('nap_address_missing', 'nap', {
          detail: `${streetMissing ? `"${snap.addressLine}"` : `${snap.suburb} ${snap.postcode}`} doesn't appear on the home or contact page.`,
          pages: napPages.map((p) => p.finalUrl),
        }),
      );
    }
  }
  const conflicts = pages.filter((p) => p.nap.addressConflicts.length);
  if (conflicts.length) {
    out.push(
      buildFinding('nap_address_mismatch', 'nap', {
        detail: `Found ${conflicts
          .flatMap((p) => p.nap.addressConflicts)
          .slice(0, 3)
          .map((c) => `"${c}"`)
          .join(', ')}; Settings say ${[snap.addressLine, snap.suburb, snap.state, snap.postcode].filter(Boolean).join(' ')}.`,
        pages: conflicts.map((p) => p.finalUrl),
      }),
    );
  }
  const phonePages = pages.filter((p) => p.nap.phones.length);
  if (phonePages.length && !pages.some((p) => p.nap.telLinks.length))
    out.push(
      buildFinding('tel_link_missing', 'site', {
        detail: 'Your phone number is shown, but nowhere as a tap-to-call link.',
        pages: phonePages.map((p) => p.finalUrl),
      }),
    );
  const checkedAt = settings.website.profileDetailsCheckedAt ? Date.parse(settings.website.profileDetailsCheckedAt) : NaN;
  if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > PROFILE_CHECK_MAX_DAYS * 86_400_000) {
    out.push(
      buildFinding('profile_details_unchecked', 'profile', {
        detail: Number.isFinite(checkedAt)
          ? 'You last confirmed your Business Profile details more than 6 months ago.'
          : "You haven't confirmed yet that your Google Business Profile shows the same details.",
      }),
    );
  }

  // --- Structured data
  const invalidLd = pages.filter((p) => p.jsonLd.some((b) => !b.valid));
  if (invalidLd.length)
    out.push(
      buildFinding('jsonld_invalid', 'pages', {
        detail: `Structured data that can't be read on: ${listPages(invalidLd.map((p) => p.finalUrl))}.`,
        pages: invalidLd.map((p) => p.finalUrl),
      }),
    );
  if (homeOk) {
    const homeTypes = [...home.jsonLd.filter((b) => b.valid).flatMap((b) => b.types.map(plainType)), ...home.microdataTypes.map((t) => plainType(t.split('/').pop() ?? t))];
    const family = homeTypes.some((t) => LOCAL_BUSINESS_TYPES.has(t));
    const unrecognised = homeTypes.filter((t) => UNRECOGNISED_BUSINESS_TYPES.has(t));
    if (!family && unrecognised.length === 0)
      out.push(
        buildFinding('localbusiness_missing', 'home', {
          detail: 'The home page has no LocalBusiness-type structured data.',
          pages: [home.finalUrl],
        }),
      );
    if (unrecognised.length)
      out.push(
        buildFinding('localbusiness_type_unrecognised', 'home', {
          detail: `The home page uses the type "${unrecognised[0]}", which is not a recognised schema.org type as far as we know.`,
          pages: [home.finalUrl],
        }),
      );
    const block = findBusinessBlock(home);
    if (block) {
      const diffs = businessBlockDifferences(block.object, snap);
      if (diffs.length)
        out.push(
          buildFinding('localbusiness_mismatch', 'home', {
            detail: `In the home page's business details code: ${diffs.join('; ')}.`,
            pages: [home.finalUrl],
          }),
        );
    }
  }

  // --- Mobile
  const noViewport = pages.filter((p) => !p.viewport || !/width\s*=\s*device-width/i.test(p.viewport));
  if (noViewport.length)
    out.push(
      buildFinding('viewport_missing', 'pages', {
        detail: `No mobile viewport setting on: ${listPages(noViewport.map((p) => p.finalUrl))}.`,
        pages: noViewport.map((p) => p.finalUrl),
      }),
    );
  const zoomOff = pages.filter((p) => p.viewport && (/user-scalable\s*=\s*(no|0)/i.test(p.viewport) || maxScaleAtMostOne(p.viewport)));
  if (zoomOff.length)
    out.push(
      buildFinding('viewport_zoom_disabled', 'pages', {
        detail: `Zoom is turned off on: ${listPages(zoomOff.map((p) => p.finalUrl))}.`,
        pages: zoomOff.map((p) => p.finalUrl),
      }),
    );

  // --- Speed (measured from our server)
  const ttfb = median(pages.map((p) => p.ttfbMs).filter((v): v is number => v !== null));
  if (ttfb !== null && ttfb > SLOW_TTFB_MS)
    out.push(
      buildFinding('slow_response', 'site', {
        detail: `Your server took about ${(ttfb / 1000).toFixed(1)} s to start answering (middle value over ${pages.length} pages, measured from our server, not from a phone in Ivanhoe).`,
        evidence: { medianTtfbMs: Math.round(ttfb) },
      }),
    );
  const heavy = pages.filter((p) => (p.estimatedWeightBytes ?? 0) > HEAVY_PAGE_BYTES);
  if (heavy.length) {
    const veryHeavy = heavy.some((p) => (p.estimatedWeightBytes ?? 0) > VERY_HEAVY_PAGE_BYTES);
    out.push(
      buildFinding('page_heavy', 'pages', {
        detail: heavy
          .slice(0, 5)
          .map((p) => `${p.finalUrl}: about ${mb(p.estimatedWeightBytes ?? 0)}`)
          .join('; '),
        pages: heavy.map((p) => p.finalUrl),
        severity: veryHeavy ? 'high' : 'medium',
      }),
    );
  }
  const images = uniqueImages(pages);
  const big = images.filter((i) => (i.bytes ?? 0) > BIG_IMAGE_BYTES);
  if (big.length) {
    const large = big.some((i) => (i.bytes ?? 0) > LARGE_IMAGE_BYTES);
    out.push(
      buildFinding('image_large', 'images', {
        detail: big
          .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
          .slice(0, 5)
          .map((i) => `${i.src} (${kb(i.bytes ?? 0)})`)
          .join('; '),
        pages: [...new Set(big.map((i) => i.page))],
        severity: large ? 'medium' : 'low',
        evidence: { count: big.length },
      }),
    );
  }
  const oversized = images.filter((i) => (i.intrinsicWidth ?? 0) > OVERSIZED_IMAGE_WIDTH);
  if (oversized.length)
    out.push(
      buildFinding('image_oversized', 'images', {
        detail: oversized
          .slice(0, 5)
          .map((i) => `${i.src} (${i.intrinsicWidth} px wide)`)
          .join('; '),
        pages: [...new Set(oversized.map((i) => i.page))],
      }),
    );
  const noDims = images.filter((i) => !i.widthAttr || !i.heightAttr);
  if (noDims.length)
    out.push(
      buildFinding('image_missing_dimensions', 'images', {
        detail: `${noDims.length} image${noDims.length === 1 ? '' : 's'} without a width and height, for example ${noDims[0]?.src}.`,
        pages: [...new Set(noDims.map((i) => i.page))],
      }),
    );
  const noAlt = images.filter((i) => i.alt === null);
  if (noAlt.length)
    out.push(
      buildFinding('image_alt_missing', 'images', {
        detail: `${noAlt.length} image${noAlt.length === 1 ? ' has' : 's have'} no description, for example ${noAlt
          .slice(0, 3)
          .map((i) => i.src)
          .join(', ')}.`,
        pages: [...new Set(noAlt.map((i) => i.page))],
        evidence: { count: noAlt.length },
      }),
    );
  if (homeOk && home.compressed === false)
    out.push(
      buildFinding('no_compression', 'home', {
        detail: 'The home page was sent without gzip or Brotli compression.',
      }),
    );
  const blocking = pages.filter((p) => p.headScripts.blocking > BLOCKING_SCRIPTS_MAX);
  if (blocking.length)
    out.push(
      buildFinding('render_blocking_scripts', 'pages', {
        detail: blocking
          .slice(0, 5)
          .map((p) => `${p.finalUrl}: ${p.headScripts.blocking} scripts`)
          .join('; '),
        pages: blocking.map((p) => p.finalUrl),
      }),
    );

  // --- Links
  const brokenInternal = facts.links.broken.filter((l) => l.internal);
  if (brokenInternal.length) {
    const fromHome = brokenInternal.some((l) => l.foundOn.some((u) => sameUrl(u, home.finalUrl) || sameUrl(u, facts.siteRoot)));
    out.push(
      buildFinding('broken_internal_link', 'links', {
        detail: brokenInternal
          .slice(0, 5)
          .map((l) => `${l.url} (${l.status ? `HTTP ${l.status}` : (l.error ?? 'no answer')}), linked from ${l.foundOn[0] ?? 'a page'}`)
          .join('; '),
        pages: brokenInternal.flatMap((l) => l.foundOn),
        severity: fromHome ? 'high' : 'medium',
        evidence: { count: brokenInternal.length },
      }),
    );
  }
  const brokenExternal = facts.links.broken.filter(
    (l) => !l.internal && !sameUrl(l.url, snap.bookingLink || 'about:blank') && (l.status === 404 || l.status === 410 || (l.status === null && l.error !== null)),
  );
  if (brokenExternal.length) {
    out.push(
      buildFinding('broken_external_link', 'links', {
        detail: brokenExternal
          .slice(0, 5)
          .map((l) => `${l.url} (${l.status ? `HTTP ${l.status}` : (l.error ?? 'no answer')})`)
          .join('; '),
        pages: brokenExternal.flatMap((l) => l.foundOn),
        evidence: { count: brokenExternal.length },
      }),
    );
  }
  const chains = pages.filter((p) => p.redirectChain.length > 1);
  if (chains.length)
    out.push(
      buildFinding('redirect_chain', 'pages', {
        detail: chains
          .slice(0, 5)
          .map((p) => `${p.url} goes through ${p.redirectChain.length} redirects`)
          .join('; '),
        pages: chains.map((p) => p.url),
      }),
    );

  return out.slice(0, 300);
}

function maxScaleAtMostOne(viewport: string): boolean {
  const m = /maximum-scale\s*=\s*([0-9.]+)/i.exec(viewport);
  return m ? Number(m[1]) <= 1 : false;
}

function groupBy<T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

function uniqueImages(pages: PageSummary[]): Array<PageSummary['images'][number] & { page: string }> {
  const seen = new Set<string>();
  const out: Array<PageSummary['images'][number] & { page: string }> = [];
  for (const p of pages) {
    for (const img of p.images) {
      if (seen.has(img.src)) continue;
      seen.add(img.src);
      out.push({ ...img, page: p.finalUrl });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Structured data helpers
// ---------------------------------------------------------------------------------------------

/** The home page's first business-type JSON-LD object (and its whole block), if any. */
export function findBusinessBlock(page: PageSummary): { raw: string; object: Record<string, unknown> } | null {
  for (const block of page.jsonLd) {
    if (!block.valid) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.raw);
    } catch {
      continue;
    }
    const obj = jsonLdObjects(parsed).find((o) => typesOf(o).some((t) => LOCAL_BUSINESS_TYPES.has(t) || UNRECOGNISED_BUSINESS_TYPES.has(t)));
    if (obj) return { raw: block.raw, object: obj };
  }
  return null;
}

/** Plain differences between a business JSON-LD object and Settings (only fields Settings has). */
export function businessBlockDifferences(obj: Record<string, unknown>, snap: SettingsSnapshot): string[] {
  const diffs: string[] = [];
  const name = realBusinessName(snap.businessName);
  if (name && typeof obj['name'] === 'string' && normaliseQueryText(obj['name']) !== normaliseQueryText(name))
    diffs.push(`name is "${clip(obj['name'], 60)}", Settings say "${name}"`);
  const own = normaliseAuPhone(snap.phone);
  if (own && typeof obj['telephone'] === 'string') {
    const theirs = normaliseAuPhone(obj['telephone']);
    if (theirs?.digits !== own.digits) diffs.push(`phone is "${clip(obj['telephone'], 30)}", Settings say ${own.national}`);
  }
  const addr = obj['address'];
  if (addr && typeof addr === 'object' && !Array.isArray(addr)) {
    const a = addr as Record<string, unknown>;
    const cmp = (field: string, want: string, label: string) => {
      const have = a[field];
      if (want.trim() && typeof have === 'string' && normaliseQueryText(have) !== normaliseQueryText(want)) diffs.push(`${label} is "${clip(have, 60)}", Settings say "${want}"`);
    };
    cmp('streetAddress', snap.addressLine, 'street');
    cmp('addressLocality', snap.suburb, 'suburb');
    cmp('postalCode', snap.postcode, 'postcode');
  }
  if (snap.openingHours.length && Array.isArray(obj['openingHoursSpecification'])) {
    const have = new Set(
      (obj['openingHoursSpecification'] as unknown[]).flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const spec = s as Record<string, unknown>;
        const days = (Array.isArray(spec['dayOfWeek']) ? spec['dayOfWeek'] : [spec['dayOfWeek']]).filter((d): d is string => typeof d === 'string');
        return days.map((d) => `${d.replace(/^https?:\/\/schema\.org\//i, '').slice(0, 2)}|${String(spec['opens'] ?? '').slice(0, 5)}|${String(spec['closes'] ?? '').slice(0, 5)}`);
      }),
    );
    const want = new Set(snap.openingHours.map((r) => `${r.day}|${r.opens}|${r.closes}`));
    if (have.size !== want.size || [...want].some((w) => !have.has(w))) diffs.push('opening hours differ from Settings');
  }
  return diffs;
}

/** The LocalBusiness fields built from Settings; fields Settings doesn't have are omitted, never guessed. */
export function localBusinessFields(snap: SettingsSnapshot, websiteRoot: string, handles: { instagram: string; tiktok: string }): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    '@type': 'HairSalon',
    '@id': `${websiteRoot.replace(/#.*$/, '')}#business`,
    url: websiteRoot,
  };
  const name = realBusinessName(snap.businessName);
  if (name) fields['name'] = name;
  const phone = normaliseAuPhone(snap.phone);
  if (phone) fields['telephone'] = internationalAuPhone(phone);
  if (snap.addressLine.trim() || snap.suburb.trim() || snap.postcode.trim()) {
    const address: Record<string, string> = { '@type': 'PostalAddress' };
    if (snap.addressLine.trim()) address['streetAddress'] = snap.addressLine.trim();
    if (snap.suburb.trim()) address['addressLocality'] = snap.suburb.trim();
    if (snap.state.trim()) address['addressRegion'] = snap.state.trim();
    if (snap.postcode.trim()) address['postalCode'] = snap.postcode.trim();
    address['addressCountry'] = 'AU';
    fields['address'] = address;
  }
  if (snap.openingHours.length) fields['openingHoursSpecification'] = openingHoursSpecification(snap.openingHours);
  const sameAs = [
    handles.instagram && `https://www.instagram.com/${handles.instagram.replace(/^@/, '')}`,
    handles.tiktok && `https://www.tiktok.com/@${handles.tiktok.replace(/^@/, '')}`,
  ].filter(Boolean);
  if (sameAs.length) fields['sameAs'] = sameAs;
  return fields;
}

function openingHoursSpecification(hours: OpeningHours | SettingsSnapshot['openingHours']): Array<Record<string, unknown>> {
  const byTimes = new Map<string, string[]>();
  for (const r of hours) byTimes.set(`${r.opens}|${r.closes}`, [...(byTimes.get(`${r.opens}|${r.closes}`) ?? []), r.day]);
  return [...byTimes.entries()].map(([times, days]) => {
    const [opens, closes] = times.split('|');
    return {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: days.map((d) => OPENING_DAY_NAMES[d as keyof typeof OPENING_DAY_NAMES]),
      opens,
      closes,
    };
  });
}

/**
 * A complete `<script type="application/ld+json">` block for the business (type HairSalon), built only from
 * Settings. Never includes ratings, reviews, coordinates, price range or images.
 */
export function buildLocalBusinessJsonLd(
  snap: SettingsSnapshot,
  websiteRoot: string,
  handles: { instagram: string; tiktok: string } = {
    instagram: '',
    tiktok: '',
  },
): string {
  const body = {
    '@context': 'https://schema.org',
    ...localBusinessFields(snap, websiteRoot, handles),
  };
  return `<script type="application/ld+json">\n${JSON.stringify(body, null, 2)}\n</script>`;
}

/**
 * The owner's existing block with the business fields corrected from Settings (and `BarberShop` changed to
 * `HairSalon`); every other property is kept. Null when the block cannot be read.
 */
export function correctedBusinessJsonLd(raw: string, snap: SettingsSnapshot, websiteRoot: string, handles: { instagram: string; tiktok: string }): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const target = jsonLdObjects(parsed).find((o) => typesOf(o).some((t) => LOCAL_BUSINESS_TYPES.has(t) || UNRECOGNISED_BUSINESS_TYPES.has(t)));
  if (!target) return null;
  const fresh = localBusinessFields(snap, websiteRoot, handles);
  if (typesOf(target).some((t) => UNRECOGNISED_BUSINESS_TYPES.has(t))) target['@type'] = 'HairSalon';
  for (const key of ['name', 'telephone', 'address', 'openingHoursSpecification'] as const) {
    if (fresh[key] !== undefined) target[key] = fresh[key];
  }
  if (fresh['openingHoursSpecification'] !== undefined) delete target['openingHours'];
  return `<script type="application/ld+json">\n${JSON.stringify(parsed, null, 2)}\n</script>`;
}

// ---------------------------------------------------------------------------------------------
// Suggestions from settings (no AI)
// ---------------------------------------------------------------------------------------------

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const idx = cut.lastIndexOf(' ');
  return (idx > max / 2 ? cut.slice(0, idx) : s.slice(0, max)).replace(/[\s|,–-]+$/, '');
}

/** A page title from Settings (design §6.6), or null when it cannot be at least 10 characters. */
export function suggestTitle(page: Pick<PageSummary, 'h1' | 'title'>, isHome: boolean, snap: SettingsSnapshot): string | null {
  const name = realBusinessName(snap.businessName);
  if (!name) return null;
  let title: string;
  if (isHome) {
    const suburb = snap.suburb.trim();
    if (!suburb) title = `${name} | Barber`;
    else {
      title = `${name} | Barber in ${suburb}${snap.state.trim() ? `, ${snap.state.trim()}` : ''}`;
      if (title.length > 60) title = `${name} | ${suburb} Barber`;
      if (title.length > 60) title = `${name} | ${suburb}`;
    }
  } else {
    const base = (page.h1[0]?.trim() || (page.title ?? '').replace(new RegExp(`\\s*[|–-]\\s*${escapeRe(name)}\\s*$`, 'i'), '').trim()).replace(/\s+/g, ' ');
    if (!base || normaliseQueryText(base) === normaliseQueryText(name)) return null;
    title = `${cutAtWord(base, Math.max(10, 57 - name.length))} | ${name}`;
  }
  title = cutAtWord(title, 60);
  return title.length >= 10 ? title : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A search description for the home or contact page from Settings, or null when it would be under 50 characters. */
export function suggestMetaDescription(snap: SettingsSnapshot, tagline: string): string | null {
  const name = realBusinessName(snap.businessName);
  if (!name || !snap.suburb.trim()) return null;
  const parts = [`${name} is a barber studio in ${snap.suburb.trim()}${snap.state.trim() ? `, ${snap.state.trim()}` : ''}.`];
  if (tagline.trim()) parts.push(/[.!?]$/.test(tagline.trim()) ? tagline.trim() : `${tagline.trim()}.`);
  if (snap.bookingLink.trim()) parts.push('Book online.');
  const phone = normaliseAuPhone(snap.phone);
  if (phone) parts.push(`Call ${phone.national}.`);
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > 160) break;
    out = next;
  }
  return out.length >= 50 ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Prepared changes
// ---------------------------------------------------------------------------------------------

/** A change prepared by a rule, tied to the finding that produced it. */
export interface PreparedChange {
  findingKey: string;
  title: string;
  rationale: string;
  change: WebsiteChange;
}

/** Extra facts the worker has that the stored result doesn't keep. */
export interface PrepareExtras {
  /** The site's robots.txt text (≤ 5,000 characters used), null when it had none. */
  robotsText: string | null;
  tagline: string;
  instagramHandle: string;
  tiktokHandle: string;
}

/**
 * The changes rules can prepare from the findings and Settings (never generated from file names, never guessed):
 * titles, descriptions (home and contact), business details code, header lines, robots.txt lines and the wrong
 * phone number. Image descriptions are written by the owner, so none are prepared here.
 */
export function prepareChanges(facts: CrawlFacts, findings: Finding[], extras: PrepareExtras): PreparedChange[] {
  const out: PreparedChange[] = [];
  const snap = facts.settingsSnapshot;
  const pages = fetchedPages(facts);
  const home = homePage(facts);
  const byUrl = (u: string) => pages.find((p) => p.finalUrl === u || p.url === u);
  const contact = contactPage(pages);
  const push = (finding: Finding, change: WebsiteChange) => {
    out.push({
      findingKey: finding.key,
      title: changeTitle(change, facts.siteRoot),
      rationale: finding.why,
      change,
    });
  };
  const handles = {
    instagram: extras.instagramHandle,
    tiktok: extras.tiktokHandle,
  };
  for (const f of findings) {
    switch (f.checkId) {
      case 'title_missing':
      case 'title_length':
      case 'title_duplicate':
      case 'title_home_local':
        for (const url of f.pages) {
          const page = byUrl(url);
          if (!page) continue;
          const after = suggestTitle(page, page === home, snap);
          if (after && after !== page.title?.trim())
            push(f, {
              kind: 'page_title',
              pageUrl: page.finalUrl,
              before: page.title ? page.title.slice(0, 300) : null,
              after,
            });
        }
        break;
      case 'meta_description_missing':
      case 'meta_description_length':
      case 'meta_description_duplicate':
        for (const url of f.pages) {
          const page = byUrl(url);
          if (!page || (page !== home && page !== contact)) continue;
          const after = suggestMetaDescription(snap, extras.tagline);
          if (after && after !== page.metaDescription?.trim())
            push(f, {
              kind: 'meta_description',
              pageUrl: page.finalUrl,
              before: page.metaDescription ? page.metaDescription.slice(0, 500) : null,
              after,
            });
        }
        break;
      case 'localbusiness_missing':
        if (home)
          push(f, {
            kind: 'structured_data',
            pageUrl: home.finalUrl,
            before: null,
            after: buildLocalBusinessJsonLd(snap, facts.siteRoot, handles).slice(0, 5000),
          });
        break;
      case 'localbusiness_mismatch':
      case 'localbusiness_type_unrecognised': {
        if (!home) break;
        const block = findBusinessBlock(home);
        const corrected = block ? correctedBusinessJsonLd(block.raw, snap, facts.siteRoot, handles) : null;
        if (block && corrected && corrected.length <= 5000)
          push(f, {
            kind: 'structured_data',
            pageUrl: home.finalUrl,
            before: block.raw.slice(0, 5000),
            after: corrected,
          });
        break;
      }
      case 'canonical_missing':
        if (home)
          push(f, {
            kind: 'head_snippet',
            pageUrl: home.finalUrl,
            before: null,
            after: `<link rel="canonical" href="${home.finalUrl}">`,
          });
        break;
      case 'viewport_missing':
      case 'viewport_zoom_disabled':
        if (home && f.pages.some((u) => sameUrl(u, home.finalUrl))) {
          push(f, {
            kind: 'head_snippet',
            pageUrl: home.finalUrl,
            before: home.viewport ? `<meta name="viewport" content="${home.viewport.slice(0, 400)}">` : null,
            after: '<meta name="viewport" content="width=device-width, initial-scale=1">',
          });
        }
        break;
      case 'sitemap_not_in_robots': {
        const sitemap = facts.sitemap.sources[0];
        if (!sitemap) break;
        const before = extras.robotsText ? extras.robotsText.slice(0, 4800) : null;
        const after = `${before ? `${before.replace(/\s+$/, '')}\n\n` : ''}Sitemap: ${sitemap}`;
        push(f, {
          kind: 'robots_txt',
          pageUrl: new URL('/robots.txt', facts.siteRoot).toString(),
          before,
          after: after.slice(0, 5000),
        });
        break;
      }
      case 'robots_blocks_google': {
        if (!extras.robotsText) break;
        const paths = f.pages.map((u) => {
          try {
            const x = new URL(u);
            return `${x.pathname}${x.search}`;
          } catch {
            return '/';
          }
        });
        const after = robotsWithoutBlockingSafe(extras.robotsText.slice(0, 5000), paths);
        if (after !== null)
          push(f, {
            kind: 'robots_txt',
            pageUrl: new URL('/robots.txt', facts.siteRoot).toString(),
            before: extras.robotsText.slice(0, 5000),
            after,
          });
        break;
      }
      case 'nap_phone_mismatch': {
        const own = normaliseAuPhone(snap.phone);
        if (!own) break;
        for (const url of [...new Set(f.pages)].slice(0, 5)) {
          const page = byUrl(url);
          if (!page) continue;
          for (const raw of page.nap.phones) {
            const parsed = normaliseAuPhone(raw);
            if (!parsed || parsed.digits === own.digits) continue;
            const after = /^\s*\+/.test(raw) ? internationalAuPhone(own) : own.national;
            push(f, {
              kind: 'text_replace',
              pageUrl: page.finalUrl,
              before: raw,
              after,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function robotsWithoutBlockingSafe(robotsText: string, paths: string[]): string | null {
  const after = robotsWithoutBlocking(robotsText, 'Googlebot', paths);
  return after === robotsText ? null : after;
}

// ---------------------------------------------------------------------------------------------
// Prioritisation and summary (design §6.4)
// ---------------------------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
  info: 0,
};
const EFFORT_BONUS: Record<Effort, number> = {
  quick: 10,
  moderate: 5,
  developer: 0,
};

/** A finding's priority score: severity, then a bonus for quick fixes, then up to 5 for pages affected. */
export function findingScore(f: Pick<Finding, 'severity' | 'effort' | 'pages'>): number {
  return SEVERITY_WEIGHT[f.severity] + EFFORT_BONUS[f.effort] + Math.min(f.pages.length, 5);
}

/** Findings ordered by score, then category order, then check id. Deterministic; no overall score exists. */
export function prioritiseFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      findingScore(b) - findingScore(a) || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.checkId.localeCompare(b.checkId) || a.key.localeCompare(b.key),
  );
}

/** "Do these first": the first five prioritised findings that are at least "Worth doing". */
export function doTheseFirst(findings: Finding[]): Finding[] {
  return prioritiseFindings(findings)
    .filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
    .slice(0, 5);
}

/** Counts by severity plus page numbers and partial reasons, for the audit row. */
export function summariseAudit(result: Pick<CrawlFacts, 'pages'> & { findings: Finding[] }, partialReasons: string[]): AuditSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of result.findings) counts[f.severity]++;
  return {
    pagesChecked: fetchedPages(result).length,
    pagesSkipped: result.pages.filter((p) => p.skipped !== null).length,
    counts,
    partialReasons: partialReasons.slice(0, 10),
  };
}

/** Finding keys present in an earlier check but not in the latest one ("Fixed since last check"). */
export function fixedSince(previous: Finding[], latest: Finding[]): string[] {
  const now = new Set(latest.map((f) => f.key));
  return previous.filter((f) => !now.has(f.key)).map((f) => f.title);
}

/** Whether a URL is in the scope of the site root the check used (for owner-written changes). */
export function inSiteScope(url: string, siteRoot: string): boolean {
  const scope = siteScopeFrom(siteRoot);
  return scope ? isInScope(url, scope) : false;
}

/**
 * Postcodes and street numbers next to the suburb or street name that differ from Settings (for
 * `nap_address_mismatch`). For example "Ivanhoe VIC 3080" when Settings say 3079.
 */
export function findAddressConflicts(textValue: string, snap: Pick<SettingsSnapshot, 'addressLine' | 'suburb' | 'postcode'>): string[] {
  const out = new Set<string>();
  const suburb = snap.suburb.trim();
  if (suburb && /^\d{4}$/.test(snap.postcode.trim())) {
    const re = new RegExp(`\\b${escapeRe(suburb)}\\b[\\s,]*(?:VIC|Victoria)?[\\s,]*(\\d{4})\\b`, 'gi');
    for (const m of textValue.matchAll(re)) if (m[1] !== snap.postcode.trim()) out.add(m[0].replace(/\s+/g, ' ').trim().slice(0, 120));
  }
  const street = /^\s*(\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?)\s+(.+?)\s*$/i.exec(snap.addressLine);
  if (street?.[1] && street[2]) {
    const words = street[2]
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => escapeRe(w))
      .join('\\s+');
    const re = new RegExp(`\\b(\\d+[a-z]?(?:\\s*\\/\\s*\\d+[a-z]?)?)\\s+${words}\\b`, 'gi');
    for (const m of textValue.matchAll(re))
      if ((m[1] ?? '').replace(/\s/g, '').toLowerCase() !== street[1].replace(/\s/g, '').toLowerCase()) out.add(m[0].replace(/\s+/g, ' ').trim().slice(0, 120));
  }
  return [...out].slice(0, 5);
}
