'use client';

import { useState } from 'react';
import { AUDIENCE_EXCLUSION_LABELS, formatDate, type AudienceExclusion } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { EmailEditor } from './email-editor';
import type { AudiencePreviewDto, CampaignDto, LintDto } from './types';

const AUDIENCE_OPTIONS = [
  { value: '', label: 'Every client who gave email permission' },
  { value: '90', label: '…who visited in the last 3 months' },
  { value: '180', label: '…who visited in the last 6 months' },
  { value: '365', label: '…who visited in the last 12 months' },
];

/** Write → Audience → Review for one draft campaign (design §4.4). Approval always needs the owner's tick. */
function CampaignWizard({ campaign, onClose, onChanged, liveLabel }: { campaign: CampaignDto; onClose: () => void; onChanged: () => void; liveLabel: string }) {
  const toast = useToast();
  const [step, setStep] = useState<'write' | 'audience' | 'review'>('write');
  const [form, setForm] = useState({ name: campaign.name, subject: campaign.subject, bodyMarkdown: campaign.bodyMarkdown, audience: campaign.audience.lastVisitWithinDays });
  const [lint, setLint] = useState<LintDto | null>(null);
  const [preview, setPreview] = useState<AudiencePreviewDto | null>(null);
  const [search, setSearch] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  const saveAndPreview = async () => {
    setBusy(true);
    try {
      await apiRequest(`/api/email/campaigns/${campaign.id}`, { method: 'PATCH', body: { name: form.name, subject: form.subject, bodyMarkdown: form.bodyMarkdown, audience: { lastVisitWithinDays: form.audience } } });
      setPreview(await apiRequest<AudiencePreviewDto>(`/api/email/campaigns/${campaign.id}/audience-preview`, { method: 'POST', body: {} }));
      setStep('audience');
      onChanged();
    } catch (e) {
      toast.error('Not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await apiRequest(`/api/email/campaigns/${campaign.id}/approve`, { method: 'POST', body: { audienceHash: preview.audienceHash, confirmConsent: true } });
      toast.success('Campaign approved', 'It goes out within your daily limit.');
      onChanged();
      onClose();
    } catch (e) {
      toast.error('Not approved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const visible = preview ? preview.rows.filter((r) => !search.trim() || `${r.name} ${r.email ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())) : [];
  const days = preview?.schedule.length ?? 0;
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {(['write', 'audience', 'review'] as const).map((s, i) => (
          <li key={s} className={step === s ? 'font-semibold text-charcoal-900' : 'text-charcoal-500'}>
            {i + 1}. {s === 'write' ? 'Write' : s === 'audience' ? 'Audience' : 'Review and approve'}
          </li>
        ))}
      </ol>
      {step === 'write' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Campaign name (only you see it)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select label="Audience" value={form.audience === null ? '' : String(form.audience)} options={AUDIENCE_OPTIONS} onChange={(e) => setForm({ ...form, audience: e.target.value ? (Number(e.target.value) as 90 | 180 | 365) : null })} />
          </div>
          <EmailEditor messageClass="campaign" subject={form.subject} bodyMarkdown={form.bodyMarkdown} onChange={(n) => setForm({ ...form, ...n })} onLint={setLint} />
          <div className="flex justify-end">
            <Button className="min-h-11" loading={busy} disabled={!form.name.trim() || Boolean(lint?.errors.length)} onClick={saveAndPreview}>
              Save and see recipients
            </Button>
          </div>
        </>
      ) : null}
      {step === 'audience' && preview ? (
        <>
          <p className="text-sm font-medium text-charcoal-900">
            {preview.included} will receive this · {preview.excluded} left out
          </p>
          {Object.keys(preview.byReason).length ? (
            <p className="text-sm text-charcoal-600">
              Left out:{' '}
              {Object.entries(preview.byReason)
                .map(([k, n]) => `${AUDIENCE_EXCLUSION_LABELS[k as AudienceExclusion] ?? k} (${n})`)
                .join(' · ')}
            </p>
          ) : null}
          <Input label="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul className="max-h-72 divide-y divide-charcoal-100 overflow-y-auto rounded-[var(--radius-control)] border border-charcoal-200">
            {visible.map((r) => (
              <li key={r.customerId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{r.name}</span>
                {r.included ? <StatusPill status="ready" label="Included" /> : <StatusPill status="skipped" label={AUDIENCE_EXCLUSION_LABELS[r.reason as AudienceExclusion] ?? 'Left out'} />}
              </li>
            ))}
          </ul>
          <div className="flex justify-between gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep('write')}>
              Back
            </Button>
            <Button className="min-h-11" disabled={preview.included === 0} onClick={() => setStep('review')}>
              Next
            </Button>
          </div>
        </>
      ) : null}
      {step === 'review' && preview ? (
        <>
          <Alert tone="info" title={liveLabel}>
            {preview.included} client{preview.included === 1 ? '' : 's'}
            {days > 1 ? `, sent over ${days} days because of your daily limit` : ''}. Every email has your business details and an unsubscribe link.
          </Alert>
          <label className="flex items-start gap-3 text-sm text-charcoal-800">
            <input type="checkbox" className="mt-1 size-5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>These clients agreed to receive marketing emails from us.</span>
          </label>
          <div className="flex justify-between gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setStep('audience')}>
              Back
            </Button>
            <Button className="min-h-11" disabled={!agree} loading={busy} onClick={approve}>
              Approve campaign
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Emails → Campaigns: the list, progress and the pause / resume / cancel controls. */
export function Campaigns({ items, onChanged, liveLabel }: { items: CampaignDto[]; onChanged: () => void; liveLabel: string }) {
  const toast = useToast();
  const [open, setOpen] = useState<CampaignDto | null>(null);
  const act = async (id: string, action: 'pause' | 'resume' | 'cancel') => {
    try {
      await apiRequest(`/api/email/campaigns/${id}/${action}`, { method: 'POST' });
      onChanged();
    } catch (e) {
      toast.error('Not changed', (e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          className="min-h-11"
          onClick={async () => {
            try {
              const r = await apiRequest<{ campaign: CampaignDto }>('/api/email/campaigns', { method: 'POST', body: { name: 'New campaign', subject: '', bodyMarkdown: '', audience: { lastVisitWithinDays: null } } });
              onChanged();
              setOpen(r.campaign);
            } catch (e) {
              toast.error('Not created', (e as Error).message);
            }
          }}
        >
          New campaign
        </Button>
      </div>
      {!items.length ? (
        <EmptyState title="No campaigns yet" description="Campaigns go only to clients who gave email permission, always with your approval." />
      ) : (
        <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
          {items.map((c) => (
            <li key={c.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-charcoal-900">{c.name}</span>
                <StatusPill status={c.status === 'sending' ? 'processing' : c.status} label={c.status === 'sending' ? 'Sending' : undefined} />
              </div>
              <p className="text-sm text-charcoal-600">
                {c.status === 'draft' ? `Created ${formatDate(c.createdAt)}` : `${c.sentCount} of ${c.recipientCount} sent · ${c.deliveredCount} delivered · ${c.bounceCount} bounced · ${c.complaintCount} complaints`}
              </p>
              {c.pausedReason && c.status === 'paused' ? <Alert tone="warning">{c.pausedReason}</Alert> : null}
              <div className="flex flex-wrap gap-2">
                {c.status === 'draft' ? (
                  <Button variant="secondary" className="min-h-11" onClick={() => setOpen(c)}>
                    Continue
                  </Button>
                ) : null}
                {['approved', 'sending'].includes(c.status) ? (
                  <Button variant="secondary" className="min-h-11" onClick={() => act(c.id, 'pause')}>
                    Pause
                  </Button>
                ) : null}
                {c.status === 'paused' ? (
                  <Button variant="secondary" className="min-h-11" onClick={() => act(c.id, 'resume')}>
                    Resume
                  </Button>
                ) : null}
                {['draft', 'approved', 'sending', 'paused'].includes(c.status) ? (
                  <Button variant="ghost" className="min-h-11" onClick={() => act(c.id, 'cancel')}>
                    {c.status === 'draft' ? 'Discard' : 'Cancel remaining'}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? 'Campaign'} className="max-w-4xl">
        {open ? <CampaignWizard campaign={open} onClose={() => setOpen(null)} onChanged={onChanged} liveLabel={liveLabel} /> : null}
      </Dialog>
    </div>
  );
}
