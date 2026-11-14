import { describe, expect, it } from 'vitest';
import {
  AUDIT_PRODUCT_TOKEN,
  ROBOTS_ALLOW_ALL,
  ROBOTS_DISALLOW_ALL,
  ROBOTS_MAX_BYTES,
  crawlDelayFor,
  isAllowed,
  normaliseRobotsPath,
  parseRobots,
  robotsOutcomeForStatus,
  robotsWithoutBlocking,
} from '../src/index.js';

describe('robots.txt (RFC 9309)', () => {
  it('selects the group by product token case-insensitively, else *, and merges groups for the same agent', () => {
    const r = parseRobots(
      ['User-agent: *', 'Disallow: /private/', '', 'User-agent: studioassistantaudit', 'Disallow: /a/', '', 'User-agent: StudioAssistantAudit', 'Disallow: /b/'].join('\n'),
    );
    expect(isAllowed(r, AUDIT_PRODUCT_TOKEN, '/a/x')).toBe(false);
    expect(isAllowed(r, AUDIT_PRODUCT_TOKEN, '/b/x')).toBe(false);
    expect(isAllowed(r, AUDIT_PRODUCT_TOKEN, '/private/x')).toBe(true); // its own group replaces *
    expect(isAllowed(r, 'Googlebot', '/private/x')).toBe(false);
    expect(isAllowed(r, 'Googlebot', '/a/x')).toBe(true);
  });

  it('applies consecutive user-agent lines to one group', () => {
    const r = parseRobots('User-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /x');
    expect(isAllowed(r, 'Googlebot', '/x')).toBe(false);
    expect(isAllowed(r, 'bingbot', '/x/y')).toBe(false);
    expect(isAllowed(r, 'Other', '/x')).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache');
    expect(isAllowed(r, 'x', '/files/menu.pdf')).toBe(false);
    expect(isAllowed(r, 'x', '/files/menu.pdf?v=2')).toBe(true);
    expect(isAllowed(r, 'x', '/tmp123/cache/a')).toBe(false);
  });

  it('lets the longest match win and Allow win a tie', () => {
    const r = parseRobots('User-agent: *\nDisallow: /shop\nAllow: /shop/gift-cards\nAllow: /same\nDisallow: /same');
    expect(isAllowed(r, 'x', '/shop/cart')).toBe(false);
    expect(isAllowed(r, 'x', '/shop/gift-cards/10')).toBe(true);
    expect(isAllowed(r, 'x', '/same/page')).toBe(true);
  });

  it('treats an empty Disallow as allow-all and always allows /robots.txt', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), 'x', '/anything')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), 'x', '/robots.txt')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), 'x', '/')).toBe(false);
  });

  it('maps fetch outcomes: 2xx parse, 4xx allow all, 5xx and no answer disallow all', () => {
    expect(robotsOutcomeForStatus(200)).toBe('parse');
    expect(robotsOutcomeForStatus(404)).toBe('allow_all');
    expect(robotsOutcomeForStatus(403)).toBe('allow_all');
    expect(robotsOutcomeForStatus(503)).toBe('disallow_all');
    expect(robotsOutcomeForStatus(null)).toBe('disallow_all');
    expect(isAllowed(ROBOTS_ALLOW_ALL, 'x', '/a')).toBe(true);
    expect(isAllowed(ROBOTS_DISALLOW_ALL, 'x', '/a')).toBe(false);
    expect(isAllowed(ROBOTS_DISALLOW_ALL, 'x', '/robots.txt')).toBe(true);
  });

  it('reads sitemaps, comments, crawl-delay and ignores unknown lines', () => {
    const r = parseRobots('# hello\nSitemap: https://e.com/sitemap.xml\nUser-agent: * # all\nCrawl-delay: 2\nNoindex: /x\nDisallow: /y # no');
    expect(r.sitemaps).toEqual(['https://e.com/sitemap.xml']);
    expect(crawlDelayFor(r, 'x')).toBe(2);
    expect(isAllowed(r, 'x', '/x')).toBe(true);
    expect(isAllowed(r, 'x', '/y')).toBe(false);
  });

  it('normalises percent-encoding before matching', () => {
    expect(normaliseRobotsPath('/%7euser/%2fx')).toBe('/~user/%2Fx');
    const r = parseRobots('User-agent: *\nDisallow: /caf%C3%A9');
    expect(isAllowed(r, 'x', '/café')).toBe(false);
  });

  it('parses only the first 500 KiB', () => {
    const big = `User-agent: *\n${'# filler\n'.repeat(ROBOTS_MAX_BYTES / 9 + 10)}Disallow: /late`;
    expect(isAllowed(parseRobots(big), 'x', '/late')).toBe(true);
  });

  it('removes only the rules that block the given paths for the token', () => {
    const text = 'User-agent: *\nDisallow: /contact\nDisallow: /tmp\n\nUser-agent: BadBot\nDisallow: /contact';
    expect(robotsWithoutBlocking(text, 'Googlebot', ['/contact'])).toBe('User-agent: *\nDisallow: /tmp\n\nUser-agent: BadBot\nDisallow: /contact');
  });
});
