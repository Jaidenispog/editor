import { createHash } from 'node:crypto';
import type { ApplyOutcome, Verification, WebsiteChange } from '@studio/core';
import { changeHash } from '@studio/core/website-approval';
import { AdapterAuthError, AdapterForbiddenError, AdapterRedirectError, WP_MESSAGES } from './adapters/wordpress.js';
import type { LocatedTarget, WebsiteEditAdapter } from './adapters/types.js';

/**
 * Adapter-independent apply (design §7.4.1): supports → locate → compute the new content (the old text must occur
 * exactly once) → record that a write is being sent → write → read back.
 *
 * Exactly once: whether an earlier attempt already wrote is decided from a durable record ({@link PriorWrite}: stored
 * on the row right before the write, with a hash of the content the write was computed from), never from the page text
 * alone. Without that record the old text must be there exactly once; the new text being on the page already is never
 * taken as proof (it may appear elsewhere, or be a longer text containing the old one). With the record, unchanged
 * content means the earlier write did not land (it is computed again); changed content that shows the change means it
 * did (`already_applied`, nothing is written twice), which also covers deletions; changed content that does not show
 * it falls back to the first-attempt rule (so a page edited later never leaves the change stuck in a conflict).
 *
 * A record only counts for the change it was written for (its `changeHash`) on the same WordPress item: a re-worded,
 * refreshed or different change never inherits it. Right before the write the item is read again, and nothing is
 * written when it changed in WordPress since it was located (WordPress core has no conditional update).
 */

/** The record an earlier attempt left right before it sent its write. */
export interface PriorWrite {
  resourceId: string;
  /** SHA-256 (hex) of the content the earlier write was computed from. */
  preWriteHash: string;
  /** SHA-256 (hex) of the change that write was for ({@link changeHash}); a record for another change is ignored. */
  changeHash: string;
}

