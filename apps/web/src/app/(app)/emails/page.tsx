import type { Metadata } from 'next';
import { SectionOverview } from '@/components/app/section-overview';

export const metadata: Metadata = { title: 'Emails' };

/** Emails section: sending service status and consent-aware messaging plans. */
export default function EmailsPage() {
  return (
    <SectionOverview
      eyebrow="Emails"
      title="Emails"
      description="Thank-you notes, rebooking reminders and occasional offers — written for you, approved by you, and only sent to clients who agreed to hear from you."
      area="email"
      features={[
        'Follow-up emails after an appointment, waiting for your approval before sending.',
        'Templates you can edit, in your business name and voice.',
        'Marketing messages only go to clients with recorded consent, always with an unsubscribe link (Spam Act 2003).',
      ]}
      requirements={[
        'A Resend account with your sending domain verified (RESEND_API_KEY and EMAIL_FROM on the server).',
        'Square connected, so the app knows who visited and when.',
        'Your business email and phone filled in under Settings → Business.',
      ]}
    />
  );
}
