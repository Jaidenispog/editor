import { createHash } from 'node:crypto';
import type { ApplyOutcome, Verification, WebsiteChange } from '@studio/core';
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
 * did (`already_applied`, nothing is written twice), which also covers deletions.
 */

/** The record an earlier attempt left right before it sent its write. */
export interface PriorWrite {
  resourceId: string;
  /** SHA-256 (hex) of the content the earlier write was computed from. */
  preWriteHash: string;
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
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

/** Shown when the page changed after an earlier attempt sent its write but does not show the change. */
export const CHANGED_SINCE_EARLIER_WRITE =
  "The page in WordPress changed after an earlier attempt sent this change, and it doesn't show the change. Check the page in WordPress before trying again.";

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
    return changePresent(change, current) ? { kind: 'already_applied' } : { kind: 'conflict', message: CHANGED_SINCE_EARLIER_WRITE };
  }
  // No earlier write, or it never landed (the content is exactly what it was computed from): a first attempt.
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
    if ((altOf(tag) ?? '').trim() === change.after.trim()) return { kind: 'already_applied' };
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
    return tags.length > 0 && tags.every((t) => (altOf(t[0] ?? '') ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') === change.after);
  }
  return false;
}

/** How the caller records writes: the earlier attempt's record, and the hook that stores one before each write. */
export interface WriteRecord {
  prior: PriorWrite | null;
  /** Stores the marker durably; false when the change may no longer be written (nothing is sent then). */
  beforeWrite: (target: LocatedTarget, preWriteHash: string) => Promise<boolean>;
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
    };
  let target: LocatedTarget | null;
  try {
    target = await adapter.locate(change, signal);
  } catch (err) {
    if (err instanceof AdapterAuthError)
      return {
        outcome: 'auth',
        message: err.message,
        target: null,
        verification: null,
        wrote: false,
        earlierWrite: false,
      };
    if (err instanceof AdapterRedirectError)
      return {
        outcome: 'error',
        message: err.message,
        target: null,
        verification: null,
        wrote: false,
        earlierWrite: false,
      };
    if (err instanceof AdapterForbiddenError)
      return {
        outcome: 'forbidden',
        message: err.message,
        target: null,
        verification: null,
        wrote: false,
        earlierWrite: false,
      };
    throw err;
  }
  if (!target)
    return {
      outcome: 'not_found',
      message: "We couldn't find this page in WordPress. It may be part of your theme or another plugin. Use the steps instead.",
      target: null,
      verification: null,
      wrote: false,
      earlierWrite: false,
    };
  const ref = {
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    link: target.link,
  };
  const prior = record.prior && record.prior.resourceId === target.resourceId ? record.prior : null;
  const next = computeNextContent(change, target.current, prior);
  if (next.kind === 'conflict')
    return {
      outcome: 'conflict',
      message: next.message,
      target: ref,
      verification: null,
      wrote: false,
      earlierWrite: false,
    };
  const earlierWrite = next.kind === 'already_applied' && prior !== null;
  let outcome: ApplyOutcome = 'already_applied';
  let message = earlierWrite ? 'This change was already on your website (an earlier attempt applied it).' : 'Your website already shows this, so nothing needed changing.';
  let wrote = false;
  if (next.kind === 'next') {
    if (!(await record.beforeWrite(target, contentHash(target.current))))
      return {
        outcome: 'error',
        message: 'This change was stopped before anything was sent to WordPress, so nothing was changed.',
        target: ref,
        verification: null,
        wrote: false,
        earlierWrite: false,
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
    };
  let verification: Verification = 'confirmed_api';
  try {
    const html = await readPublic(change.pageUrl);
    if (html !== null) verification = changePresent(change, html) ? 'confirmed_public' : 'not_visible';
  } catch {
    // The public read is a courtesy check; WordPress already confirmed the change.
  }
  return { outcome, message, target: ref, verification, wrote, earlierWrite };
}
