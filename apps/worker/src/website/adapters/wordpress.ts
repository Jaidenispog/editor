import { ownershipHost, samePageOnSite, type ApplyOutcome, type WebsiteChange, type WebsiteChangeKind } from '@studio/core';
import type { WorkerContext } from '../../context.js';
import { httpRequest, readJson } from '../../lib/http.js';
import { TransientAdapterError, type AdapterCheck, type LocatedTarget, type WebsiteEditAdapter } from './types.js';

/**
 * Self-hosted WordPress through the core REST API (`/wp-json/wp/v2/…`) with an Application Password over HTTPS
 * (design §7.4.2; not covered by the research memo, so it sits behind this read-only check and a staging-first smoke
 * test). Page titles, search descriptions, structured data, header code and robots.txt live in themes or SEO plugins,
 * so only page text and image descriptions are written here; everything else stays copy-paste.
 */

export const WORDPRESS_SUPPORTED_KINDS: WebsiteChangeKind[] = ['text_replace', 'image_alt_text'];
const WP_TIMEOUT_MS = 20_000;

/** Messages for the owner (design §7.4.4). */
export const WP_MESSAGES = {
  restUnreachable: "The WordPress REST API isn't reachable at this address (a security plugin may block it).",
  auth: "WordPress didn't accept the username or Application Password. Some hosts block the login header; ask your host to allow it.",
  capability: "This WordPress user can't edit published pages. Give it the Editor role.",
  adminNote: 'This user is an Administrator. Use a separate Editor user for least access.',
  reconnect: 'WordPress refused the connection. Reconnect it in Settings → Integrations.',
  forbidden: "The WordPress user can't edit this page. Use a user with the Editor role.",
  unsupported: "WordPress can't change this through its standard connection; use the steps instead.",
  redirected: 'The WordPress REST API redirected to another address, so nothing was sent there. Check the WordPress address in Settings → Integrations.',
} as const;

/** Connection details (the password is decrypted only in the worker, just before use). */
export interface WordPressConfig {
  baseUrl: string;
  username: string;
  applicationPassword: string;
  /** The public website (Settings → Business), to label a different host as a staging site. */
  publicWebsite: string;
}

type WpItem = { id?: unknown; link?: unknown; content?: { raw?: unknown }; modified_gmt?: unknown };

export class WordPressAdapter implements WebsiteEditAdapter {
  readonly id = 'wordpress' as const;
  private readonly base: string;
  private readonly auth: string;

  constructor(
    private readonly ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
    private readonly config: WordPressConfig,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${config.username}:${config.applicationPassword}`).toString('base64')}`;
  }

