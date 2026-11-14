import { load } from 'cheerio';
import {
  containsPhrase,
  findAddressConflicts,
  findAuPhones,
  jsonLdObjects,
  normaliseQueryText,
  normaliseUrl,
  realBusinessName,
  sameUrl,
  type PageSummary,
  type PlatformHint,
  type SettingsSnapshot,
} from '@studio/core';

/**
 * Turns one fetched HTML page into capped facts (design §7.1 step 5). The page is parsed with cheerio as data: no
 * script runs, nothing on the page is followed except plain links, and every string is length-capped. The full
 * visible text is returned separately for NAP detection and change verification and is never stored.
 */

/** Everything extracted from one page. */
export interface ExtractedPage {
  facts: Pick<
    PageSummary,
    | 'title'
    | 'metaDescription'
    | 'h1'
    | 'headings'
    | 'canonical'
    | 'metaRobots'
    | 'lang'
    | 'viewport'
    | 'jsonLd'
    | 'microdataTypes'
    | 'nap'
    | 'bookingLinkFound'
    | 'headScripts'
    | 'wordCount'
  > & {
    images: Array<{
      src: string;
      alt: string | null;
      widthAttr: boolean;
      heightAttr: boolean;
    }>;
  };
  /** Absolute http(s) links with whether they sit in the navigation, header or footer. */
  links: Array<{ url: string; nav: boolean }>;
  /** Scripts and stylesheets loaded in `<head>` (absolute). */
  headAssets: string[];
  /** Visible text, whitespace collapsed (not stored). */
  text: string;
  platformHint: PlatformHint;
}

const cap = (s: string | null | undefined, n: number): string | null => {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
};

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data|sms|ftp):/i.test(h)) return null;
  return normaliseUrl(h, base);
}

