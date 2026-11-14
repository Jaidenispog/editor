import type { Metadata } from 'next';
import { SectionOverview } from '@/components/app/section-overview';

export const metadata: Metadata = { title: 'Reviews' };

/** Reviews section: Google review requests and Business Profile status. Reviews are never typed in by hand. */
export default function ReviewsPage() {
  return (
    <SectionOverview
      eyebrow="Reviews"
      title="Reviews"
      description="Ask happy clients for a Google review at the right moment, and see your reviews here once your Business Profile is connected."
      area="reviews"
      features={[
        'Review requests by email after a finished appointment, sent only with your approval.',
        'Your Google review link included automatically.',
        'Reviews from your Google Business Profile listed here, ready for a reply.',
      ]}
      requirements={[
        'Your Google review link, saved in Settings → Business (works straight away for requests).',
        'Email sending set up (Resend) so requests can be delivered.',
        'For showing reviews: a Google Cloud project (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) and your Business Profile connected.',
      ]}
    />
  );
}
