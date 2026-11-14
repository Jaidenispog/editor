import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { EmailsWorkspace, type EmailsData } from '@/components/email/emails-workspace';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { getEmailStatus, listCampaigns, listClients, listMessages, listTemplates } from '@/lib/email';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';

export const metadata: Metadata = { title: 'Emails' };
export const dynamic = 'force-dynamic';

/**
 * Emails (design §9.1): drafts and approvals, the send log, campaigns, templates, clients and their email permission,
 * and the follow-up automation. Drafts, templates, clients and consent work before Postmark is set up; nothing is
 * sent until it is, and nothing is ever shown as sent that was not.
 */
export default async function EmailsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const isOwner = user.role === 'owner';
  const [status, settings, clients] = await Promise.all([getEmailStatus(), getSettings(), listClients({})]);
  let data: EmailsData = { status, toApprove: [], drafts: [], sent: [], templates: [], campaigns: [], clients: clients.items, settings: settings.email, reviewAutomationOn: settings.reviews.automation.enabled };
  if (isOwner) {
    const [toApprove, drafts, sent, templates, campaigns] = await Promise.all([
      listMessages({ view: 'to_approve' }),
      listMessages({ status: 'draft', origin: 'manual' }),
      listMessages({ view: 'sent', limit: 200 }),
      listTemplates(),
      listCampaigns(),
    ]);
    data = { ...data, toApprove: toApprove.items.filter((m) => m.purpose !== 'review_request'), drafts: drafts.items.filter((m) => !m.bookingId && m.purpose !== 'review_request'), sent: sent.items, templates: templates.items, campaigns: campaigns.items };
  }
  return (
    <>
      <PageHeader
        eyebrow="Emails"
        title="Emails"
        description="Follow-ups, occasional campaigns and one-off emails to clients — written or prepared for you, approved by you, and marketing only to clients who agreed to hear from you."
        status={<StatusPill status={status.pill.status} label={status.pill.label} />}
      />
      {status.state !== 'connected' ? (
        <Alert tone={status.state === 'error' || status.state === 'needs_reauth' ? 'danger' : 'info'} className="mb-6" title={status.state === 'not_configured' ? 'Email sending isn’t set up yet' : undefined}>
          {status.message}
        </Alert>
      ) : null}
      <Suspense>
        <EmailsWorkspace data={data} isOwner={isOwner} />
      </Suspense>
    </>
  );
}
