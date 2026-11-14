import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { WebsiteChange } from '@studio/core';
import { WP_MESSAGES, WordPressAdapter } from '../src/website/adapters/wordpress.js';
import { applyChange, computeNextContent } from '../src/website/apply.js';
import { fakeWordPress } from './fakes/wordpress.js';

const logger = pino({ level: 'silent' });
const signal = new AbortController().signal;
const BASE = 'https://staging.ivanhoebarber.example.com.au';
const PUBLIC = 'https://ivanhoebarber.example.com.au/';
const contact = {
  id: 12,
  type: 'pages' as const,
  slug: 'contact',
  link: 'https://staging.ivanhoebarber.example.com.au/contact/',
  raw: '<p>Phone (03) 9876 5432.</p><img src="/wp-content/uploads/chair.jpg" alt="">',
};
const home = {
  id: 2,
  type: 'pages' as const,
  slug: 'home',
  link: 'https://staging.ivanhoebarber.example.com.au/',
  raw: '<p>Welcome to Ivanhoe.</p>',
};

function adapterFor(wp: ReturnType<typeof fakeWordPress>, password = 'abcd efgh ijkl mnop', base = BASE) {
  return new WordPressAdapter(
    { fetch: wp.fetch, logger },
    {
      baseUrl: base,
      username: 'studio-assistant',
      applicationPassword: password,
      publicWebsite: PUBLIC,
    },
  );
}
const replace = (before: string, after: string, page = 'https://ivanhoebarber.example.com.au/contact/'): WebsiteChange => ({ kind: 'text_replace', pageUrl: page, before, after });

describe('WordPress adapter (fake REST API)', () => {
  it('check is read-only, reports the user, rights and a staging site when the host differs', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const check = await adapterFor(wp).check(signal);
    expect(check).toMatchObject({
      ok: true,
      identity: 'studio-assistant',
      roles: ['editor'],
      environment: 'staging',
      supportedKinds: ['text_replace', 'image_alt_text'],
      problem: null,
    });
    expect(wp.calls.every((c) => c.method === 'GET')).toBe(true);
    const live = await adapterFor(
      fakeWordPress({
        base: 'https://www.ivanhoebarber.example.com.au',
        items: [],
      }),
      undefined,
      'https://www.ivanhoebarber.example.com.au',
    ).check(signal);
    expect(live.environment).toBe('live');
  });

  it('maps a refused password, missing rights, an administrator and a blocked REST API', async () => {
    expect(await adapterFor(fakeWordPress({ base: BASE, items: [] }), 'wrong').check(signal)).toMatchObject({
      ok: false,
      needsReauth: true,
      problem: WP_MESSAGES.auth,
    });
    expect(
      await adapterFor(
        fakeWordPress({
          base: BASE,
          items: [],
          roles: ['author'],
          capabilities: { edit_pages: false },
        }),
      ).check(signal),
    ).toMatchObject({ ok: false, problem: WP_MESSAGES.capability });
    expect(await adapterFor(fakeWordPress({ base: BASE, items: [], roles: ['administrator'] })).check(signal)).toMatchObject({ ok: true, note: WP_MESSAGES.adminNote });
    expect(await adapterFor(fakeWordPress({ base: BASE, items: [], restOff: true })).check(signal)).toMatchObject({ ok: false, problem: WP_MESSAGES.restUnreachable });
  });

  it('locates pages by slug and the root by its link', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact, home] });
    const a = adapterFor(wp);
    expect((await a.locate(replace('x', 'y'), signal))?.resourceId).toBe('12');
    expect((await a.locate(replace('x', 'y', PUBLIC), signal))?.resourceId).toBe('2');
    expect(await a.locate(replace('x', 'y', `${PUBLIC}nowhere/`), signal)).toBeNull();
  });

  it('applies a text replacement exactly once, then a retry reports already_applied without writing', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const a = adapterFor(wp);
    const change = replace('(03) 9876 5432', '03 9499 1234');
    const first = await applyChange(a, change, signal, async () => null);
    expect(first).toMatchObject({
      outcome: 'applied',
      verification: 'confirmed_api',
      wrote: true,
    });
    expect(wp.state.items[0]?.raw).toContain('Phone 03 9499 1234.');
    const second = await applyChange(a, change, signal, async () => '<p>Phone 03 9499 1234.</p>');
    expect(second).toMatchObject({
      outcome: 'already_applied',
      verification: 'confirmed_public',
      wrote: false,
    });
    expect(wp.state.writes).toHaveLength(1);
  });

  it('gives a conflict when the old text is missing or appears twice, and never writes', async () => {
    const wp = fakeWordPress({
      base: BASE,
      items: [{ ...contact, raw: '<p>A A</p>' }],
    });
    expect(await applyChange(adapterFor(wp), replace('B', 'C'), signal, async () => null)).toMatchObject({ outcome: 'conflict', wrote: false });
    expect(await applyChange(adapterFor(wp), replace('A', 'C'), signal, async () => null)).toMatchObject({ outcome: 'conflict', wrote: false });
    expect(wp.state.writes).toEqual([]);
  });

  it('maps 401, 403 and 404 on write, refuses unsupported kinds, and fails transient errors for a retry', async () => {
    const change = replace('(03) 9876 5432', '03 9499 1234');
    for (const [status, outcome] of [
      [401, 'auth'],
      [403, 'forbidden'],
      [404, 'not_found'],
    ] as const) {
      const wp = fakeWordPress({ base: BASE, items: [contact] });
      wp.state.failNextWrite = status;
      expect((await applyChange(adapterFor(wp), change, signal, async () => null)).outcome).toBe(outcome);
    }
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    wp.state.failNextWrite = 503;
    await expect(applyChange(adapterFor(wp), change, signal, async () => null)).rejects.toThrow(/didn't respond/);
    const title: WebsiteChange = {
      kind: 'page_title',
      pageUrl: PUBLIC,
      before: 'Home',
      after: 'Ivanhoe Barber Co | Barber in Ivanhoe',
    };
    expect(await applyChange(adapterFor(wp), title, signal, async () => null)).toMatchObject({
      outcome: 'unsupported',
      message: WP_MESSAGES.unsupported,
    });
    expect(await applyChange(adapterFor(fakeWordPress({ base: BASE, items: [contact] }), 'wrong'), change, signal, async () => null)).toMatchObject({ outcome: 'auth' });
  });

  it('sets image descriptions on the one matching image', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const change: WebsiteChange = {
      kind: 'image_alt_text',
      pageUrl: `${PUBLIC}contact/`,
      imageSrc: `${PUBLIC}wp-content/uploads/chair.jpg`,
      before: '',
      after: 'Barber chair by the window',
    };
    expect(await applyChange(adapterFor(wp), change, signal, async () => null)).toMatchObject({ outcome: 'applied' });
    expect(wp.state.items[0]?.raw).toContain('alt="Barber chair by the window"');
    expect(computeNextContent(change, wp.state.items[0]!.raw)).toEqual({
      kind: 'already_applied',
    });
    expect(computeNextContent(change, '<img src="/x.jpg">').kind).toBe('conflict');
  });
});
