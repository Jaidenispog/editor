import type { Metadata } from 'next';
import { connection } from 'next/server';
import { unsubscribePageFacts } from '@/lib/email';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

/**
 * Public unsubscribe page (no sign-in, no app navigation, works without JavaScript). Viewing it changes nothing (mail
 * scanners pre-fetch links); only the button's plain form post unsubscribes. It never expires and asks for nothing.
 */
export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { token } = await params;
  const sp = await searchParams;
  const facts = await unsubscribePageFacts(token);
  const phone = facts.phone ? ` or call ${facts.phone}` : '';
  let body;
  if (!facts.valid || sp['invalid']) {
    body = <p>{`This link isn't valid. Reply to any email from us${phone} and we'll remove you the same day.`}</p>;
  } else if (sp['done'] || facts.alreadyUnsubscribed) {
    body = (
      <>
        <h1 className="text-xl font-semibold text-charcoal-950">You&rsquo;re unsubscribed</h1>
        <p className="mt-3">{`Done. You won't get marketing emails from ${facts.businessName} any more. Messages about appointments you book may still arrive.`}</p>
      </>
    );
  } else {
    body = (
      <>
        <h1 className="text-xl font-semibold text-charcoal-950">Unsubscribe</h1>
        <p className="mt-3">
          Unsubscribe <strong>{facts.maskedEmail}</strong> from marketing emails from {facts.businessName}?
        </p>
        <form method="post" action={`/api/public/unsubscribe/${encodeURIComponent(token)}`} className="mt-6">
          <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-charcoal-900 px-5 text-sm font-medium text-white hover:bg-charcoal-800">
            Unsubscribe
          </button>
        </form>
      </>
    );
  }
  return (
    <main className="min-h-dvh bg-charcoal-50 px-4 py-10 sm:px-6">
      <article className="mx-auto max-w-md rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white p-6 text-[15px] leading-relaxed text-charcoal-800 shadow-[var(--shadow-card)] sm:p-8">
        <p className="mb-4 text-sm font-semibold" style={{ color: facts.accentColour }}>
          {facts.businessName}
        </p>
        {body}
      </article>
    </main>
  );
}