const STREET_WORDS: Record<string, string> = {
  road: 'rd',
  street: 'st',
  avenue: 'ave',
  parade: 'pde',
  highway: 'hwy',
  drive: 'dr',
  lane: 'ln',
  place: 'pl',
  court: 'ct',
  crescent: 'cres',
  boulevard: 'blvd',
  terrace: 'tce',
};
/** Street text in a comparable form (`Upper Heidelberg Road` → `upper heidelberg rd`). */
export function normaliseStreet(value: string): string {
  return normaliseQueryText(value)
    .split(' ')
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

/** Recognises the site builder from public markers (generator tag, asset paths and hosts). A heuristic: "looks like". */
export function detectPlatform(html: string, generator: string | null): PlatformHint {
  const g = (generator ?? '').toLowerCase();
  if (g.includes('wordpress') || /\/wp-content\/|\/wp-json\/|\/wp-includes\//i.test(html)) return 'wordpress';
  if (g.includes('squarespace') || /static1\.squarespace\.com|squarespace-cdn\.com/i.test(html)) return 'squarespace';
  if (g.includes('wix') || /static\.wixstatic\.com|parastorage\.com/i.test(html)) return 'wix';
  if (g.includes('shopify') || /cdn\.shopify\.com/i.test(html)) return 'shopify';
  if (g.includes('webflow') || /website-files\.com|assets\.website-files\.com/i.test(html)) return 'webflow';
  return 'unknown';
}

/** Extracts the facts of one HTML page. `pageUrl` is the final address (after redirects). */
export function extractPage(html: string, pageUrl: string, snap: SettingsSnapshot): ExtractedPage {
  const $ = load(html);
  const head = $('head');
  const metaContent = (name: string) => $(`meta[name="${name}" i]`).first().attr('content') ?? null;

  const title = cap($('title').first().text(), 300);
  const headings: Array<{ level: number; text: string }> = [];
  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    if (headings.length >= 40) return false;
    const level = Number((el as { tagName?: string }).tagName?.slice(1) ?? 0);
    headings.push({ level, text: cap($(el).text(), 200) ?? '' });
    return undefined;
  });
  const h1 = headings
    .filter((h) => h.level === 1)
    .map((h) => h.text)
    .slice(0, 10);

  const jsonLd: PageSummary['jsonLd'] = [];
  $('script[type="application/ld+json" i]').each((_i, el) => {
    if (jsonLd.length >= 10) return false;
    const raw = $(el).text().trim();
    let valid = false;
    let types: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      valid = true;
      types = [
        ...new Set(
          jsonLdObjects(parsed).flatMap((o) => {
            const t = o['@type'];
            return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
          }),
        ),
      ]
        .map((t) => t.slice(0, 80))
        .slice(0, 10);
    } catch {
      valid = false;
    }
    jsonLd.push({ types, raw: raw.slice(0, 5000), valid });
    return undefined;
  });
  const microdataTypes = [
    ...new Set(
      $('[itemtype]')
        .map((_i, el) => ($(el).attr('itemtype') ?? '').trim())
        .get()
        .filter(Boolean),
    ),
  ]
    .map((t) => t.slice(0, 120))
    .slice(0, 10);

  const telLinks = [
    ...new Set(
      $('a[href^="tel:" i]')
        .map((_i, el) => decodeURIComponent(($(el).attr('href') ?? '').replace(/^tel:/i, '')).trim())
        .get()
        .filter(Boolean),
    ),
  ]
    .map((t) => t.slice(0, 40))
    .slice(0, 10);

  const links: Array<{ url: string; nav: boolean }> = [];
  const seenLinks = new Set<string>();
  let bookingLinkFound = false;
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (snap.bookingLink && href && (sameUrl(absolute(href, pageUrl) ?? '', snap.bookingLink) || (absolute(href, pageUrl) ?? '').startsWith(snap.bookingLink.replace(/\/$/, ''))))
      bookingLinkFound = true;
    const url = absolute(href, pageUrl);
    if (!url || seenLinks.has(url)) return;
    seenLinks.add(url);
    links.push({
      url,
      nav: $(el).closest('nav, header, footer, [role="navigation"]').length > 0,
    });
  });

  const images: ExtractedPage['facts']['images'] = [];
  const seenImages = new Set<string>();
  $('img').each((_i, el) => {
    if (images.length >= 60) return false;
    const node = $(el);
    const srcset = node.attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    const src = absolute(node.attr('src') ?? srcset ?? node.attr('data-src'), pageUrl);
    if (!src || seenImages.has(src)) return undefined;
    seenImages.add(src);
    const alt = node.attr('alt');
    images.push({
      src: src.slice(0, 500),
      alt: alt === undefined ? null : alt.slice(0, 300),
      widthAttr: node.attr('width') !== undefined,
      heightAttr: node.attr('height') !== undefined,
    });
    return undefined;
  });

  const headScriptEls = head.find('script[src]');
  let blocking = 0;
  headScriptEls.each((_i, el) => {
    const s = $(el);
    if (s.attr('async') === undefined && s.attr('defer') === undefined && (s.attr('type') ?? '').toLowerCase() !== 'module') blocking++;
  });
  const headAssets = [
    ...headScriptEls.map((_i, el) => absolute($(el).attr('src'), pageUrl)).get(),
    ...head
      .find('link[rel~="stylesheet" i][href]')
      .map((_i, el) => absolute($(el).attr('href'), pageUrl))
      .get(),
  ].filter((x): x is string => Boolean(x));

  const canonicalHref = $('link[rel~="canonical" i]').first().attr('href');
  const canonical = canonicalHref ? cap(absolute(canonicalHref, pageUrl) ?? canonicalHref, 500) : null;

  // Visible text: scripts, styles and templates removed (JSON-LD is in a script, so phone numbers there don't count).
  const body = $('body').clone(); // the HTML parser always creates a <body>
  body.find('script, style, noscript, template, svg, iframe').remove();
  // Block-level elements and links are separate words even when the HTML has no whitespace between them.
  body.find('br').replaceWith(' ');
  body
    .find('p, div, li, a, h1, h2, h3, h4, h5, h6, td, th, tr, section, article, header, footer, nav, main, aside, ul, ol, button, label, address, blockquote, figcaption, dt, dd')
    .each((_i, el) => {
      $(el).prepend(' ').append(' ');
    });
  const text = body.text().replace(/\s+/g, ' ').trim();
  const norm = normaliseQueryText(text);
  const name = realBusinessName(snap.businessName);
  const street = snap.addressLine.trim().replace(/^\s*\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?\s+/i, '');

  return {
    facts: {
      title,
      metaDescription: cap(metaContent('description'), 500),
      h1,
      headings,
      canonical,
      metaRobots: cap([metaContent('robots'), metaContent('googlebot')].filter(Boolean).join(', ') || null, 200),
      lang: cap($('html').attr('lang') ?? null, 20),
      viewport: cap(metaContent('viewport'), 200),
      jsonLd,
      microdataTypes,
      nap: {
        phones: findAuPhones(text),
        telLinks,
        nameFound: name ? containsPhrase(norm, normaliseQueryText(name)) : false,
        suburbFound: snap.suburb.trim() ? containsPhrase(norm, normaliseQueryText(snap.suburb)) : false,
        postcodeFound: /^\d{4}$/.test(snap.postcode.trim()) ? new RegExp(`\\b${snap.postcode.trim()}\\b`).test(text) : false,
        streetFound: street ? containsPhrase(normaliseStreet(text), normaliseStreet(street)) : false,
        addressConflicts: findAddressConflicts(text, snap),
      },
      bookingLinkFound,
      headScripts: { total: headScriptEls.length, blocking },
      wordCount: text ? text.split(/\s+/).length : 0,
      images,
    },
    links,
    headAssets: [...new Set(headAssets)].slice(0, 40),
    text,
    platformHint: detectPlatform(html, metaContent('generator')),
  };
}
