/**
 * robots.txt parsing and matching after RFC 9309 (the IETF Robots Exclusion Protocol, 2022). Website design §6.2.
 * Not covered by the research memo; behaviour follows the RFC: group matching by product token (case-insensitive),
 * groups for the same agent merged, `*` and `$` in rules, longest match wins, `Allow` wins a tie, an empty
 * `Disallow` allows everything, `/robots.txt` is always allowed, at least 500 KiB parsed. `Crawl-delay` is a
 * non-standard extension that the website check honours anyway.
 */

/** The website check's own product token (also in its User-Agent header). */
export const AUDIT_PRODUCT_TOKEN = 'StudioAssistantAudit';
/** robots.txt bytes read at most (RFC 9309 asks for at least 500 KiB). */
export const ROBOTS_MAX_BYTES = 500 * 1024;

/** One `Allow`/`Disallow` line. */
export interface RobotsRule {
  allow: boolean;
  /** Normalised path pattern (may contain `*` and a trailing `$`). */
  pattern: string;
}

/** One group: the agents it names and its rules. */
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}

/** A parsed robots.txt. `mode` covers the fetch outcomes that replace parsing (4xx = allow all, 5xx = disallow all). */
export interface ParsedRobots {
  mode: 'rules' | 'allow_all' | 'disallow_all';
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** robots.txt answered 4xx: no restrictions (RFC 9309 §2.3.1.3). */
export const ROBOTS_ALLOW_ALL: ParsedRobots = {
  mode: 'allow_all',
  groups: [],
  sitemaps: [],
};
/** robots.txt unreachable or 5xx: everything disallowed (RFC 9309 §2.3.1.4). */
export const ROBOTS_DISALLOW_ALL: ParsedRobots = {
  mode: 'disallow_all',
  groups: [],
  sitemaps: [],
};

/** How a robots.txt fetch outcome is treated: parse the body, allow everything, or disallow everything. */
export function robotsOutcomeForStatus(status: number | null): 'parse' | 'allow_all' | 'disallow_all' {
  if (status === null) return 'disallow_all';
  if (status >= 200 && status < 300) return 'parse';
  if (status >= 400 && status < 500) return 'allow_all';
  return 'disallow_all';
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Normalises a path or pattern for comparison: percent-encoded unreserved characters are decoded, other escapes get
 * upper-case hex, and characters outside US-ASCII are percent-encoded as UTF-8.
 */
export function normaliseRobotsPath(path: string): string {
  let out = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i] ?? '';
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(path.slice(i + 1, i + 3))) {
      const decoded = String.fromCharCode(parseInt(path.slice(i + 1, i + 3), 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${path.slice(i + 1, i + 3).toUpperCase()}`;
      i += 2;
    } else if (ch.charCodeAt(0) > 0x7e || ch.charCodeAt(0) < 0x21) {
      out += encodeURIComponent(ch);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Parses robots.txt text (only the first 500 KiB). Unknown lines are ignored; nothing in it is ever executed. */
export function parseRobots(input: string): ParsedRobots {
  const textValue = input.length > ROBOTS_MAX_BYTES ? input.slice(0, ROBOTS_MAX_BYTES) : input;
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of textValue.split(/\r\n|\r|\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === 'sitemap') {
      if (value && sitemaps.length < 50) sitemaps.push(value);
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // an empty Disallow allows everything
      if (value === '') continue;
      current.rules.push({
        allow: key === 'allow',
        pattern: normaliseRobotsPath(value),
      });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = Math.min(n, 600);
    }
  }
  return { mode: 'rules', groups, sitemaps };
}

function agentMatches(agent: string, token: string): boolean {
  const t = token.toLowerCase();
  return agent === t || agent.startsWith(`${t}/`);
}

/** The rules that apply to a product token: every group naming it (merged), else every `*` group (merged). */
export function rulesFor(robots: ParsedRobots, token: string): { rules: RobotsRule[]; crawlDelaySec: number | null } {
  let matched = robots.groups.filter((g) => g.agents.some((a) => agentMatches(a, token)));
  if (matched.length === 0) matched = robots.groups.filter((g) => g.agents.includes('*'));
  const delays = matched.map((g) => g.crawlDelaySec).filter((d): d is number => d !== null);
  return {
    rules: matched.flatMap((g) => g.rules),
    crawlDelaySec: delays.length ? Math.max(...delays) : null,
  };
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    `^${body
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`,
  );
  return re.test(path);
}

/**
 * Whether `token` may fetch `pathAndQuery` (for example `/contact?x=1`). The longest matching rule wins; on equal
 * length `Allow` wins; no matching rule allows. `/robots.txt` is always allowed.
 */
export function isAllowed(robots: ParsedRobots, token: string, pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  if (robots.mode === 'allow_all') return true;
  if (robots.mode === 'disallow_all') return false;
  const path = normaliseRobotsPath(pathAndQuery || '/');
  let best: RobotsRule | null = null;
  for (const rule of rulesFor(robots, token).rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** The `Crawl-delay` (seconds) that applies to a token, or null. */
export function crawlDelayFor(robots: ParsedRobots, token: string): number | null {
  return robots.mode === 'rules' ? rulesFor(robots, token).crawlDelaySec : null;
}

/**
 * robots.txt text with the rules that block Googlebot from the given paths removed (for a prepared change; the
 * owner or their developer applies it). Lines are kept otherwise, comments included.
 */
export function robotsWithoutBlocking(input: string, token: string, paths: string[]): string {
  const robots = parseRobots(input);
  const named = robots.groups.some((g) => g.agents.some((a) => agentMatches(a, token)));
  const applies = (agents: string[]) => (named ? agents.some((a) => agentMatches(a, token)) : agents.includes('*'));
  const normalisedPaths = paths.map(normaliseRobotsPath);
  let agents: string[] = [];
  let lastWasAgent = false;
  const kept: string[] = [];
  for (const line of input.split(/\r\n|\r|\n/)) {
    const clean = (line.split('#')[0] ?? '').trim();
    const ua = /^user-agent\s*:\s*(.*)$/i.exec(clean);
    if (ua) {
      if (!lastWasAgent) agents = [];
      agents.push((ua[1] ?? '').trim().toLowerCase());
      lastWasAgent = true;
      kept.push(line);
      continue;
    }
    if (clean) lastWasAgent = false;
    const dis = /^disallow\s*:\s*(.+)$/i.exec(clean);
    if (dis && applies(agents)) {
      const pattern = normaliseRobotsPath((dis[1] ?? '').trim());
      if (normalisedPaths.some((p) => patternMatches(pattern, p))) continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}
