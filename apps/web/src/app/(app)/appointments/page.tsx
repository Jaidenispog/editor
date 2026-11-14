import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppointmentsView } from '@/components/appointments/appointments-view';
import { SectionOverview } from '@/components/app/section-overview';
import { buttonClasses } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { getCurrentUser } from '@/lib/session';
import { getSquareStatus } from '@/lib/square/status';

export const metadata: Metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

/**
 * Appointments (design §9.1): Square's bookings, clients and services from Studio Assistant's copy once Square is
 * connected; until then the honest "needs setup" overview. No booking is ever shown that Square did not send.
 */
export default async function AppointmentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const status = await getSquareStatus(user);
  if (!status.dataEnvironment) {
    return (
      <SectionOverview
        eyebrow="Appointments"
        title="Appointments"
        description="See today’s and upcoming bookings from Square Appointments in Melbourne time, and mark who attended."
        area="appointments"
        features={[
          'Today’s bookings and the next 31 days, copied from Square every 10 minutes (and straight away when Square sends an update).',
          'Mark who attended, or let Studio Assistant match Square payments to bookings (shown as an estimate), so follow-up and review emails only go to real visits.',
          'Your clients and services from Square, and free times your clients would see online.',
          'Square stays in charge: confirmations, reminders, no-shows and deposits stay in Square.',
        ]}
        requirements={[
          'A Square account with Square Appointments.',
          'A Square developer application (SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET on the server). Start with the sandbox (test) keys.',
          'Optional: a webhook signature key (SQUARE_WEBHOOK_SIGNATURE_KEY) so changes arrive straight away; without it bookings refresh every 10 minutes.',
          'Connect Square in Settings → Integrations once the keys are in place.',
        ]}
      >
        {status.canManage && status.state === 'not_connected' ? (
          <a href="/api/integrations/square/connect?access=read" className={buttonClasses('primary', 'md', 'min-h-11')}>
            Connect Square
          </a>
        ) : null}
      </SectionOverview>
    );
  }
  return (
    <>
      <PageHeader eyebrow="Appointments" title="Appointments" description="Your Square bookings in Melbourne time. Square stays the source of truth; changes to bookings are made in Square." />
      <AppointmentsView initialStatus={status} />
    </>
  );
}