/** SHA-256 (hex) of a page's stored content. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** What applying one change produced. */
export interface ApplyAttempt {
  outcome: ApplyOutcome;
  message: string;
  target: Pick<LocatedTarget, 'resourceType' | 'resourceId' | 'link'> | null;
  verification: Verification | null;
  /** Whether a write request was sent in this attempt. */
  wrote: boolean;
  /** `already_applied` because an earlier attempt's recorded write is on the page (false: it was already there). */
  earlierWrite: boolean;
  /** A write was sent and WordPress definitely refused it (401, 403, 404): nothing landed, so the record can go. */
  writeRefused: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NAMED_ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
/** Decodes what {@link escapeAttr} encodes, plus `&apos;` and numeric references, in one pass (never twice). */
export function decodeAttr(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|quot|apos|amp|lt|gt);/gi, (whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower[0] !== '#') return NAMED_ENTITIES[lower] ?? whole;
    const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** `<img>` tags whose `src` is the change's image (absolute, or the same path). */
function imageTags(content: string, imageSrc: string): RegExpMatchArray[] {
  let path = imageSrc;
  try {
    path = new URL(imageSrc).pathname;
  } catch {
    // keep as given
  }
  const re = new RegExp(`<img\\b[^>]*\\bsrc\\s*=\\s*["'](?:${escapeRe(imageSrc)}|(?:https?:)?(?://[^"'/]+)?${escapeRe(path)})["'][^>]*>`, 'gi');
  return [...content.matchAll(re)];
}

function altOf(tag: string): string | null {
  const m = /\balt\s*=\s*(["'])(.*?)\1/i.exec(tag);
  return m ? (m[2] ?? '') : null;
}

/** Shown when the page changed after an earlier attempt sent its write, doesn't show the change and lost the old text. */
export const CHANGED_SINCE_EARLIER_WRITE =
  "The page in WordPress changed after an earlier attempt sent this change, and it doesn't show the change. Check the page in WordPress before trying again.";

/** Shown when the page changed in WordPress between finding it and writing to it (nothing is written then). */
export const CHANGED_WHILE_APPLYING =
  'The page was changed in WordPress while we were applying this, so nothing was changed. Check the page, then apply again.';

/**
 * The page content after the change, or the reason it can't be made: `already_applied` (only with a {@link PriorWrite}
 * record whose write is on the page) or `conflict` (old text missing or more than once). Pure.
 */
export function computeNextContent(
  change: WebsiteChange,
  current: string,
  prior: Pick<PriorWrite, 'preWriteHash'> | null = null,
): { kind: 'next'; content: string } | { kind: 'already_applied' } | { kind: 'conflict'; message: string } {
  if (prior && contentHash(current) !== prior.preWriteHash) {
    // The content moved on since the earlier attempt sent its write: it landed if the change shows.
    if (changePresent(change, current)) return { kind: 'already_applied' };
    // It doesn't show (the write never landed and the page was edited, or it was edited again since): the same rule as
    // a first attempt, so the old text must be there exactly once.
    if (change.kind === 'text_replace' && countOccurrences(current, change.before) === 0) return { kind: 'conflict', message: CHANGED_SINCE_EARLIER_WRITE };
  }
  return firstAttempt(change, current);
}

/** No earlier write, or it never landed: the old text (or the image) must be there exactly once. */
function firstAttempt(change: WebsiteChange, current: string): { kind: 'next'; content: string } | { kind: 'already_applied' } | { kind: 'conflict'; message: string } {
  if (change.kind === 'text_replace') {
    const count = countOccurrences(current, change.before);
    if (count === 0)
      return {
        kind: 'conflict',
        message:
          "The text we were going to replace isn't in the page's content in WordPress, so nothing was changed. It may have changed since the check, or be part of your theme (for example the footer). Run a new check, or use the steps instead.",
      };
    if (count > 1)
      return {
        kind: 'conflict',
        message: 'The text we were going to replace appears more than once on the page, so nothing was changed. Use the steps instead.',
      };
    return {
      kind: 'next',
      content: current.replace(change.before, () => change.after),
    };
  }
  if (change.kind === 'image_alt_text') {
    const tags = imageTags(current, change.imageSrc);
    if (tags.length !== 1)
      return {
        kind: 'conflict',
        message:
          tags.length === 0
            ? "We couldn't find this image in the page's content in WordPress, so nothing was changed. It may be part of your theme; use the steps instead."
            : 'This image appears more than once on the page, so nothing was changed. Use the steps instead.',
      };
    const tag = tags[0]?.[0] ?? '';
    // The one matching image already has exactly this description: nothing to write (reported as such).
    if (decodeAttr(altOf(tag) ?? '').trim() === change.after.trim()) return { kind: 'already_applied' };
    const nextTag =
      altOf(tag) === null ? tag.replace(/^<img\b/i, `<img alt="${escapeAttr(change.after)}"`) : tag.replace(/\balt\s*=\s*(["'])(.*?)\1/i, `alt="${escapeAttr(change.after)}"`);
    return { kind: 'next', content: current.replace(tag, () => nextTag) };
  }
  return { kind: 'conflict', message: WP_MESSAGES.unsupported };
}

/** Whether the change shows in a page's content (or public HTML). */
export function changePresent(change: WebsiteChange, content: string): boolean {
  if (change.kind === 'text_replace') {
    if (!change.after) return !content.includes(change.before);
    return content.includes(change.after) && (change.after.includes(change.before) || !content.includes(change.before));
  }
  if (change.kind === 'image_alt_text') {
    const tags = imageTags(content, change.imageSrc);
    return tags.length > 0 && tags.every((t) => decodeAttr(altOf(t[0] ?? '') ?? '').trim() === change.after.trim());
  }
  return false;
}

/** How the caller records writes: the earlier attempt's record, and the hook that stores one before each write. */
export interface WriteRecord {
  prior: PriorWrite | null;
  /** Stores the marker durably; false when the change may no longer be written (nothing is sent then). */
  beforeWrite: (target: LocatedTarget, preWriteHash: string, changeHash: string) => Promise<boolean>;
}

/**
 * Applies one approved change. `readPublic` fetches the public page (through the crawler's guarded fetcher) to tell
 * "visible now" from "cached". Adapter errors for credentials and rights become outcomes; transient errors propagate so
 * the job retries.
 */
export async function applyChange(
  adapter: WebsiteEditAdapter,
  change: WebsiteChange,
  signal: AbortSignal,
  readPublic: (url: string) => Promise<string | null>,
  record: WriteRecord = { prior: null, beforeWrite: async () => true },
): Promise<ApplyAttempt> {
  const supported = adapter.supports(change);
  if (!supported.ok)
    return {
      outcome: 'unsupported',
      message: supported.reason,
      target: null,
      verification: null,
      wrote: false,
      earlierWrite: false,
      writeRefused: false,
    };
  /** Credentials, rights and redirects while reading (nothing written yet) become outcomes; anything else propagates. */
  const readRefusal = (err: unknown, at: ApplyAttempt['target']): ApplyAttempt => {
    const outcome: ApplyOutcome | null =
      err instanceof AdapterAuthError ? 'auth' : err instanceof AdapterForbiddenError ? 'forbidden' : err instanceof AdapterRedirectError ? 'error' : null;
    if (!outcome) throw err;
    return {
      outcome,
      message: (err as Error).message,
      target: at,
      verification: null,
      wrote: false,
      earlierWrite: false,
      writeRefused: false,
    };
  };
  let target: LocatedTarget | null;
  try {
    target = await adapter.locate(change, signal);
  } catch (err) {
    return readRefusal(err, null);
  }
  if (!target)
    return {
      outcome: 'not_found',
      message: "We couldn't find this page in WordPress. It may be part of your theme or another plugin. Use the steps instead.",
      target: null,
      verification: null,
      wrote: false,
      earlierWrite: false,
      writeRefused: false,
    };
  const ref = {
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    link: target.link,
  };
  const thisChange = changeHash(change);
  // The record counts only for this very change on this WordPress item.
  const prior = record.prior && record.prior.resourceId === target.resourceId && record.prior.changeHash === thisChange ? record.prior : null;
  const next = computeNextContent(change, target.current, prior);
  if (next.kind === 'conflict')
    return {
      outcome: 'conflict',
      message: next.message,
      target: ref,
      verification: null,
      wrote: false,
      earlierWrite: false,
      writeRefused: false,
    };
  const earlierWrite = next.kind === 'already_applied' && prior !== null;
  let outcome: ApplyOutcome = 'already_applied';
  let message = earlierWrite ? 'This change was already on your website (an earlier attempt applied it).' : 'Your website already shows this, so nothing needed changing.';
  let wrote = false;
  if (next.kind === 'next') {
    // Optimistic concurrency by hand (WordPress core has no If-Match): read the item again right before writing and
    // write nothing if its content or modification time changed since it was located.
    let fresh: Awaited<ReturnType<WebsiteEditAdapter['recheck']>>;
    try {
      fresh = await adapter.recheck(target, signal);
    } catch (err) {
      return readRefusal(err, ref);
    }
    if (!fresh || fresh.current !== target.current || (target.modifiedGmt !== null && fresh.modifiedGmt !== null && fresh.modifiedGmt !== target.modifiedGmt))
      return {
        outcome: 'conflict',
        message: CHANGED_WHILE_APPLYING,
        target: ref,
        verification: null,
        wrote: false,
        earlierWrite: false,
        writeRefused: false,
      };
    if (!(await record.beforeWrite(target, contentHash(target.current), thisChange)))
      return {
        outcome: 'error',
        message: 'This change was stopped before anything was sent to WordPress, so nothing was changed.',
        target: ref,
        verification: null,
        wrote: false,
        earlierWrite: false,
        writeRefused: false,
      };
    const res = await adapter.write(target, next.content, signal);
    wrote = true;
    if (res.outcome !== 'applied')
      return {
        outcome: res.outcome,
        message: res.message,
        target: ref,
        verification: null,
        wrote,
        earlierWrite: false,
        // The adapter answers anything but "applied" only for a definite refusal (transient errors throw).
        writeRefused: true,
      };
    outcome = 'applied';
    message = res.message;
  }
  const after = await adapter.readBack(target, signal);
  if (!changePresent(change, after))
    return {
      outcome: 'error',
      message: "WordPress accepted the change but doesn't show it when we read the page back. Check the page in WordPress.",
      target: ref,
      verification: 'not_found',
      wrote,
      earlierWrite,
      writeRefused: false,
    };
  let verification: Verification = 'confirmed_api';
  try {
    const html = await readPublic(change.pageUrl);
    if (html !== null) verification = changePresent(change, html) ? 'confirmed_public' : 'not_visible';
  } catch {
    // The public read is a courtesy check; WordPress already confirmed the change.
  }
  return { outcome, message, target: ref, verification, wrote, earlierWrite, writeRefused: false };
}
