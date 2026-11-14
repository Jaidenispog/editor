import type { Metadata } from 'next';
import { connection } from 'next/server';
import { LEGAL_PAGES, formatDate, type LegalPageKind } from '@studio/core';
import { loadPublishedLegalPage } from './load';

/** Splits the owner's plain text into blocks: a short first line of a multi-line block reads as its heading. */
function blocks(text: string): Array<{ heading: string | null; body: string }> {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const [first = '', ...rest] = b.split('\n');
      const looksLikeHeading = rest.length > 0 && first.length <= 80 && !/[.!?:]$/.test(first);
      return looksLikeHeading ? { heading: first, body: rest.join('\n') } : { heading: null, body: b };
    });
}

/** Page title for a legal page (the page answers 404 until it is published, so no title leaks a draft). */
export function legalMetadata(kind: LegalPageKind): Metadata {
  return { title: LEGAL_PAGES[kind].title, robots: { index: true, follow: false } };
}

/**
 * Public legal page (no sign-in): shows exactly the text the owner published in Settings → Business → Legal pages,
 * and answers 404 until then. Drafts are never shown here.
 */
export async function LegalDocument({ kind }: { kind: LegalPageKind }) {
  await connection();
  const page = await loadPublishedLegalPage(kind);
  return (
    <main className="min-h-dvh bg-charcoal-50 px-4 py-10 sm:px-6">
      <article className="mx-auto max-w-2xl rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-6 shadow-[var(--shadow-card)] sm:p-10">
        <p className="text-sm font-medium text-charcoal-500">{page.businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold text-charcoal-950 sm:text-3xl">{page.title}</h1>
        <div className="mt-6 space-y-5 text-[15px] leading-relaxed text-charcoal-800">
          {blocks(page.body).map((b, i) => (
            <section key={i}>
              {b.heading ? <h2 className="mb-1.5 text-base font-semibold text-charcoal-950">{b.heading}</h2> : null}
              <p className="break-words whitespace-pre-line">{b.body}</p>
            </section>
          ))}
        </div>
        <p className="mt-8 border-t border-charcoal-100 pt-4 text-xs text-charcoal-500">Last updated {formatDate(page.publishedAt)}</p>
      </article>
    </main>
  );
}
