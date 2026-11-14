'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime, type MessageClass } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { EmailEditor } from './email-editor';
import type { ClientDto, ConsentDetailDto, LintDto } from './types';

const PERMISSION_TONE: Record<string, string> = { express: 'ready', inferred: 'ready', none: 'skipped', unsubscribed: 'suppressed', suppressed: 'bounced' };
const METHOD_LABELS: Record<string, string> = {
  in_person_device: 'Ticked on this device',
  verbal_owner_recorded: 'Told us (recorded by staff)',
  unsubscribe_page: 'Unsubscribe page',
  one_click: 'One-click unsubscribe',
  postmark_unsubscribe: 'Unsubscribed through Postmark',
  reply_email: 'Replied to an email',
  phone: 'By phone',
  in_person: 'In person',
  square_preference: 'Unsubscribed in Square',
  owner_other: 'Other',
};

/** Record permission: the client ticks an unticked box on this device, or staff record a verbal yes (design §4.6). */
function ConsentForm({ client, detail, onDone }: { client: ClientDto; detail: ConsentDetailDto; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'in_person_device' | 'verbal_owner_recorded'>('in_person_device');
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-charcoal-200 p-4">
      <Select
        label="How is permission given?"
        value={mode}
        options={[
          { value: 'in_person_device', label: 'Client ticks on this device' },
          { value: 'verbal_owner_recorded', label: 'Client told me (in person or by phone)' },
        ]}
        onChange={(e) => {
          setMode(e.target.value as typeof mode);
          setTicked(false);
        }}
      />
      <blockquote className="rounded-[var(--radius-control)] bg-charcoal-50 p-3 text-sm text-charcoal-800">{detail.wording}</blockquote>
      <label className="flex items-start gap-3 text-sm text-charcoal-900">
        <input type="checkbox" className="mt-1 size-5" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        <span>{mode === 'in_person_device' ? `Yes (${client.name})` : 'I read this wording to the client and they said yes'}</span>
      </label>
      <Button
        className="min-h-11"
        disabled={!ticked}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await apiRequest(`/api/customers/${client.id}/consent`, { method: 'POST', body: { method: mode, wordingHash: detail.wordingHash, clientConfirmed: true } });
            toast.success('Permission recorded');
            onDone();
          } catch (e) {
            toast.error('Not recorded', (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </Button>
      <p className="text-xs text-charcoal-500">Never email anyone to ask for permission.</p>
    </div>
  );
}

/** One client's email page: permission, history of consent, blocks, and the actions staff and the owner may take. */
function ClientDialog({ client, isOwner, onClose, onChanged }: { client: ClientDto; isOwner: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<ConsentDetailDto | null>(null);
  const [view, setView] = useState<'main' | 'consent' | 'write'>('main');
  const [draft, setDraft] = useState<{ messageClass: MessageClass; subject: string; bodyMarkdown: string }>({ messageClass: 'transactional_factual', subject: '', bodyMarkdown: '' });
  const [lint, setLint] = useState<LintDto | null>(null);
  const [unsubMethod, setUnsubMethod] = useState('in_person');
  const [lift, setLift] = useState<{ id: string; reason: string; note: string; confirm: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setDetail(await apiRequest<ConsentDetailDto>(`/api/customers/${client.id}/consent`));
    } catch (e) {
      toast.error('Could not load', (e as Error).message);
    }
  }, [client.id, toast]);
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = async () => {
    await load();
    onChanged();
  };
  const post = async (path: string, body: unknown, done: string) => {
    try {
      await apiRequest(path, { method: 'POST', body });
      toast.success(done);
      await refresh();
    } catch (e) {
      toast.error('Not done', (e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      {!detail ? <p className="text-sm text-charcoal-500">Loading…</p> : null}
      {detail && view === 'main' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={PERMISSION_TONE[client.permission] ?? 'skipped'} label={detail.state.label} />
            {client.reviewOptOut ? <StatusPill status="skipped" label="No review requests" /> : null}
          </div>
          {detail.postmarkReactivated ? <Alert tone="info">Postmark reactivated this address; the app still blocks it until you record new permission (or confirm the address was fixed).</Alert> : null}
          <div className="flex flex-wrap gap-2">
            {client.email ? (
              <Button className="min-h-11" onClick={() => setView('consent')}>
                Record permission
              </Button>
            ) : null}
            {isOwner && client.email ? (
              <Button variant="secondary" className="min-h-11" onClick={() => setView('write')}>
                Write email
              </Button>
            ) : null}
            {!client.reviewOptOut ? (
              <Button variant="ghost" className="min-h-11" onClick={() => post(`/api/customers/${client.id}/review-opt-out`, { value: true }, 'Review requests stopped for this client')}>
                Stop review requests
              </Button>
            ) : isOwner ? (
              <Button variant="ghost" className="min-h-11" onClick={() => post(`/api/customers/${client.id}/review-opt-out`, { value: false }, 'Review requests allowed again')}>
                Allow review requests
              </Button>
            ) : null}
          </div>
          {client.email ? (
            <div className="flex flex-wrap items-end gap-2">
              <Select
                label="Record an unsubscribe"
                value={unsubMethod}
                containerClassName="min-w-0 flex-1"
                options={[
                  { value: 'in_person', label: 'Said in person' },
                  { value: 'phone', label: 'Said by phone' },
                  { value: 'reply_email', label: 'Replied to an email' },
                  { value: 'owner_other', label: 'Other' },
                ]}
                onChange={(e) => setUnsubMethod(e.target.value)}
              />
              <Button variant="secondary" className="min-h-11" onClick={() => post(`/api/customers/${client.id}/unsubscribe`, { method: unsubMethod }, 'Unsubscribed from marketing emails')}>
                Unsubscribe
              </Button>
            </div>
          ) : null}
          {detail.suppressions.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-charcoal-900">Blocks</h3>
              <ul className="space-y-1 text-sm">
                {detail.suppressions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {s.reason === 'unsubscribe' ? 'Unsubscribed (marketing)' : s.reason === 'spam_complaint' ? 'Spam complaint (all email)' : s.reason === 'hard_bounce' ? 'Bounced (all email)' : 'Blocked'} · {formatDateTime(s.createdAt)}
                      {s.liftedAt ? ' · lifted' : ''}
                    </span>
                    {isOwner && !s.liftedAt && s.reason !== 'unsubscribe' ? (
                      <Button variant="ghost" size="sm" onClick={() => setLift({ id: s.id, reason: s.reason, note: '', confirm: '' })}>
                        Lift
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.events.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-charcoal-900">Permission history</h3>
              <ul className="space-y-1 text-sm text-charcoal-700">
                {detail.events.map((e) => (
                  <li key={e.id}>
                    {formatDateTime(e.occurredAt)} · {e.kind === 'granted' ? 'Gave permission' : 'Withdrew permission'} · {METHOD_LABELS[e.method] ?? e.method}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {lift ? (
            <div className="space-y-2 rounded-[var(--radius-control)] border border-amber-200 bg-amber-50 p-3">
              <Textarea label="Why can this address be emailed again?" rows={2} value={lift.note} onChange={(e) => setLift({ ...lift, note: e.target.value })} />
              <Input
                label={lift.reason === 'spam_complaint' ? 'Type "they asked to hear from us again"' : 'Type "the address was corrected"'}
                value={lift.confirm}
                onChange={(e) => setLift({ ...lift, confirm: e.target.value })}
              />
              <div className="flex gap-2">
                <Button className="min-h-11" onClick={() => post(`/api/email/suppressions/${lift.id}/lift`, { note: lift.note, confirm: lift.confirm }, 'Block lifted').then(() => setLift(null))}>
                  Lift block
                </Button>
                <Button variant="ghost" className="min-h-11" onClick={() => setLift(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {detail && view === 'consent' ? (
        <>
          <ConsentForm
            client={client}
            detail={detail}
            onDone={async () => {
              setView('main');
              await refresh();
            }}
          />
          <Button variant="ghost" className="min-h-11" onClick={() => setView('main')}>
            Back
          </Button>
        </>
      ) : null}
      {view === 'write' ? (
        <>
          <Select
            label="Type"
            value={draft.messageClass}
            options={[
              { value: 'transactional_factual', label: 'Information only (no offers or links)' },
              { value: 'campaign', label: 'Marketing (needs permission)' },
            ]}
            onChange={(e) => setDraft({ ...draft, messageClass: e.target.value as MessageClass })}
          />
          <EmailEditor messageClass={draft.messageClass} subject={draft.subject} bodyMarkdown={draft.bodyMarkdown} customerId={client.id} onChange={(n) => setDraft({ ...draft, ...n })} onLint={setLint} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => setView('main')}>
              Back
            </Button>
            <Button
              className="min-h-11"
              disabled={Boolean(lint?.errors.length) || !draft.subject.trim()}
              onClick={async () => {
                try {
                  await apiRequest('/api/email/messages', { method: 'POST', body: { customerId: client.id, messageClass: draft.messageClass, subject: draft.subject, bodyMarkdown: draft.bodyMarkdown } });
                  toast.success('Draft saved', 'Open it under Drafts to approve and send.');
                  onClose();
                  onChanged();
                } catch (e) {
                  toast.error('Not saved', (e as Error).message);
                }
              }}
            >
              Save draft
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Emails → Clients: permission at a glance, adding a client (owner), and each client's page. */
export function ClientList({ items, isOwner, onChanged }: { items: ClientDto[]; isOwner: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ClientDto | null>(null);
  const [adding, setAdding] = useState<{ givenName: string; familyName: string; email: string; phone: string } | null>(null);
  const visible = items.filter((c) => (!filter || c.permission === filter) && (!q.trim() || `${c.name} ${c.email ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
        <Input label="Search clients" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select
          label="Permission"
          value={filter}
          options={[
            { value: '', label: 'Everyone' },
            { value: 'express', label: 'Permission recorded' },
            { value: 'none', label: 'No permission' },
            { value: 'unsubscribed', label: 'Unsubscribed' },
            { value: 'suppressed', label: 'Bounced or spam' },
          ]}
          onChange={(e) => setFilter(e.target.value)}
        />
        {isOwner ? (
          <Button className="min-h-11" onClick={() => setAdding({ givenName: '', familyName: '', email: '', phone: '' })}>
            Add client
          </Button>
        ) : null}
      </div>
      {!items.length ? (
        <EmptyState title="No clients yet" description="Connect Square or add a client." />
      ) : (
        <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
          {visible.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpen(c)} className="flex w-full min-w-0 flex-col items-start gap-1 px-4 py-3 text-left hover:bg-charcoal-50 sm:flex-row sm:items-center sm:justify-between">
                <span className="w-full min-w-0 sm:w-auto sm:flex-1">
                  <span className="block truncate text-sm font-medium text-charcoal-900">{c.name}</span>
                  <span className="block truncate text-sm text-charcoal-500">{c.email ?? 'No email'}</span>
                </span>
                <StatusPill status={PERMISSION_TONE[c.permission] ?? 'skipped'} label={c.permissionLabel} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? 'Client'} description={open?.email ?? undefined} className="max-w-3xl">
        {open ? <ClientDialog client={open} isOwner={isOwner} onClose={() => setOpen(null)} onChanged={onChanged} /> : null}
      </Dialog>
      <Dialog open={adding !== null} onClose={() => setAdding(null)} title="Add a client">
        {adding ? (
          <div className="space-y-3">
            <Input label="First name" value={adding.givenName} onChange={(e) => setAdding({ ...adding, givenName: e.target.value })} />
            <Input label="Last name" value={adding.familyName} onChange={(e) => setAdding({ ...adding, familyName: e.target.value })} />
            <Input label="Email" type="email" value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} />
            <Input label="Phone (optional)" value={adding.phone} onChange={(e) => setAdding({ ...adding, phone: e.target.value })} />
            <p className="text-sm text-charcoal-500">Adding a client does not give email permission; record it separately.</p>
            <Button
              className="min-h-11"
              onClick={async () => {
                try {
                  await apiRequest('/api/customers', { method: 'POST', body: { givenName: adding.givenName, familyName: adding.familyName, email: adding.email, ...(adding.phone ? { phone: adding.phone } : {}) } });
                  toast.success('Client added');
                  setAdding(null);
                  onChanged();
                } catch (e) {
                  toast.error('Not added', (e as Error).message);
                }
              }}
            >
              Add client
            </Button>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
