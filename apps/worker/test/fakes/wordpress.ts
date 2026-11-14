import { fakeFetch, json, type FakeCall } from '../helpers/fakes.js';

/** One page or post in the fake WordPress. */
export interface FakeWpItem {
  id: number;
  type: 'pages' | 'posts';
  slug: string;
  link: string;
  raw: string;
}

/**
 * An in-memory WordPress REST API (core routes only) answering through an injected `fetch`. It checks the Basic
 * credentials, serves `/wp-json/`, `users/me`, page/post lists by slug and single updates, and records every call.
 * No real WordPress or network is involved.
 */
export function fakeWordPress(options: {
  base: string;
  username?: string;
  password?: string;
  roles?: string[];
  capabilities?: Record<string, boolean>;
  items: FakeWpItem[];
  restOff?: boolean;
}) {
  const state = {
    items: options.items.map((i) => ({ ...i })),
    writes: [] as Array<{ id: number; content: string }>,
    /** Make the next write answer with this status (then reset). */
    failNextWrite: null as number | null,
    /** Throw (simulated crash) after the next write was stored. */
    crashAfterWrite: false,
  };
  const expected = `Basic ${Buffer.from(`${options.username ?? 'studio-assistant'}:${options.password ?? 'abcd efgh ijkl mnop'}`).toString('base64')}`;
  const base = options.base.replace(/\/+$/, '');
  const fetchImpl = fakeFetch(async (call: FakeCall) => {
    if (!call.url.startsWith(base)) throw new Error(`Unexpected request to ${call.url}`);
    const u = new URL(call.url);
    const path = u.pathname;
    if (options.restOff && path.startsWith('/wp-json'))
      return new Response('<html>Blocked</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    if (call.headers['authorization'] !== expected) return json(401, { code: 'rest_not_logged_in' });
    if (path === '/wp-json/') return json(200, { name: 'Studio', namespaces: ['oembed/1.0', 'wp/v2'] });
    if (path === '/wp-json/wp/v2/users/me') {
      return json(200, {
        id: 7,
        slug: options.username ?? 'studio-assistant',
        name: 'Studio Assistant',
        roles: options.roles ?? ['editor'],
        capabilities: options.capabilities ?? {
          edit_pages: true,
          edit_published_pages: true,
          edit_others_pages: true,
        },
      });
    }
    const list = /^\/wp-json\/wp\/v2\/(pages|posts)$/.exec(path);
    if (list && call.method === 'GET') {
      const slug = u.searchParams.get('slug');
      const items = state.items.filter((i) => i.type === list[1] && (slug === null || i.slug === slug));
      return json(
        200,
        items.map((i) => ({
          id: i.id,
          link: i.link,
          content: { raw: i.raw, rendered: i.raw },
          modified_gmt: '2026-11-01T00:00:00',
        })),
      );
    }
    const one = /^\/wp-json\/wp\/v2\/(pages|posts)\/(\d+)$/.exec(path);
    if (one) {
      const item = state.items.find((i) => i.type === one[1] && i.id === Number(one[2]));
      if (!item) return json(404, { code: 'rest_post_invalid_id' });
      if (call.method === 'GET') return json(200, { id: item.id, content: { raw: item.raw } });
      if (call.method === 'POST') {
        if (state.failNextWrite) {
          const status = state.failNextWrite;
          state.failNextWrite = null;
          return json(status, { code: 'fail' });
        }
        const body = JSON.parse(call.body) as { content: string };
        item.raw = body.content;
        state.writes.push({ id: item.id, content: body.content });
        if (state.crashAfterWrite) {
          state.crashAfterWrite = false;
          throw new Error('connection reset after the write');
        }
        return json(200, { id: item.id, content: { raw: item.raw } });
      }
    }
    return json(404, { code: 'rest_no_route' });
  });
  return { fetch: fetchImpl, state, calls: fetchImpl.calls };
}
