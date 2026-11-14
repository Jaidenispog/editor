import { randomBytes } from 'node:crypto';
import {
  AUDIT_PRODUCT_TOKEN,
  ROBOTS_ALLOW_ALL,
  ROBOTS_DISALLOW_ALL,
  ROBOTS_MAX_BYTES,
  crawlDelayFor,
  isAllowed,
  isInScope,
  isKeyPage,
  normaliseUrl,
  parseRobots,
  robotsOutcomeForStatus,
  sameUrl,
  type CrawlFacts,
  type PageSummary,
  type ParsedRobots,
  type PlatformHint,
  type SettingsSnapshot,
  type SiteScope,
} from '@studio/core';
import { extractPage, type ExtractedPage } from './extract.js';
import { MAX_POLITE_WAIT_MS, PoliteWaitBudgetError, RequestBudgetError, followRedirects, type FetchResult, type WebsiteFetcher } from './fetcher.js';
import { IMAGE_HEADER_BYTES, imageWidthFromHeader } from './image-size.js';
import { SITEMAP_MAX_BYTES, SITEMAP_MAX_URLS, parseSitemap, sitemapText } from './sitemap.js';

/**
 * One website check's crawl (design §7.1): robots.txt, host variants, the site root, sitemap discovery, up to 25 HTML
 * pages breadth-first (depth ≤ 3), image and asset sizes, link checks, and a soft-404 probe. Reads only the owner's
 * confirmed site (plus one HEAD per checked external link and the booking link). Nothing is ever written anywhere.
 */

export const MAX_PAGES = 25;
export const MAX_DEPTH = 3;
export const HTML_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_PAGE = 60;
export const MAX_IMAGES_TOTAL = 150;
export const MAX_EXTERNAL_LINKS = 25;
/** A check may spend at most this long waiting between requests because of `Crawl-delay` (enforced by the fetcher). */
export const MAX_POLITE_WAIT_SECONDS = MAX_POLITE_WAIT_MS / 1000;

const HOME_FORWARDS_TO_DISALLOWED_REASON = "Your home page forwards to an address your robots.txt asks automated tools not to read, so we didn't check your pages.";
const HOME_SLOW_CRAWL_REASON = "Your robots.txt asks for a very slow crawl (Crawl-delay), so we couldn't read your home page within the check's 12-minute limit.";
const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|mov|m4v|webm|avi|mp3|m4a|wav|ogg|zip|gz|tgz|rar|7z|docx?|xlsx?|pptx?|css|js|json|xml|txt)$/i;

/** What a crawl needs. */
export interface CrawlInput {
  scope: SiteScope;
  snapshot: SettingsSnapshot;
  checkExternalLinks: boolean;
  /** Strings to look for in each page's full text (open and pending changes), keyed by normalised page URL. */
  watchTexts: Map<string, string[]>;
  fetcher: WebsiteFetcher;
  signal: AbortSignal;
  progress: (fraction: number, message: string) => Promise<void>;
  checkCancelled: () => void;
  maxPages?: number;
}

/** What a crawl found, plus facts the stored result does not keep. */
export interface CrawlOutput {
  facts: CrawlFacts;
  /** robots.txt text (first 5,000 characters) when one was read, for prepared robots.txt changes. */
  robotsText: string | null;
  /** Watched strings found on each page (normalised page URL → strings). */
  textHits: Map<string, Set<string>>;
  partialReasons: string[];
  /** Our own product token (or `*`) is disallowed for the site root, or robots.txt answered with a server error, so nothing else was fetched. */
  blockedByRobots: boolean;
  /**
   * The home page was not read although the site answers: a very long Crawl-delay left no budget for it, or it
   * forwards to an address robots.txt asks us not to read. There are no findings then, only the partial reason.
   */
  homeNotRead: boolean;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
}

/** An entry for a page that was not (fully) read. */
export function emptyPage(url: string, over: Partial<PageSummary> = {}): PageSummary {
  return {
    url,
    finalUrl: url,
    status: null,
    error: null,
    skipped: null,
    redirectChain: [],
    ttfbMs: null,
    totalMs: null,
    htmlBytes: null,
    compressed: null,
    title: null,
    metaDescription: null,
    h1: [],
    headings: [],
    canonical: null,
    metaRobots: null,
    xRobotsTag: null,
    lang: null,
    viewport: null,
    jsonLd: [],
    microdataTypes: [],
    nap: {
      phones: [],
      telLinks: [],
      nameFound: false,
      suburbFound: false,
      postcodeFound: false,
      streetFound: false,
      addressConflicts: [],
    },
    bookingLinkFound: false,
    images: [],
    headScripts: { total: 0, blocking: 0 },
    estimatedWeightBytes: null,
    wordCount: 0,
    textSample: null,
    internalLinks: [],
    ...over,
  };
}

