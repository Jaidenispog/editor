import type { Metadata } from 'next';
import { SectionOverview } from '@/components/app/section-overview';

export const metadata: Metadata = { title: 'Website' };

/** Website section: local search tools and Google connections. */
export default function WebsitePage() {
  return (
    <SectionOverview
      eyebrow="Website"
      title="Website and local search"
      description="Check how your website and Google listing present the studio to people searching for a barber in Ivanhoe, and get suggested improvements you approve one by one."
      area="website"
      features={[
        'A website check covering speed, mobile layout, titles and local business details.',
        'Suggested changes explained in plain English — nothing is changed without your approval.',
        'Search performance from Google Search Console once it is connected.',
      ]}
      requirements={[
        'Your website address saved in Settings → Business.',
        'Your website verified in Google Search Console.',
        'A Google Cloud project (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server), then connect in Settings → Integrations.',
      ]}
    />
  );
}
