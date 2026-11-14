'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { EmailSettings } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { AutomationCard } from './automation-card';
import { Campaigns } from './campaigns';
import { ClientList } from './client-list';
import { ApprovalQueue, MessageList } from './message-views';
import { TemplateList } from './template-list';
import type { AutomationDto, CampaignDto, ClientDto, EmailMessageDto, EmailStatusDto, EmailTemplateDto } from './types';

export interface EmailsData {
  status: EmailStatusDto;
  toApprove: EmailMessageDto[];
  drafts: EmailMessageDto[];
  sent: EmailMessageDto[];
  templates: EmailTemplateDto[];
  campaigns: CampaignDto[];
  clients: ClientDto[];
  settings: EmailSettings;
  reviewAutomationOn: boolean;
}

/** Sender name, window, daily limit, what Square sends, and the webhook confirmation (owner). */
function EmailSettingsCard({ initial, webhooksUnknown }: { initial: EmailSettings; webhooksUnknown: boolean }) {
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const tick = (key: 'confirmations' | 'reminders' | 'feedbackOrReviews', label: string) => (
    <label className="flex items-start gap-3 text-sm text-charcoal-800">
      <input type="checkbox" className="mt-1 size-5" checked={s.squareSends[key] === true} onChange={(e) => setS({ ...s, squareSends: { ...s.squareSends, [key]: e.target.checked } })} />
      <span>{label}</span>
    </label>
  );
  return (
    <Card>
      <CardHeader title="Sending settings" description="Applies to every email the app sends." />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Sender name" value={s.senderName} maxLength={80} hint="Blank uses your business name." onChange={(e) => setS({ ...s, senderName: e.target.value })} />
          <Input label="Replies go to" value={s.replyTo} maxLength={120} hint="Blank uses the email in Settings → Business." onChange={(e) => setS({ ...s, replyTo: e.target.value })} />
          <Input label="Send from (Melbourne time)" type="time" value={s.sendWindow.start} onChange={(e) => setS({ ...s, sendWindow: { ...s.sendWindow, start: e.target.value } })} />
          <Input label="Send until" type="time" value={s.sendWindow.end} onChange={(e) => setS({ ...s, sendWindow: { ...s.sendWindow, end: e.target.value } })} />
          <Input label="Marketing emails per day (all together)" type="number" min={1} max={500} value={s.dailyCommercialCap} onChange={(e) => setS({ ...s, dailyCommercialCap: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-charcoal-900">What Square already sends for you</p>
          <p className="text-sm text-charcoal-600">Square already sends booking confirmations and reminders, so Studio Assistant never sends them. Follow-ups go only after an appointment is completed.</p>
          {tick('confirmations', 'Booking confirmations')}
          {tick('reminders', 'Appointment reminders')}
          {tick('feedbackOrReviews', 'Feedback or review requests')}
        </div>
        {webhooksUnknown ? (
          <label className="flex items-start gap-3 text-sm text-charcoal-800">
            <input type="checkbox" className="mt-1 size-5" checked={s.webhooksAttested} onChange={(e) => setS({ ...s, webhooksAttested: e.target.checked })} />
            <span>I added the Postmark webhook to both streams (the check could not read the webhook list).</span>
          </label>
        ) : null}
        <Button
          className="min-h-11"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiRequest('/api/email/settings', { method: 'PUT', body: { senderName: s.senderName, replyTo: s.replyTo, sendWindow: s.sendWindow, dailyCommercialCap: s.dailyCommercialCap, squareSends: s.squareSends, webhooksAttested: s.webhooksAttested } });
              toast.success('Saved');
            } catch (e) {
              toast.error('Not saved', (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save settings
        </Button>
      </CardBody>
    </Card>
  );
}

/** The Emails page tabs (owner; staff see Clients only). The tab is mirrored in `?tab=`. */
export function EmailsWorkspace({ data, isOwner }: { data: EmailsData; isOwner: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get('tab') ?? (isOwner ? 'approve' : 'clients');
  const refresh = useCallback(() => router.refresh(), [router]);
  const ready = data.status.state === 'connected' || data.status.state === 'awaiting_approval';
  const notReady = ready ? null : "Approve buttons work once email sending is set up. Drafts, templates and clients work now.";
  const setTab = (id: string) => {
    const q = new URLSearchParams(params.toString());
    q.set('tab', id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const liveLabel = data.status.liveMode === 'sandbox' ? 'Test server — not delivered to clients' : 'Live — this goes to clients';
  const clients = { id: 'clients', label: 'Clients', content: <ClientList items={data.clients} isOwner={isOwner} onChanged={refresh} /> };
  if (!isOwner) return <Tabs label="Emails" items={[clients]} value="clients" onValueChange={setTab} />;
  return (
    <Tabs
      label="Emails"
      value={tab}
      onValueChange={setTab}
      items={[
        { id: 'approve', label: `To approve${data.toApprove.length ? ` (${data.toApprove.length})` : ''}`, content: <ApprovalQueue items={data.toApprove} onChanged={refresh} canApprove={ready} blockedReason={notReady} /> },
        { id: 'drafts', label: 'Drafts', content: <MessageList items={data.drafts} empty="No drafts. Write one from a client's page." onChanged={refresh} /> },
        { id: 'sent', label: 'Sent', content: <MessageList items={data.sent} empty="No emails sent yet." onChanged={refresh} /> },
        { id: 'campaigns', label: 'Campaigns', content: <Campaigns items={data.campaigns} onChanged={refresh} liveLabel={liveLabel} /> },
        { id: 'templates', label: 'Templates', content: <TemplateList items={data.templates} onChanged={refresh} /> },
        clients,
        {
          id: 'automations',
          label: 'Automations',
          content: (
            <div className="grid gap-6 xl:grid-cols-2">
              <AutomationCard
                name="follow_up"
                title="Follow-up email"
                description="Prepared after a genuinely completed appointment (a matched payment or your “Mark as completed”)."
                rule="Square already sends booking confirmations and reminders, so Studio Assistant never sends them. Follow-ups go only after an appointment is completed."
                initial={data.settings.followUp as AutomationDto}
                templates={data.templates}
                blockedReason={null}
              />
              <Card>
                <CardHeader title="Review requests" description="The review request automation lives on the Reviews page." />
                <CardBody>
                  <Alert tone="info">{data.reviewAutomationOn ? 'Automatic review requests are on.' : 'Automatic review requests are off.'}</Alert>
                </CardBody>
              </Card>
              <div className="xl:col-span-2">
                <EmailSettingsCard initial={data.settings} webhooksUnknown={data.status.webhooks === null && data.status.state === 'connected'} />
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