function isHtml(res: FetchResult): boolean {
  const type = (res.headers['content-type'] ?? '').toLowerCase();
  return type === '' || type.includes('text/html') || type.includes('application/xhtml');
}

function totalFromContentRange(value: string | undefined): number | null {
  const m = value ? /\/(\d+)\s*$/.exec(value) : null;
  return m?.[1] ? Number(m[1]) : null;
}

/** Runs one crawl. Throws CancelledError when the run is stopped; a request budget hit ends the crawl as partial. */
export async function crawlSite(input: CrawlInput): Promise<CrawlOutput> {
  const started = Date.now();
  const { scope, fetcher, signal } = input;
  let maxPages = input.maxPages ?? MAX_PAGES;
  const partialReasons: string[] = [];
  const origin = `${scope.scheme}://${scope.host}`;
  const rootUrl = scope.rootUrl;
  const inScope = (u: string) => isInScope(u, scope);
  const sameSite = (u: string) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h === scope.host || h === scope.twinHost;
    } catch {
      return false;
    }
  };
  let budgetHit = false;
  /** The polite-wait budget for the owner's site ran out: later owner-site requests are skipped, other hosts go on. */
  let politeBudgetHit = false;
  const guarded = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (budgetHit) return fallback;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RequestBudgetError) {
        budgetHit = true;
        return fallback;
      }
      if (err instanceof PoliteWaitBudgetError) {
        politeBudgetHit = true;
        return fallback;
      }
      throw err;
    }
  };

  // 1. robots.txt
  await input.progress(0.02, 'Reading robots.txt…');
  let robots: ParsedRobots = ROBOTS_ALLOW_ALL;
  let robotsText: string | null = null;
  let robotsStatus: CrawlFacts['robots']['status'] = 'missing';
  const robotsRes = await followRedirects(fetcher, `${origin}/robots.txt`, {
    method: 'GET',
    maxBytes: ROBOTS_MAX_BYTES,
    accept: 'text/plain,*/*;q=0.1',
    signal,
    allowHop: sameSite,
  });
  const outcome = robotsRes.final.error ? 'disallow_all' : robotsOutcomeForStatus(robotsRes.final.status);
  if (outcome === 'parse') {
    robotsText = (robotsRes.final.body ?? Buffer.alloc(0)).toString('utf8');
    robots = parseRobots(robotsText);
    robotsStatus = 'ok';
  } else if (outcome === 'allow_all') {
    robotsStatus = robotsRes.final.status !== null && robotsRes.final.status < 400 ? 'error' : 'missing';
  } else {
    robots = ROBOTS_DISALLOW_ALL;
    robotsStatus = 'unreachable';
  }
  let crawlDelay = crawlDelayFor(robots, AUDIT_PRODUCT_TOKEN);
  fetcher.setCrawlDelay(crawlDelay);
  /** robots.txt applies per host: the www./bare twin has its own (read below, before any page on it). */
  let twinRobots: ParsedRobots = ROBOTS_DISALLOW_ALL;
  /**
   * Why `twinRobots` is what it is: not read yet or skipped to keep the polite-wait budget for the home page
   * ('skipped_for_crawl_delay', read nothing there), no answer or a server error ('unreadable', read nothing there), or
   * read ('read'). Picks the right words when the home page forwards to the twin and can't be read.
   */
  let twinRobotsState: 'skipped_for_crawl_delay' | 'unreadable' | 'read' = 'skipped_for_crawl_delay';
  const robotsForUrl = (u: string): ParsedRobots => {
    try {
      return new URL(u).hostname.toLowerCase() === scope.twinHost && scope.twinHost !== scope.host ? twinRobots : robots;
    } catch {
      return robots;
    }
  };
  const allowedForUs = (u: string) => isAllowed(robotsForUrl(u), AUDIT_PRODUCT_TOKEN, pathOf(u));
  const allowedForGoogle = (u: string) => isAllowed(robotsForUrl(u), 'Googlebot', pathOf(u));
  /** In scope and allowed for us: what a page fetch, and every redirect hop of it, may go to. */
  const mayRead = (u: string) => inScope(u) && allowedForUs(u);
  const robotsSitemaps = robots.sitemaps.filter((s) => inScope(s)).slice(0, 10);
  const googlebotBlocksHome = robotsStatus === 'ok' && !allowedForGoogle(rootUrl);
  const robotsFacts: CrawlFacts['robots'] = {
    status: robotsStatus,
    sitemaps: robotsSitemaps,
    googlebotBlocksHome,
    blockedForUs: [],
    crawlDelaySec: crawlDelay,
    googlebotBlockedPages: googlebotBlocksHome ? [rootUrl] : [],
  };

  const baseFacts = (pages: PageSummary[], platformHint: PlatformHint): CrawlFacts => ({
    version: 1,
    siteRoot: rootUrl,
    settingsSnapshot: input.snapshot,
    platformHint,
    robots: robotsFacts,
    sitemap: {
      found: false,
      sources: [],
      urlCount: 0,
      invalid: false,
      sample: [],
      homeListed: null,
      badUrls: [],
    },
    hostVariants: [],
    soft404: null,
    pages,
    links: { checked: 0, broken: [], unverifiable: 0 },
    limits: {
      maxPages,
      hitPageLimit: false,
      requests: fetcher.requestCount,
      durationMs: Date.now() - started,
    },
  });

  if (robotsRes.final.status === null && robotsRes.final.error) {
    // No HTTP answer at all for robots.txt (the address does not resolve, the connection is refused or times out, or
    // the host is one the check never connects to): the site itself cannot be reached. A complete check with the one
    // `site_unreachable` finding (design §4.2), not a robots.txt problem.
    return {
      facts: baseFacts([emptyPage(rootUrl, { error: robotsRes.final.error })], 'unknown'),
      robotsText: null,
      textHits: new Map(),
      partialReasons,
      blockedByRobots: false,
      homeNotRead: false,
    };
  }
  if (robotsStatus === 'unreachable' || !allowedForUs(rootUrl)) {
    // Our token (or *) may not read the home page, or robots.txt is down (which means "read nothing"): stop here.
    if (robotsStatus !== 'unreachable') {
      partialReasons.push("Your robots.txt asks automated tools not to read your site, so we didn't check it.");
      return {
        facts: baseFacts([emptyPage(rootUrl, { skipped: 'robots' })], 'unknown'),
        robotsText: robotsText?.slice(0, 5000) ?? null,
        textHits: new Map(),
        partialReasons,
        blockedByRobots: true,
        homeNotRead: false,
      };
    }
    partialReasons.push("Your robots.txt answered with a server error, which asks search engines and tools not to read anything until it works, so we didn't check the pages.");
    return {
      facts: baseFacts([emptyPage(rootUrl, { skipped: 'robots' })], 'unknown'),
      robotsText: null,
      textHits: new Map(),
      partialReasons,
      blockedByRobots: true,
      homeNotRead: false,
    };
  }
  input.checkCancelled();

  // The polite-wait budget goes first to what the check cannot do without: the home page (one request kept back for
  // it), then the twin host's robots.txt, then the optional host-variant requests.
  const affordable = (requests: number) => fetcher.ownerRequestsLeft >= requests + 1;
  const slowCrawlSkipped: string[] = [];

  // 1b. The twin host's robots.txt (www. or bare), read before any page there is fetched.
  if (scope.twinHost !== scope.host) {
    const twinRes = affordable(1)
      ? await guarded(
          () =>
            followRedirects(fetcher, `${scope.scheme}://${scope.twinHost}/robots.txt`, {
              method: 'GET',
              maxBytes: ROBOTS_MAX_BYTES,
              accept: 'text/plain,*/*;q=0.1',
              signal,
              allowHop: sameSite,
            }),
          null,
        )
      : null;
    if (!twinRes) slowCrawlSkipped.push(`pages on ${scope.twinHost}`);
    else {
      const twinOutcome = twinRes.final.error ? 'disallow_all' : robotsOutcomeForStatus(twinRes.final.status);
      // Unreadable (no answer, 5xx): read nothing on that host, as for the main one.
      twinRobots = twinOutcome === 'parse' ? parseRobots((twinRes.final.body ?? Buffer.alloc(0)).toString('utf8')) : twinOutcome === 'allow_all' ? ROBOTS_ALLOW_ALL : ROBOTS_DISALLOW_ALL;
      twinRobotsState = twinOutcome === 'disallow_all' ? 'unreadable' : 'read';
      const twinDelay = crawlDelayFor(twinRobots, AUDIT_PRODUCT_TOKEN);
      if (twinDelay !== null && (crawlDelay === null || twinDelay > crawlDelay)) crawlDelay = twinDelay;
      fetcher.setCrawlDelay(crawlDelay);
    }
  }
  robotsFacts.crawlDelaySec = crawlDelay;
  if (crawlDelay && crawlDelay * (maxPages + 15) > MAX_POLITE_WAIT_SECONDS) {
    maxPages = Math.max(1, Math.floor(MAX_POLITE_WAIT_SECONDS / crawlDelay) - 15);
    partialReasons.push('Your robots.txt asks for a slow crawl, so we checked fewer pages.');
  }

  // 2. Host variants (redirects not followed; Location recorded). Skipped when they would use the home page's budget.
  await input.progress(0.05, 'Checking your web addresses…');
  const variants: CrawlFacts['hostVariants'] = [];
  for (const url of [
    `http://${scope.host}${scope.pathPrefix}`,
    `https://${scope.host}${scope.pathPrefix}`,
    `http://${scope.twinHost}${scope.pathPrefix}`,
    `https://${scope.twinHost}${scope.pathPrefix}`,
  ]) {
    if (!affordable(1)) {
      if (!slowCrawlSkipped.includes('your other web addresses (http and www)')) slowCrawlSkipped.push('your other web addresses (http and www)');
      continue;
    }
    const res = await guarded(async () => {
      let r = await fetcher.request(url, { method: 'HEAD', signal });
      if ((r.status === 405 || r.status === 501) && affordable(1))
        r = await fetcher.request(url, {
          method: 'GET',
          maxBytes: 1024,
          signal,
        });
      return r;
    }, null);
    variants.push({
      url,
      status: res?.status ?? null,
      redirectsTo: res?.location ? (normaliseUrl(res.location, url) ?? res.location).slice(0, 500) : null,
    });
  }
  if (slowCrawlSkipped.length)
    partialReasons.push(`Your robots.txt asks for a very slow crawl (Crawl-delay), so to finish within 12 minutes we didn't check ${slowCrawlSkipped.join(' or ')}.`);

  // 3. Site root, then sitemap discovery.
  await input.progress(0.08, 'Reading your home page…');
  const pages: PageSummary[] = [];
  const skippedPages: PageSummary[] = [];
  const textHits = new Map<string, Set<string>>();
  // Full visible text per page, kept only in memory for the text samples below.
  const pageText = new Map<PageSummary, string>();
  const referrers = new Map<string, Set<string>>();
  const imageInfo = new Map<string, { bytes: number | null; width: number | null }>();
  const queue: Array<{ url: string; depth: number }> = [];
  const queued = new Set<string>();
  const fetched = new Set<string>();
  let rootHeadAssets: string[] = [];
  let platformHint: PlatformHint = 'unknown';
  const enqueue = (url: string, depth: number, from: string | null) => {
    const n = normaliseUrl(url);
    if (!n) return;
    if (from) referrers.set(n, new Set([...(referrers.get(n) ?? []), from]));
    if (queued.has(n) || depth > MAX_DEPTH || !inScope(n)) return;
    queued.add(n);
    queue.push({ url: n, depth });
  };

  const sitemapUrls: string[] = [];
  const sitemapSources: string[] = [];
  let sitemapInvalid = false;
  let sitemapFound = false;
  const readSitemap = async (url: string): Promise<'ok' | 'missing' | 'invalid'> => {
    const res = await guarded(
      () =>
        followRedirects(fetcher, url, {
          method: 'GET',
          maxBytes: SITEMAP_MAX_BYTES,
          accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
          signal,
          allowHop: inScope,
        }),
      null,
    );
    if (!res || res.final.status === null || res.final.status >= 400 || !res.final.body) return 'missing';
    const xml = sitemapText(res.final.body);
    const parsed = xml === null ? ({ kind: 'invalid' } as const) : parseSitemap(xml);
    if (parsed.kind === 'invalid') return 'invalid';
    sitemapSources.push(url);
    if (parsed.kind === 'urlset') sitemapUrls.push(...parsed.urls);
    else {
      for (const child of parsed.sitemaps.filter(inScope).slice(0, 3)) {
        const r = await guarded(
          () =>
            followRedirects(fetcher, child, {
              method: 'GET',
              maxBytes: SITEMAP_MAX_BYTES,
              accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
              signal,
              allowHop: inScope,
            }),
          null,
        );
        const x = r?.final.body && r.final.status !== null && r.final.status < 400 ? sitemapText(r.final.body) : null;
        const p = x === null ? null : parseSitemap(x);
        if (p?.kind === 'urlset') sitemapUrls.push(...p.urls);
        else if (p?.kind === 'invalid') sitemapInvalid = true;
      }
    }
    return 'ok';
  };

  // 4. Pages, breadth-first.
  /** Page address → the address it forwards to that robots.txt keeps us out of (for the home page's reason). */
  const robotsBlockedTarget = new Map<string, string>();
  const fetchPage = async (url: string, depth: number) => {
    fetched.add(url);
    if (!allowedForUs(url)) {
      robotsFacts.blockedForUs.length < 50 && robotsFacts.blockedForUs.push(url.slice(0, 500));
      if (skippedPages.length < 15) skippedPages.push(emptyPage(url, { skipped: 'robots' }));
      return;
    }
    if (SKIP_EXTENSIONS.test(new URL(url).pathname)) return;
    const res = await followRedirects(fetcher, url, {
      method: 'GET',
      maxBytes: HTML_MAX_BYTES,
      signal,
      // Every hop: in scope, and allowed by that host's robots.txt (a page may forward to a disallowed one).
      allowHop: mayRead,
    });
    const f = res.final;
    const chain = res.chain.map((u) => u.slice(0, 500)).slice(0, 6);
    if (res.leftScope && inScope(res.leftScope)) {
      // Forwarded to an address robots.txt asks us not to read: that address is never requested.
      const target = normaliseUrl(res.leftScope) ?? res.leftScope;
      if (robotsFacts.blockedForUs.length < 50 && !robotsFacts.blockedForUs.includes(target.slice(0, 500))) robotsFacts.blockedForUs.push(target.slice(0, 500));
      if (skippedPages.length < 15) skippedPages.push(emptyPage(url, { skipped: 'robots', status: f.status, redirectChain: chain }));
      robotsBlockedTarget.set(url, target);
      return;
    }
    if (res.leftScope) {
      if (skippedPages.length < 15)
        skippedPages.push(
          emptyPage(url, {
            skipped: 'out_of_scope',
            status: f.status,
            redirectChain: chain,
            finalUrl: url,
          }),
        );
      return;
    }
    const finalUrl = normaliseUrl(f.url) ?? url;
    fetched.add(finalUrl);
    if (f.status === null || f.error) {
      pages.push(
        emptyPage(url, {
          finalUrl,
          error: (f.error ?? 'No answer').slice(0, 200),
          redirectChain: chain,
          ttfbMs: f.ttfbMs,
          totalMs: f.totalMs,
        }),
      );
      return;
    }
    if (f.status >= 400) {
      pages.push(
        emptyPage(url, {
          finalUrl,
          status: f.status,
          redirectChain: chain,
          ttfbMs: f.ttfbMs,
          totalMs: f.totalMs,
        }),
      );
      return;
    }
    if (!isHtml(f)) {
      if (skippedPages.length < 15)
        skippedPages.push(
          emptyPage(url, {
            finalUrl,
            status: f.status,
            skipped: 'non_html',
            redirectChain: chain,
          }),
        );
      return;
    }
    if (f.truncated) {
      if (skippedPages.length < 15)
        skippedPages.push(
          emptyPage(url, {
            finalUrl,
            status: f.status,
            skipped: 'too_large',
            redirectChain: chain,
          }),
        );
      return;
    }
    const html = (f.body ?? Buffer.alloc(0)).toString('utf8');
    const ex: ExtractedPage = extractPage(html, finalUrl, input.snapshot);
    if (platformHint === 'unknown') platformHint = ex.platformHint;
    const internalLinks = ex.links.filter((l) => inScope(l.url)).map((l) => l.url);
    const watch = input.watchTexts.get(finalUrl) ?? input.watchTexts.get(url) ?? [];
    if (watch.length) textHits.set(finalUrl, new Set(watch.filter((w) => w && ex.text.includes(w))));
    const isRootPage = pages.length === 0 && (sameUrl(finalUrl, rootUrl) || sameUrl(url, rootUrl));
    pages.push(
      emptyPage(url, {
        finalUrl,
        status: f.status,
        redirectChain: chain,
        ttfbMs: f.ttfbMs,
        totalMs: f.totalMs,
        htmlBytes: f.transferBytes,
        compressed: f.compressed,
        ...ex.facts,
        xRobotsTag: f.headers['x-robots-tag'] ? f.headers['x-robots-tag'].slice(0, 200) : null,
        images: ex.facts.images.slice(0, MAX_IMAGES_PER_PAGE).map((i) => ({ ...i, bytes: null, intrinsicWidth: null })),
        textSample: null,
        internalLinks: internalLinks.slice(0, 200),
        // Kept internally until assets are measured; replaced below.
        estimatedWeightBytes: f.transferBytes,
      }),
    );
    const added = pages[pages.length - 1];
    if (added) pageText.set(added, ex.text);
    if (isRootPage) rootHeadAssets = ex.headAssets;
    for (const l of ex.links) {
      if (!inScope(l.url)) {
        referrers.set(l.url, new Set([...(referrers.get(l.url) ?? []), finalUrl]));
        continue;
      }
      enqueue(l.url, isRootPage && l.nav ? 1 : depth + 1, finalUrl);
    }
  };

  /** Why a home page that forwards to an address we may not read wasn't checked, by why that host's rules say so. */
  const homeForwardReason = (target: string | undefined): string => {
    let onTwin = false;
    try {
      onTwin = target !== undefined && scope.twinHost !== scope.host && new URL(target).hostname.toLowerCase() === scope.twinHost;
    } catch {
      onTwin = false;
    }
    // Partial reasons are kept to 300 characters: the host is shortened if it is unusually long.
    const twin = scope.twinHost.length > 60 ? `${scope.twinHost.slice(0, 57)}...` : scope.twinHost;
    if (onTwin && twinRobotsState === 'skipped_for_crawl_delay')
      return `Your home page forwards to ${twin}. Your robots.txt asks for a very slow crawl (Crawl-delay), so we couldn't read the robots.txt there in time and didn't check your pages.`;
    if (onTwin && twinRobotsState === 'unreadable')
      return `Your home page forwards to ${twin}, whose robots.txt couldn't be read (no answer or a server error), so we didn't check your pages.`;
    return HOME_FORWARDS_TO_DISALLOWED_REASON;
  };

  try {
    // Guarded like every other owner-site request: a polite-wait budget that runs out here ends the check as partial.
    await guarded(() => fetchPage(normaliseUrl(rootUrl) ?? rootUrl, 0), undefined);
    queued.add(normaliseUrl(rootUrl) ?? rootUrl);
    const homeSkip = pages.length === 0 ? skippedPages.find((p) => p.skipped === 'robots') : undefined;
    if (pages.length === 0 && (politeBudgetHit || budgetHit || homeSkip)) {
      partialReasons.push(homeSkip ? homeForwardReason(robotsBlockedTarget.get(homeSkip.url)) : HOME_SLOW_CRAWL_REASON);
      const facts = baseFacts([homeSkip ?? emptyPage(rootUrl, { skipped: 'page_limit' })], 'unknown');
      facts.hostVariants = variants;
      return {
        facts,
        robotsText: robotsText?.slice(0, 5000) ?? null,
        textHits,
        partialReasons,
        blockedByRobots: false,
        homeNotRead: true,
      };
    }
    const home = pages[0];
    if (!home || home.status === null || home.status >= 500) {
      const facts = baseFacts(pages.length ? pages : [emptyPage(rootUrl, { error: 'No answer' })], 'unknown');
      facts.hostVariants = variants;
      return {
        facts,
        robotsText: robotsText?.slice(0, 5000) ?? null,
        textHits,
        partialReasons,
        blockedByRobots: false,
        homeNotRead: false,
      };
    }
    // Sitemap: robots.txt entries in scope, else /sitemap.xml, else /sitemap_index.xml.
    await input.progress(0.12, 'Reading your sitemap…');
    const candidates = robotsSitemaps.length ? robotsSitemaps.slice(0, 3) : [`${origin}${scope.pathPrefix}sitemap.xml`, `${origin}${scope.pathPrefix}sitemap_index.xml`];
    for (const c of candidates) {
      const r = await readSitemap(c);
      if (r === 'ok') {
        sitemapFound = true;
        if (!robotsSitemaps.length) break;
      } else if (r === 'invalid') {
        sitemapFound = true;
        sitemapInvalid = true;
        if (!sitemapSources.includes(c)) sitemapSources.push(c);
        if (!robotsSitemaps.length) break;
      }
    }
    // Queue order: root, its navigation links (already queued at depth 1), then sitemap addresses, then other links.
    queue.sort((a, b) => a.depth - b.depth);
    for (const u of sitemapUrls.slice(0, SITEMAP_MAX_URLS)) enqueue(u, 1, null);

    let hitPageLimit = false;
    while (queue.length) {
      input.checkCancelled();
      queue.sort((a, b) => a.depth - b.depth);
      const next = queue.shift();
      if (!next || fetched.has(next.url)) continue;
      if (pages.length >= maxPages) {
        hitPageLimit = true;
        break;
      }
      await input.progress(0.15 + 0.5 * (pages.length / maxPages), `Checking page ${pages.length + 1} of up to ${maxPages}…`);
      await guarded(() => fetchPage(next.url, next.depth), undefined);
      if (budgetHit || politeBudgetHit) break;
    }
    if (hitPageLimit) partialReasons.push(`We stopped at ${maxPages} pages.`);

    // Key pages Googlebot is asked not to read (for the indexing finding).
    if (robotsStatus === 'ok') {
      const keyUrls = [...queued].filter((u) => isKeyPage(u) && !allowedForGoogle(u));
      robotsFacts.googlebotBlockedPages = [...(googlebotBlocksHome ? [rootUrl] : []), ...keyUrls].slice(0, 10);
    }

    // 5. Images and the home page's scripts and stylesheets (sizes; width from the first 64 KB on the owner's site).
    await input.progress(0.68, 'Checking images…');
    const allImages = [...new Set(pages.flatMap((p) => p.images.map((i) => i.src)))].slice(0, MAX_IMAGES_TOTAL);
    for (const src of allImages) {
      input.checkCancelled();
      if (budgetHit) break;
      const res = await guarded(
        () =>
          sameSite(src)
            ? fetcher.request(src, {
                method: 'GET',
                maxBytes: IMAGE_HEADER_BYTES,
                range: `bytes=0-${IMAGE_HEADER_BYTES - 1}`,
                accept: 'image/*',
                signal,
              })
            : fetcher.request(src, {
                method: 'HEAD',
                accept: 'image/*',
                signal,
              }),
        null,
      );
      if (!res || res.status === null || res.status >= 400) {
        imageInfo.set(src, { bytes: null, width: null });
        continue;
      }
      const bytes = totalFromContentRange(res.headers['content-range']) ?? (res.status === 200 && res.headers['content-length'] ? Number(res.headers['content-length']) : null);
      imageInfo.set(src, {
        bytes: Number.isFinite(bytes) ? bytes : null,
        width: res.body ? imageWidthFromHeader(res.body) : null,
      });
    }
    let headAssetBytes = 0;
    for (const asset of rootHeadAssets.slice(0, 30)) {
      if (budgetHit) break;
      const res = await guarded(() => fetcher.request(asset, { method: 'HEAD', accept: '*/*', signal }), null);
      const len = res?.headers['content-length'] ? Number(res.headers['content-length']) : 0;
      if (Number.isFinite(len)) headAssetBytes += len;
    }
    for (const p of pages) {
      p.images = p.images.map((i) => ({
        ...i,
        bytes: imageInfo.get(i.src)?.bytes ?? null,
        intrinsicWidth: imageInfo.get(i.src)?.width ?? null,
      }));
      if (p.htmlBytes !== null) {
        const imgs = p.images.reduce((s, i) => s + (i.bytes ?? 0), 0);
        p.estimatedWeightBytes = p.htmlBytes + imgs + (p === pages[0] ? headAssetBytes : 0);
      }
    }

    // 6. Links: internal links not fetched, external links (≤ 25), the booking link, and sitemap samples.
    await input.progress(0.8, 'Checking links…');
    const broken: CrawlFacts['links']['broken'] = [];
    let checked = 0;
    let unverifiable = 0;
    const foundOn = (u: string) => [...(referrers.get(u) ?? [])].slice(0, 5).map((x) => x.slice(0, 500));
    for (const p of pages) {
      if (p.status !== null && p.status >= 400)
        broken.push({
          url: p.url.slice(0, 500),
          status: p.status,
          error: null,
          internal: true,
          foundOn: foundOn(p.url),
        });
      else if (p.error)
        broken.push({
          url: p.url.slice(0, 500),
          status: null,
          error: p.error,
          internal: true,
          foundOn: foundOn(p.url),
        });
    }
    const checkLink = async (url: string, internal: boolean): Promise<void> => {
      if (budgetHit) return;
      let res = await guarded(() => fetcher.request(url, { method: 'HEAD', accept: '*/*', signal }), null);
      if (res && (res.status === 405 || res.status === 501))
        res = await guarded(
          () =>
            fetcher.request(url, {
              method: 'GET',
              maxBytes: 1,
              range: 'bytes=0-0',
              accept: '*/*',
              signal,
            }),
          null,
        );
      if (!res) return;
      checked++;
      const s = res.status;
      if (s === 403 || s === 405 || s === 429 || res.blocked || (s === null && res.error?.includes("didn't answer"))) {
        unverifiable++;
        return;
      }
      if (s === null)
        broken.push({
          url: url.slice(0, 500),
          status: null,
          error: (res.error ?? 'No answer').slice(0, 200),
          internal,
          foundOn: foundOn(url),
        });
      else if (s === 404 || s === 410 || (internal && s >= 500))
        broken.push({
          url: url.slice(0, 500),
          status: s,
          error: null,
          internal,
          foundOn: foundOn(url),
        });
    };
    const internalToCheck = [...referrers.keys()].filter((u) => inScope(u) && !fetched.has(u) && !SKIP_EXTENSIONS.test(safePathname(u)) && allowedForUs(u)).slice(0, 100);
    for (const u of internalToCheck) {
      input.checkCancelled();
      await checkLink(u, true);
    }
    const booking = input.snapshot.bookingLink.trim() ? normaliseUrl(input.snapshot.bookingLink.trim()) : null;
    if (input.checkExternalLinks) {
      const external = [...referrers.keys()].filter((u) => !inScope(u) && !sameSite(u) && u !== booking).slice(0, MAX_EXTERNAL_LINKS);
      for (const u of external) {
        input.checkCancelled();
        await checkLink(u, false);
      }
    }
    if (booking) await checkLink(booking, false);
    if (unverifiable > 0) partialReasons.push(`${unverifiable} link${unverifiable === 1 ? '' : 's'} could not be checked (the other website refused automated checks).`);

    const sample = [...new Set(sitemapUrls)].slice(0, 25);
    const badUrls: CrawlFacts['sitemap']['badUrls'] = [];
    for (const u of sample) {
      if (budgetHit) break;
      if (!inScope(u)) {
        badUrls.push({
          url: u.slice(0, 500),
          reason: 'out_of_scope',
          status: null,
        });
        continue;
      }
      const page = pages.find((p) => p.url === normaliseUrl(u));
      if (page) {
        if (page.status === null || page.status >= 400)
          badUrls.push({
            url: u.slice(0, 500),
            reason: 'error',
            status: page.status,
          });
        else if (page.redirectChain.length)
          badUrls.push({
            url: u.slice(0, 500),
            reason: 'redirect',
            status: page.status,
          });
        else if (/\b(noindex|none)\b/i.test(`${page.metaRobots ?? ''} ${page.xRobotsTag ?? ''}`))
          badUrls.push({
            url: u.slice(0, 500),
            reason: 'noindex',
            status: page.status,
          });
        continue;
      }
      if (!allowedForUs(u)) continue;
      const res = await guarded(() => fetcher.request(u, { method: 'HEAD', signal }), null);
      if (!res) continue;
      if (res.status === null || res.status >= 400)
        badUrls.push({
          url: u.slice(0, 500),
          reason: 'error',
          status: res.status,
        });
      else if (res.status >= 300)
        badUrls.push({
          url: u.slice(0, 500),
          reason: 'redirect',
          status: res.status,
        });
    }

    // 7. Soft-404 probe (skipped when robots.txt disallows it).
    await input.progress(0.92, 'Putting the results together…');
    const probe = `${origin}${scope.pathPrefix}studio-assistant-check-${randomBytes(4).toString('hex')}`;
    let soft404: CrawlFacts['soft404'] = null;
    if (allowedForUs(probe) && !budgetHit) {
      const res = await guarded(
        () =>
          followRedirects(fetcher, probe, {
            method: 'GET',
            maxBytes: 256 * 1024,
            signal,
            allowHop: mayRead,
          }),
        null,
      );
      if (res) soft404 = { testedUrl: probe, status: res.final.status };
    }

    if (budgetHit) partialReasons.push('We stopped after 400 requests.');
    if (politeBudgetHit)
      partialReasons.push('Your robots.txt asks for a slow crawl (Crawl-delay), so to finish within 12 minutes we skipped some pages, images, files or link checks on your site.');
    const robotsSkipped = robotsFacts.blockedForUs.length;
    if (robotsSkipped)
      partialReasons.push(
        `${robotsSkipped} page${robotsSkipped === 1 ? ' was' : 's were'} not checked because your robots.txt asks automated tools not to read ${robotsSkipped === 1 ? 'it' : 'them'}.`,
      );

    // Text samples: the home page and up to five key pages only (used by the optional AI wording step).
    let keyCount = 0;
    for (const [i, p] of pages.entries()) {
      const text = pageText.get(p) ?? '';
      if (i === 0) p.textSample = text.slice(0, 1500) || null;
      else if (isKeyPage(p.finalUrl) && keyCount < 5) {
        p.textSample = text.slice(0, 1500) || null;
        keyCount++;
      }
    }
    const facts: CrawlFacts = {
      version: 1,
      siteRoot: rootUrl,
      settingsSnapshot: input.snapshot,
      platformHint,
      robots: robotsFacts,
      sitemap: {
        found: sitemapFound,
        sources: sitemapSources.slice(0, 5).map((s) => s.slice(0, 500)),
        urlCount: sitemapUrls.length,
        invalid: sitemapInvalid,
        sample: sample.map((s) => s.slice(0, 500)),
        homeListed: sitemapFound && !sitemapInvalid ? sitemapUrls.some((u) => sameUrl(u, rootUrl)) : null,
        badUrls: badUrls.slice(0, 25),
      },
      hostVariants: variants,
      soft404,
      pages: [...pages, ...skippedPages].slice(0, 40),
      links: { checked, broken: broken.slice(0, 100), unverifiable },
      limits: {
        maxPages,
        hitPageLimit,
        requests: fetcher.requestCount,
        durationMs: Date.now() - started,
      },
    };
    return {
      facts,
      robotsText: robotsText?.slice(0, 5000) ?? null,
      textHits,
      partialReasons,
      blockedByRobots: false,
      homeNotRead: false,
    };
  } catch (err) {
    if (err instanceof RequestBudgetError) throw new Error('The request budget was exceeded outside a guarded step');
    throw err;
  }
}

function safePathname(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}
