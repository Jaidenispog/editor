import type { ApplyOutcome, Verification, WebsiteChange } from '@studio/core';
import { AdapterAuthError, AdapterForbiddenError, WP_MESSAGES } from './adapters/wordpress.js';
import type { LocatedTarget, WebsiteEditAdapter } from './adapters/types.js';

/**
 * Adapter-independent apply (design §7.4.1): supports → locate → compute the new content (the old text must occur
 * exactly once) → write → read back. A retry after a write that already landed finds the new text and no old text, so it
 * reports `already_applied` and never writes twice.
 */

/** What applying one change produced. */
export interface ApplyAttempt {
  outcome: ApplyOutcome;
  message: string;
  target: Pick<LocatedTarget, 'resourceType' | 'resourceId' | 'link'> | null;
  verification: Verification | null;
  /** Whether a write request was sent in this attempt. */
  wrote: boolean;
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

/**
 * The page content after the change, or the reason it can't be made: `already_applied` (new text there, old text gone),
 * or `conflict` (old text missing or more than once). Pure.
 */
export function computeNextContent(
  change: WebsiteChange,
  current: string,
): { kind: 'next'; content: string } | { kind: 'already_applied' } | { kind: 'conflict'; message: string } {
  if (change.kind === 'text_replace') {
    const count = countOccurrences(current, change.before);
    if (change.after && current.includes(change.after) && (count === 0 || change.after.includes(change.before))) return { kind: 'already_applied' };
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
): Promise<ApplyAttempt> {
  const supported = adapter.supports(change);
  if (!supported.ok)
    return {
      outcome: 'unsupported',
      message: supported.reason,
      target: null,
      verification: null,
      wrote: false,
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
      };
    if (err instanceof AdapterForbiddenError)
      return {
        outcome: 'forbidden',
        message: err.message,
        target: null,
        verification: null,
        wrote: false,
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
    };
  const ref = {
    resourceType: target.resourceType,
    resourceId: target.resourceId,
    link: target.link,
  };
  const next = computeNextContent(change, target.current);
  if (next.kind === 'conflict')
    return {
      outcome: 'conflict',
      message: next.message,
      target: ref,
      verification: null,
      wrote: false,
    };
  let outcome: ApplyOutcome = 'already_applied';
  let message = 'This change was already on your website (an earlier attempt applied it).';
  let wrote = false;
  if (next.kind === 'next') {
    const res = await adapter.write(target, next.content, signal);
    wrote = true;
    if (res.outcome !== 'applied')
      return {
        outcome: res.outcome,
        message: res.message,
        target: ref,
        verification: null,
        wrote,
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
    };
  let verification: Verification = 'confirmed_api';
  try {
    const html = await readPublic(change.pageUrl);
    if (html !== null) verification = changePresent(change, html) ? 'confirmed_public' : 'not_visible';
  } catch {
    // The public read is a courtesy check; WordPress already confirmed the change.
  }
  return { outcome, message, target: ref, verification, wrote };
}
