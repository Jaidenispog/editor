import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

/**
 * Sitemap parsing (design §7.1 step 3). Entity processing and DOCTYPE handling are off, gzip sitemaps are decompressed
 * with a size cap, and at most 500 addresses are kept.
 */

export const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
export const SITEMAP_MAX_URLS = 500;

/** A parsed sitemap: a list of pages, an index of child sitemaps, or not a sitemap. */
export type ParsedSitemap = { kind: 'urlset'; urls: string[] } | { kind: 'index'; sitemaps: string[] } | { kind: 'invalid' };

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'url' || name === 'sitemap',
});

/** Decompresses a gzip sitemap (by magic bytes) with a size cap; returns null when it is too large or broken. */
export function sitemapText(body: Buffer): string | null {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      return gunzipSync(body, { maxOutputLength: SITEMAP_MAX_BYTES }).toString('utf8');
    } catch {
      return null;
    }
  }
  return body.toString('utf8');
}

function locOf(entry: unknown): string | null {
  if (entry && typeof entry === 'object' && 'loc' in entry) {
    const loc = (entry as { loc: unknown }).loc;
    return typeof loc === 'string' && loc.trim() ? loc.trim() : null;
  }
  return null;
}

/** Parses sitemap XML. Anything with a DOCTYPE or without a `urlset`/`sitemapindex` root is invalid. */
export function parseSitemap(xml: string): ParsedSitemap {
  if (/<!DOCTYPE/i.test(xml.slice(0, 2048))) return { kind: 'invalid' };
  let doc: unknown;
  try {
    doc = parser.parse(xml, true);
  } catch {
    return { kind: 'invalid' };
  }
  if (!doc || typeof doc !== 'object') return { kind: 'invalid' };
  const root = doc as Record<string, unknown>;
  const urlset = root['urlset'];
  if (urlset !== undefined) {
    const list = urlset && typeof urlset === 'object' ? ((urlset as Record<string, unknown>)['url'] as unknown[] | undefined) : undefined;
    return {
      kind: 'urlset',
      urls: (list ?? [])
        .map(locOf)
        .filter((u): u is string => u !== null)
        .slice(0, SITEMAP_MAX_URLS),
    };
  }
  const index = root['sitemapindex'];
  if (index !== undefined) {
    const list = index && typeof index === 'object' ? ((index as Record<string, unknown>)['sitemap'] as unknown[] | undefined) : undefined;
    return {
      kind: 'index',
      sitemaps: (list ?? [])
        .map(locOf)
        .filter((u): u is string => u !== null)
        .slice(0, 50),
    };
  }
  return { kind: 'invalid' };
}