  /** `live` when the WordPress host (without www.) is the public website's host, else `staging`. */
  environment(): 'live' | 'staging' {
    try {
      const pub = new URL(/^[a-z]+:\/\//i.test(this.config.publicWebsite) ? this.config.publicWebsite : `https://${this.config.publicWebsite}`);
      return ownershipHost(new URL(this.base).hostname) === ownershipHost(pub.hostname) ? 'live' : 'staging';
    } catch {
      return 'staging';
    }
  }

  private async call(path: string, init: RequestInit, signal: AbortSignal, label: string): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await httpRequest(
        this.ctx,
        `${this.base}${path}`,
        {
          ...init,
          // Never follow a redirect: a 307/308 would resend the page content (and the password) to another address.
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            authorization: this.auth,
            ...(init.headers as Record<string, string> | undefined),
          },
        },
        { label, signal, timeoutMs: WP_TIMEOUT_MS },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      throw new TransientAdapterError("Your website didn't respond. Nothing was changed.");
    }
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') throw new AdapterRedirectError();
    return { status: res.status, json: await readJson(res) };
  }

  async check(signal: AbortSignal): Promise<AdapterCheck> {
    const out: AdapterCheck = {
      ok: false,
      identity: null,
      roles: [],
      capabilities: {},
      environment: this.environment(),
      supportedKinds: [],
      problem: null,
      needsReauth: false,
      note: null,
    };
    let index: { status: number; json: unknown };
    try {
      index = await this.call('/wp-json/', { method: 'GET' }, signal, 'wordpress.discovery');
    } catch (err) {
      if (err instanceof AdapterRedirectError) return { ...out, problem: WP_MESSAGES.redirected };
      throw err;
    }
    const namespaces = (index.json as { namespaces?: unknown } | null)?.namespaces;
    if (index.status === 401) return { ...out, problem: WP_MESSAGES.auth, needsReauth: true };
    if (index.status >= 400 || !Array.isArray(namespaces) || !namespaces.includes('wp/v2')) return { ...out, problem: WP_MESSAGES.restUnreachable };
    let me: { status: number; json: unknown };
    try {
      me = await this.call('/wp-json/wp/v2/users/me?context=edit', { method: 'GET' }, signal, 'wordpress.users_me');
    } catch (err) {
      if (err instanceof AdapterRedirectError) return { ...out, problem: WP_MESSAGES.redirected };
      throw err;
    }
    if (me.status === 401) return { ...out, problem: WP_MESSAGES.auth, needsReauth: true };
    if (me.status === 403) return { ...out, problem: WP_MESSAGES.capability };
    if (me.status >= 400 || !me.json || typeof me.json !== 'object') return { ...out, problem: WP_MESSAGES.restUnreachable };
    const user = me.json as {
      slug?: unknown;
      name?: unknown;
      roles?: unknown;
      capabilities?: unknown;
    };
    const roles = Array.isArray(user.roles) ? user.roles.filter((r): r is string => typeof r === 'string') : [];
    const caps: Record<string, boolean> = {};
    if (user.capabilities && typeof user.capabilities === 'object') {
      for (const key of ['edit_pages', 'edit_published_pages', 'edit_others_pages', 'edit_posts', 'edit_published_posts'])
        caps[key] = (user.capabilities as Record<string, unknown>)[key] === true;
    }
    const identity = typeof user.slug === 'string' ? user.slug : typeof user.name === 'string' ? user.name : null;
    if (!caps['edit_pages'] || !caps['edit_published_pages'])
      return {
        ...out,
        identity,
        roles,
        capabilities: caps,
        problem: WP_MESSAGES.capability,
      };
    return {
      ...out,
      ok: true,
      identity,
      roles,
      capabilities: caps,
      supportedKinds: WORDPRESS_SUPPORTED_KINDS,
      note: roles.includes('administrator') ? WP_MESSAGES.adminNote : null,
    };
  }

  supports(change: WebsiteChange): { ok: true } | { ok: false; reason: string } {
    return WORDPRESS_SUPPORTED_KINDS.includes(change.kind) ? { ok: true } : { ok: false, reason: WP_MESSAGES.unsupported };
  }

  private async list(type: 'pages' | 'posts', query: string, signal: AbortSignal): Promise<WpItem[]> {
    const res = await this.call(`/wp-json/wp/v2/${type}?${query}&context=edit&_fields=id,link,content,modified_gmt`, { method: 'GET' }, signal, `wordpress.${type}`);
    if (res.status === 401) throw new AdapterAuthError();
    if (res.status === 403) throw new AdapterForbiddenError();
    if (res.status >= 500) throw new TransientAdapterError("Your website didn't respond. Nothing was changed.");
    return Array.isArray(res.json) ? (res.json as WpItem[]) : [];
  }

  /**
   * A WordPress `link` names the change's page: the same page on the public site, or, for a staging site, the page at
   * the same path on the WordPress host (a staging copy mirrors the public site's paths).
   */
  linkMatches(link: string, pageUrl: string): boolean {
    if (samePageOnSite(link, pageUrl)) return true;
    if (this.environment() !== 'staging') return false;
    try {
      const l = new URL(link);
      const p = new URL(pageUrl);
      const path = (u: URL) => u.pathname.replace(/\/$/, '') || '/';
      return ownershipHost(l.hostname) === ownershipHost(new URL(this.base).hostname) && path(l) === path(p) && l.search === p.search;
    } catch {
      return false;
    }
  }

  async locate(change: WebsiteChange, signal: AbortSignal): Promise<LocatedTarget | null> {
    let path = '/';
    try {
      path = new URL(change.pageUrl).pathname;
    } catch {
      return null;
    }
    const slug = path.split('/').filter(Boolean).pop() ?? '';
    for (const type of ['pages', 'posts'] as const) {
      const items = slug ? await this.list(type, `slug=${encodeURIComponent(slug)}`, signal) : await this.list(type, 'per_page=100', signal);
      const match = items.find((i) => typeof i.link === 'string' && this.linkMatches(i.link, change.pageUrl));
      if (match && (typeof match.id === 'number' || typeof match.id === 'string') && typeof match.content?.raw === 'string') {
        return {
          resourceType: type === 'pages' ? 'page' : 'post',
          resourceId: String(match.id),
          link: String(match.link),
          current: match.content.raw,
          modifiedGmt: typeof match.modified_gmt === 'string' ? match.modified_gmt : null,
        };
      }
    }
    return null;
  }

  async write(target: LocatedTarget, nextContent: string, signal: AbortSignal): Promise<{ outcome: ApplyOutcome; message: string }> {
    const type = target.resourceType === 'page' ? 'pages' : 'posts';
    const res = await this.call(
      `/wp-json/wp/v2/${type}/${encodeURIComponent(target.resourceId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      },
      signal,
      'wordpress.update',
    );
    if (res.status >= 200 && res.status < 300) return { outcome: 'applied', message: 'Changed through WordPress.' };
    if (res.status === 401) return { outcome: 'auth', message: WP_MESSAGES.reconnect };
    if (res.status === 403) return { outcome: 'forbidden', message: WP_MESSAGES.forbidden };
    if (res.status === 404)
      return {
        outcome: 'not_found',
        message: "We couldn't find this page in WordPress any more.",
      };
    throw new TransientAdapterError("Your website didn't respond. Nothing was changed.");
  }

  async readBack(target: LocatedTarget, signal: AbortSignal): Promise<string> {
    const type = target.resourceType === 'page' ? 'pages' : 'posts';
    const res = await this.call(
      `/wp-json/wp/v2/${type}/${encodeURIComponent(target.resourceId)}?context=edit&_fields=id,content`,
      { method: 'GET' },
      signal,
      'wordpress.read_back',
    );
    if (res.status === 401) throw new AdapterAuthError();
    if (res.status >= 400) throw new TransientAdapterError("Your website didn't respond while we were checking the change.");
    const raw = (res.json as WpItem | null)?.content?.raw;
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * Re-reads the located item right before a write (WordPress core has no conditional update): the same single-item
   * GET as the read-back, with `modified_gmt` (one of the fields locate asks for, design §7.4.2).
   */
  async recheck(target: LocatedTarget, signal: AbortSignal): Promise<{ current: string; modifiedGmt: string | null } | null> {
    const type = target.resourceType === 'page' ? 'pages' : 'posts';
    const res = await this.call(
      `/wp-json/wp/v2/${type}/${encodeURIComponent(target.resourceId)}?context=edit&_fields=id,content,modified_gmt`,
      { method: 'GET' },
      signal,
      'wordpress.recheck',
    );
    if (res.status === 401) throw new AdapterAuthError();
    if (res.status === 403) throw new AdapterForbiddenError();
    if (res.status === 404 || res.status === 410) return null;
    if (res.status >= 400) throw new TransientAdapterError("Your website didn't respond. Nothing was changed.");
    const item = res.json as WpItem | null;
    const raw = item?.content?.raw;
    if (typeof raw !== 'string') return null;
    return { current: raw, modifiedGmt: typeof item?.modified_gmt === 'string' ? item.modified_gmt : null };
  }
}

/** WordPress refused the credentials (401) while locating a page. */
export class AdapterAuthError extends Error {
  constructor() {
    super(WP_MESSAGES.reconnect);
    this.name = 'AdapterAuthError';
  }
}
/** WordPress refused access to the page (403) while locating it. */
export class AdapterForbiddenError extends Error {
  constructor() {
    super(WP_MESSAGES.forbidden);
    this.name = 'AdapterForbiddenError';
  }
}
/** The REST API answered with a redirect (never followed): the address is wrong or something is steering requests. */
export class AdapterRedirectError extends Error {
  constructor() {
    super(WP_MESSAGES.redirected);
    this.name = 'AdapterRedirectError';
  }
}
