import type { Metadata } from 'next';
import { SectionOverview } from '@/components/app/section-overview';

export const metadata: Metadata = { title: 'Appointments' };

/** Appointments section: Square connection status; no bookings are shown until Square is connected. */
export default function AppointmentsPage() {
  return (
    <SectionOverview
      eyebrow="Appointments"
      title="Appointments"
      description="See today’s and upcoming bookings from Square Appointments in Melbourne time, and link each finished cut to its video project."
      area="appointments"
      features={[
        'Today’s bookings and the week ahead, synced from Square.',
        'Mark a cut as finished so follow-up and review emails can be prepared for your approval.',
        'Open a new video project straight from a booking.',
      ]}
      requirements={[
        'A Square account with Square Appointments.',
        'A Square developer application (SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET on the server).',
        'A webhook signature key (SQUARE_WEBHOOK_SIGNATURE_KEY) so booking changes arrive automatically.',
        'Connect Square in Settings → Integrations once the credentials are in place.',
      ]}
    />
  );
}
