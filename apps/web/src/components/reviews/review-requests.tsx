'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { REVIEW_REQUEST_STATUS_WORDS, addDaysToDate, formatDateTime, melbourneDateOf } from '@studio/core';
import { AutomationCard } from '@/components/email/automation-card';
import { MessageDialog } from '@/components/email/message-views';
import type { AutomationDto, ClientDto, EmailTemplateDto, ReviewRequestDto } from '@/components/email/types';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';

export interface ReviewsData {
  requests: ReviewRequestDto[];
  counts: { sentThisMonth: number; openedThisMonth: number };
  clients: ClientDto[];
  templates: EmailTemplateDto[];
  automation: AutomationDto;
  automationBlocked: string | null;
  emailReady: boolean;
  googleProfile: { state: string; label: string; message: string };
}

const STATUS_WORDS: Record<string, string> = REVIEW_REQUEST_STATUS_WORDS;

/** "Send a request" without Square: the owner confirms the visit went ahead (the explicit completed flag). */
function ManualRequestDialog({ clients, open, onClose, onDone }: { clients: ClientDto[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const today = melbourneDateOf(new Date());
  const [customerId, setCustomerId] = useState('');
  const [visitDate, setVisitDate] = useState(today);
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = clients.find((c) => c.id === customerId);
  return (
    <Dialog open={open} onClose={onClose} title="Send a review request" description="Every client gets the same neutral request.">
      <div className="space-y-3">
        <Select label="Client" value={customerId} options={[{ value: '', label: 'Choose a client' }, ...clients.filter((c) => c.email).map((c) => ({ value: c.id, label: c.name }))]} onChange={(e) => setCustomerId(e.target.value)} />
        <Input label="Visit date" type="date" value={visitDate} min={addDaysToDate(today, -7)} max={today} onChange={(e) => setVisitDate(e.target.value)} />
        <label className="flex items-start gap-3 text-sm text-charcoal-800">
          <input type="checkbox" className="mt-1 size-5" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>{`I confirm ${client?.name ?? 'this client'} had an appointment on ${visitDate} that went ahead.`}</span>
        </label>
        <Button
          className="min-h-11"
          disabled={!customerId || !attest}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await apiRequest<{ request: { status: string; skipReason: string | null } }>('/api/reviews/requests', { method: 'POST', body: { customerId, visitDate, attest: true } });
              if (r.request.status === 'skipped') toast.error('Not asked', 'This client cannot be asked right now; the reason is in the list.');
              else toast.success('Request prepared', 'Approve it in the list when you are ready.');
              onDone();
              onClose();
            } catch (e) {
              toast.error('Not prepared', (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Prepare request
        </Button>
      </div>
    </Dialog>
  );
}

/** The fixed skip reasons; there is deliberately no "client unhappy" reason. */
function SkipDialog({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<'asked_in_person' | 'wrong_client_details' | 'other'>('asked_in_person');
  const [note, setNote] = useState('');
  return (
    <Dialog open={id !== null} onClose={onClose} title="Skip this request">
      <div className="space-y-3">
        <Select
          label="Reason"
          value={reason}
          options={[
            { value: 'asked_in_person', label: 'Asked in person' },
            { value: 'wrong_client_details', label: 'Wrong client details' },
            { value: 'other', label: 'Other' },
          ]}
          onChange={(e) => setReason(e.target.value as typeof reason)}
        />
        {reason === 'other' ? <Textarea label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /> : null}
        <Button
          className="min-h-11"
          onClick={async () => {
            try {
              await apiRequest(`/api/reviews/requests/${id}/skip`, { method: 'POST', body: { reason, ...(note ? { note } : {}) } });
              toast.success('Skipped');
              onDone();
              onClose();
            } catch (e) {
              toast.error('Not skipped', (e as Error).message);
            }
          }}
        >
          Skip
        </Button>
      </div>
    </Dialog>
  );
}

/** Reviews → Requests and Reviews on Google (design §4.7, §4.8). Requests are never matched to reviews. */
export function ReviewsWorkspace({ data, canEdit }: { data: ReviewsData; canEdit: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const refresh = useCallback(() => router.refresh(), [router]);
  const [manual, setManual] = useState(false);
  const [skipId, setSkipId] = useState<string | null>(null);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const waiting = data.requests.filter((r) => r.status === 'pending_approval');
  const tab = params.get('tab') ?? 'requests';
  const setTab = (id: string) => {
    const q = new URLSearchParams(params.toString());
    q.set('tab', id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };
  const requests = (
    <div className="space-y-6">
      <p className="text-sm text-charcoal-600">
        This month: {data.counts.sentThisMonth} sent · {data.counts.openedThisMonth} opened the review link (may include email security scanners). Requests are tracked separately from reviews. Google doesn&rsquo;t tell us who left a review, so we never match the two.
      </p>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" onClick={() => setManual(true)}>
            Send a request
          </Button>
          {waiting.length ? (
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={!data.emailReady}
              onClick={async () => {
                try {
                  const r = await apiRequest<{ approved: string[]; blocked: unknown[] }>('/api/reviews/requests/approve-batch', { method: 'POST', body: { ids: waiting.map((w) => w.id).slice(0, 100) } });
                  toast.success(`${r.approved.length} approved`, r.blocked.length ? `${r.blocked.length} could not be approved yet; open them to see why.` : undefined);
                  refresh();
                } catch (e) {
                  toast.error('Not approved', (e as Error).message);
                }
              }}
            >
              Approve all ready ({waiting.length})
            </Button>
          ) : null}
        </div>
      ) : null}
      {!data.emailReady ? <Alert tone="info">Requests can be prepared now. Approving them works once email sending is set up.</Alert> : null}
      {!data.requests.length ? (
        <EmptyState title="No review requests yet" description="Nothing waiting. Follow-ups and review requests appear here after appointments are completed." />
      ) : (
        <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
          {data.requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-charcoal-900">{r.customerName}</p>
                <p className="truncate text-sm text-charcoal-500">
                  {r.appointment}
                  {r.sentAt ? ` · sent ${formatDateTime(r.sentAt)}` : ''}
                  {r.firstClickedAt ? ' · opened the review link' : ''}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <StatusPill
                  status={r.isSandbox && r.status === 'sent' ? 'skipped' : r.status}
                  label={r.isSandbox && r.status === 'sent' ? 'Test — not delivered' : r.skipLabel ? `${STATUS_WORDS[r.status] ?? r.status} — ${r.skipLabel}` : (STATUS_WORDS[r.status] ?? r.status)}
                />
                {canEdit && r.emailMessageId ? (
                  <Button variant="ghost" size="sm" className="min-h-9" onClick={() => setOpenMessage(r.emailMessageId)}>
                    Open
                  </Button>
                ) : null}
                {canEdit && ['pending_approval', 'scheduled'].includes(r.status) ? (
                  <Button variant="ghost" size="sm" className="min-h-9" onClick={() => setSkipId(r.id)}>
                    Skip
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <AutomationCard
          name="review_request"
          title="Automatic requests"
          description="Prepared after a genuinely completed appointment, at most once per client in a year."
          rule="Every client with a completed appointment and email permission gets the same request. We never filter by how happy they seem, and requests never offer anything in return (Google's rules and Australian consumer law)."
          initial={data.automation}
          templates={data.templates}
          blockedReason={data.automationBlocked}
        />
      ) : null}
      <ManualRequestDialog clients={data.clients} open={manual} onClose={() => setManual(false)} onDone={refresh} />
      <SkipDialog id={skipId} onClose={() => setSkipId(null)} onDone={refresh} />
      <MessageDialog id={openMessage} open={openMessage !== null} onClose={() => setOpenMessage(null)} onChanged={refresh} />
    </div>
  );
  const google = (
    <Card>
      <CardHeader title="Reviews on Google" actions={<StatusPill status={data.googleProfile.state} label={data.googleProfile.label} />} />
      <CardBody className="space-y-2 text-sm text-charcoal-700">
        <p>{data.googleProfile.message}</p>
        <p>Optional: listing your Google reviews here needs a Google Cloud project and Google&rsquo;s approval. Review requests work without it. Reviews are never typed in by hand.</p>
      </CardBody>
    </Card>
  );
  return (
    <Tabs
      label="Reviews"
      value={tab}
      onValueChange={setTab}
      items={[
        { id: 'requests', label: `Requests${waiting.length ? ` (${waiting.length})` : ''}`, content: requests },
        { id: 'google', label: 'Reviews on Google', content: google },
      ]}
    />
  );
}
