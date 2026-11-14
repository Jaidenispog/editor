import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { WebsiteChange } from '@studio/core';
import { changeHash } from '@studio/core/website-approval';
import { WP_MESSAGES, WordPressAdapter } from '../src/website/adapters/wordpress.js';
import {
  CHANGED_SINCE_EARLIER_WRITE,
  CHANGED_WHILE_APPLYING,
  applyChange,
  changePresent,
  computeNextContent,
  contentHash,
  decodeAttr,
  type PriorWrite,
  type WriteRecord,
} from '../src/website/apply.js';
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

/** An in-memory stand-in for the row's durable "write sent" marker (website-edit-apply stores it on the edit). */
function memoryRecord(): WriteRecord & { saved: PriorWrite | null } {
  const r: WriteRecord & { saved: PriorWrite | null } = {
    saved: null,
    get prior() {
      return r.saved;
    },
    beforeWrite: async (target, preWriteHash, hash) => {
      r.saved = { resourceId: target.resourceId, preWriteHash, changeHash: hash };
      return true;
    },
  };
  return r;
}

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
    const record = memoryRecord();
    const first = await applyChange(a, change, signal, async () => null, record);
    expect(first).toMatchObject({
      outcome: 'applied',
      verification: 'confirmed_api',
      wrote: true,
    });
    expect(record.saved).toEqual({ resourceId: '12', preWriteHash: contentHash(contact.raw), changeHash: changeHash(change) });
    expect(wp.state.items[0]?.raw).toContain('Phone 03 9499 1234.');
    const second = await applyChange(a, change, signal, async () => '<p>Phone 03 9499 1234.</p>', record);
    expect(second).toMatchObject({
      outcome: 'already_applied',
      verification: 'confirmed_public',
      wrote: false,
      earlierWrite: true,
    });
    expect(wp.state.writes).toHaveLength(1);
  });

  it('a deletion whose write landed is recognised on the retry from the stored marker (never a false conflict)', async () => {
    const wp = fakeWordPress({ base: BASE, items: [{ ...contact, raw: '<p>Hello. Call us now!</p>' }] });
    const change = replace('Call us now!', '');
    const record = memoryRecord();
    // The write lands, then reading it back fails (a time-out after WordPress committed): the job retries.
    const a = adapterFor(wp);
    const readBack = a.readBack.bind(a);
    let failRead = true;
    a.readBack = async (t, sig) => {
      if (failRead) {
        failRead = false;
        throw new Error('timed out');
      }
      return readBack(t, sig);
    };
    await expect(applyChange(a, change, signal, async () => null, record)).rejects.toThrow(/timed out/);
    expect(wp.state.items[0]?.raw).toBe('<p>Hello. </p>');
    const retry = await applyChange(a, change, signal, async () => null, record);
    expect(retry).toMatchObject({ outcome: 'already_applied', wrote: false, earlierWrite: true });
    expect(wp.state.writes).toHaveLength(1);
    // Without the marker the same content is a conflict that says nothing was changed, which would be false here.
    expect(computeNextContent(change, '<p>Hello. </p>').kind).toBe('conflict');
  });

  it('never reports "already applied" on a first attempt just because the new text appears somewhere', async () => {
    const expansion = replace('Ivanhoe', 'Ivanhoe VIC 3079');
    const page = '<h1>Barber in Ivanhoe</h1><p>Find us at 12 Upper Heidelberg Rd, Ivanhoe VIC 3079</p>';
    // The old text appears twice (once inside the new text): a conflict, never a silent "Changed on your website".
    expect(computeNextContent(expansion, page)).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/more than once/) });
    const once = replace('Book online', 'Book online today');
    const elsewhere = '<p>Book online</p><p>Book online today for a fade.</p>';
    expect(computeNextContent(once, elsewhere).kind).toBe('conflict');
    expect(computeNextContent(once, '<p>Book online</p>')).toEqual({ kind: 'next', content: '<p>Book online today</p>' });
    const wp = fakeWordPress({ base: BASE, items: [{ ...contact, raw: page }] });
    expect(await applyChange(adapterFor(wp), expansion, signal, async () => null)).toMatchObject({ outcome: 'conflict', wrote: false });
    expect(wp.state.writes).toEqual([]);
  });

  it('with a marker: unchanged content means the earlier write never landed (written again); other changes are a conflict', async () => {
    const change = replace('(03) 9876 5432', '03 9499 1234');
    const prior = { preWriteHash: contentHash(contact.raw) };
    expect(computeNextContent(change, contact.raw, prior)).toEqual({ kind: 'next', content: contact.raw.replace('(03) 9876 5432', '03 9499 1234') });
    expect(computeNextContent(change, '<p>Phone 9999 0000.</p>', prior)).toEqual({ kind: 'conflict', message: CHANGED_SINCE_EARLIER_WRITE });
    expect(computeNextContent(change, '<p>Phone 03 9499 1234.</p>', prior)).toEqual({ kind: 'already_applied' });
  });

  it('a marker belongs to its change: re-wording after a landed write never reports the new wording as applied (N1)', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const a = adapterFor(wp);
    const record = memoryRecord();
    // X -> Y lands, then reading it back fails on the last attempt: the row keeps the marker for X -> Y.
    const readBack = a.readBack.bind(a);
    let failRead = true;
    a.readBack = async (t, sig) => {
      if (failRead) {
        failRead = false;
        throw new Error('timed out');
      }
      return readBack(t, sig);
    };
    const first = replace('(03) 9876 5432', '03 9499 1234');
    await expect(applyChange(a, first, signal, async () => null, record)).rejects.toThrow(/timed out/);
    expect(wp.state.items[0]?.raw).toContain('03 9499 1234');
    // The owner re-words it to a deletion of the old text. X is absent, so "the change shows" would be true, but the
    // marker was for another change: it is ignored and the first-attempt rule says the old text isn't there.
    const reworded = replace('(03) 9876 5432', '');
    const retry = await applyChange(a, reworded, signal, async () => null, record);
    expect(retry).toMatchObject({ outcome: 'conflict', wrote: false, earlierWrite: false });
    expect(wp.state.writes).toHaveLength(1);
    expect(wp.state.items[0]?.raw).toContain('03 9499 1234');
  });

  it('a refused write is flagged, and a page edited later never makes the change stuck (N1)', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const a = adapterFor(wp);
    const record = memoryRecord();
    const change = replace('(03) 9876 5432', '03 9499 1234');
    wp.state.failNextWrite = 403;
    const refused = await applyChange(a, change, signal, async () => null, record);
    expect(refused).toMatchObject({ outcome: 'forbidden', wrote: true, writeRefused: true });
    // The page is then edited in WordPress (another paragraph); the old text is still there once.
    wp.state.items[0]!.raw = `<p>Open Tuesday to Saturday.</p>${contact.raw}`;
    // Even if a marker of this same change survived, the edited page falls back to the first-attempt rule (old text
    // exactly once) instead of a permanent "changed since an earlier write" conflict.
    const stale: PriorWrite = { resourceId: '12', preWriteHash: contentHash(contact.raw), changeHash: changeHash(change) };
    expect(computeNextContent(change, wp.state.items[0]!.raw, stale)).toEqual({
      kind: 'next',
      content: wp.state.items[0]!.raw.replace('(03) 9876 5432', '03 9499 1234'),
    });
    const retry = await applyChange(a, change, signal, async () => null, { prior: stale, beforeWrite: record.beforeWrite });
    expect(retry).toMatchObject({ outcome: 'applied', wrote: true });
    expect(wp.state.items[0]?.raw).toBe('<p>Open Tuesday to Saturday.</p><p>Phone 03 9499 1234.</p><img src="/wp-content/uploads/chair.jpg" alt="">');
  });

  it('re-reads the page right before writing and writes nothing when it changed in WordPress meanwhile (WG1)', async () => {
    const change = replace('(03) 9876 5432', '03 9499 1234');
    // The owner edits the page in WordPress between locate and write.
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    wp.state.beforeSingleGet = (item) => {
      item.raw = `${item.raw}<p>New hours from December.</p>`;
      item.modified = '2026-11-14T02:59:00';
      wp.state.beforeSingleGet = null;
    };
    const record = memoryRecord();
    const edited = await applyChange(adapterFor(wp), change, signal, async () => null, record);
    expect(edited).toMatchObject({ outcome: 'conflict', message: CHANGED_WHILE_APPLYING, wrote: false });
    expect(wp.state.writes).toEqual([]);
    expect(record.saved).toBeNull();
    expect(wp.state.items[0]?.raw).toContain('New hours from December.');
    // A save that moved modified_gmt without changing the content is also treated as an edit (nothing written).
    const touched = fakeWordPress({ base: BASE, items: [contact] });
    touched.state.beforeSingleGet = (item) => {
      item.modified = '2026-11-14T03:00:00';
      touched.state.beforeSingleGet = null;
    };
    expect(await applyChange(adapterFor(touched), change, signal, async () => null)).toMatchObject({ outcome: 'conflict', message: CHANGED_WHILE_APPLYING });
    expect(touched.state.writes).toEqual([]);
    // Unchanged: the re-read passes and the change is written once.
    const calm = fakeWordPress({ base: BASE, items: [contact] });
    expect(await applyChange(adapterFor(calm), change, signal, async () => null)).toMatchObject({ outcome: 'applied' });
    expect(calm.calls.filter((c) => c.url.includes('_fields=id,content,modified_gmt'))).toHaveLength(1);
  });

  it('writes nothing when the marker cannot be stored (the change was taken back meanwhile)', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const refused: WriteRecord = { prior: null, beforeWrite: async () => false };
    expect(await applyChange(adapterFor(wp), replace('(03) 9876 5432', '03 9499 1234'), signal, async () => null, refused)).toMatchObject({ outcome: 'error', wrote: false });
    expect(wp.state.writes).toEqual([]);
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

  it('image descriptions with < > & and quotes are written escaped and read back as applied (W1)', async () => {
    const wp = fakeWordPress({ base: BASE, items: [contact] });
    const change: WebsiteChange = {
      kind: 'image_alt_text',
      pageUrl: `${PUBLIC}contact/`,
      imageSrc: `${PUBLIC}wp-content/uploads/chair.jpg`,
      before: '',
      after: `Skin fade <5 min> & "Ivanhoe's" chair`,
    };
    const attempt = await applyChange(adapterFor(wp), change, signal, async () => null);
    expect(attempt).toMatchObject({ outcome: 'applied', verification: 'confirmed_api' });
    expect(wp.state.items[0]?.raw).toContain(`alt="Skin fade &lt;5 min&gt; &amp; &quot;Ivanhoe's&quot; chair"`);
    // The same text already there (escaped, or with numeric references) is recognised, so nothing is written twice.
    expect(computeNextContent(change, wp.state.items[0]!.raw)).toEqual({ kind: 'already_applied' });
    expect(changePresent(change, '<img src="/wp-content/uploads/chair.jpg" alt="Skin fade &#60;5 min&#x3E; &amp; &#34;Ivanhoe&#39;s&#34; chair">')).toBe(true);
    // Decoded once only, and unknown references are left as they are.
    expect(decodeAttr('&amp;lt;')).toBe('&lt;');
    expect(decodeAttr('&lt;b&gt; &unknown; &#0;')).toBe('<b> &unknown; &#0;');
  });
});
