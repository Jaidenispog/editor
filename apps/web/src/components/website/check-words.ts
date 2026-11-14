import type { AuditSummary } from '@studio/core';

/**
 * Plain wording for a finished website check (pure, so it can be tested without rendering). A check that read no page
 * (robots.txt kept us out, or the home page couldn't be read) never says "nothing to fix": nothing was checked.
 */

export const PAGES_NOT_READ = "We couldn't check your pages this time.";

/** Plain counts for one check ("2 urgent, 5 important, …"), or why there are none. */
export function countsLine(s: AuditSummary): string {
  const parts = [
    [s.counts.critical, 'urgent'],
    [s.counts.high, 'important'],
    [s.counts.medium, 'worth doing'],
    [s.counts.low, 'minor'],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
  if (text.length) return text.join(', ');
  return s.pagesChecked > 0 ? 'Nothing to fix' : 'No pages could be read';
}

/**
 * The note for "Everything we found": what it says when there is nothing to list, or the line above the list when the
 * check read no page (null when the findings speak for themselves).
 */
export function findingsNote(findingCount: number, notRead: { reasons: string[] } | null | undefined): string | null {
  if (notRead) {
    const why = notRead.reasons.length ? ` ${notRead.reasons.join(' ')}` : '';
    return findingCount === 0
      ? `${PAGES_NOT_READ}${why} An empty list here doesn't mean your site is fine; check again once that's sorted.`
      : `${PAGES_NOT_READ}${why} Only what we could see without reading your pages is listed below.`;
  }
  return findingCount === 0 ? 'The check found nothing to fix. Nice work.' : null;
}
