'use client';

import { useCallback, useEffect, useState } from 'react';
import { MESSAGE_CLASS_LABELS, formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { EmailEditor, EmailPreviewFrame } from './email-editor';
import type { EmailMessageDetailDto, EmailMessageDto, LintDto } from './types';

/** The status pill of a message ("Test — not delivered" for sandbox sends). */
export function MessageStatus({ m }: { m: Pick<EmailMessageDto, 'status' | 'isSandbox'> }) {
  if (m.isSandbox && ['sent', 'delivered'].includes(m.status)) return <StatusPill status="skipped" label="Test — not delivered" />;
  if (m.status === 'suppressed') return <StatusPill status="suppressed" label="Not sent" />;
  return <StatusPill status={m.status} />;
}

/**
 * One message in a dialog: the rendered copy in a sandboxed frame, the timeline, the blockers, and the owner's
 * actions (edit and approve a draft, email a preview to yourself, cancel, send again after a check).
 */
export function MessageDialog({ id, open, onClose, onChanged }: { id: string | null; open: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<EmailMessageDetailDto | null>(null);
  const [draft, setDraft] = useState<{ subject: string; bodyMarkdown: string } | null>(null);
  const [lint, setLint] = useState<LintDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const d = await apiRequest<EmailMessageDetailDto>(`/api/email/messages/${id}`);
      setDetail(d);
      setDraft(d.message.status === 'draft' ? { subject: d.message.subject, bodyMarkdown: d.message.bodyMarkdown } : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    if (open) void load();
    else {
      setDetail(null);
      setDraft(null);
    }
  }, [open, load]);

  const act = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await fn();
      toast.success(done);
      onChanged();
      await load();
    } catch (e) {
      toast.error('Not done', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const m = detail?.message;
  const dirty = Boolean(draft && m && (draft.subject !== m.subject || draft.bodyMarkdown !== m.bodyMarkdown));
  return (
    <Dialog open={open} onClose={onClose} title={m ? m.subject : 'Email'} description={m ? `${m.customerName} · ${MESSAGE_CLASS_LABELS[m.messageClass]}` : undefined} className="max-w-4xl">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!detail || !m ? (
        <p className="text-sm text-charcoal-500">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <MessageStatus m={m} />
            {m.appointment ? <span className="text-sm text-charcoal-600">{m.appointment}</span> : null}
          </div>
          {m.statusMessage ? <p className="text-sm text-charcoal-700">{m.statusMessage}</p> : null}
          {m.ownerAction === 'check_before_retry' ? (
            <Alert tone="warning" title="Check before sending again">
              We couldn&rsquo;t confirm whether this email went out. Check the client&rsquo;s inbox or Postmark Activity first.
            </Alert>
          ) : null}
          {detail.blockers.length ? (
            <Alert tone="warning" title="Can't be sent yet">
              <ul className="list-disc pl-4">
                {detail.blockers.map((b) => (
                  <li key={b.code}>{b.message}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {draft ? (
            <EmailEditor messageClass={m.messageClass} subject={draft.subject} bodyMarkdown={draft.bodyMarkdown} customerId={m.customerId} onChange={setDraft} onLint={setLint} />
          ) : (
            <EmailPreviewFrame html={detail.renderedHtml} />
          )}
          <ol className="space-y-1 text-sm text-charcoal-600">
            {detail.timeline.map((t, i) => (
              <li key={i}>
                {formatDateTime(t.at)} · {t.label}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 border-t border-charcoal-100 pt-4">
            {draft ? (
              <>
                <Button variant="secondary" className="min-h-11" disabled={!dirty} loading={busy === 'save'} onClick={() => act('save', () => apiRequest(`/api/email/messages/${m.id}`, { method: 'PATCH', body: draft }), 'Draft saved')}>
                  Save draft
                </Button>
                <Button
                  className="min-h-11"
                  disabled={dirty || Boolean(lint?.errors.length) || detail.blockers.length > 0}
                  loading={busy === 'approve'}
                  onClick={() => act('approve', () => apiRequest(`/api/email/messages/${m.id}/approve`, { method: 'POST', body: { scheduledFor: null } }), 'Approved. It goes out in the next sending window.')}
                >
                  Approve and send
                </Button>
                <Button variant="ghost" className="min-h-11" loading={busy === 'preview'} onClick={() => act('preview', () => apiRequest(`/api/email/messages/${m.id}/preview-to-me`, { method: 'POST' }), 'Preview on its way to your own address')}>
                  Email me a preview
                </Button>
              </>
            ) : null}
            {['draft', 'approved', 'queued'].includes(m.status) ? (
              <Button variant="ghost" className="min-h-11" loading={busy === 'cancel'} onClick={() => act('cancel', () => apiRequest(`/api/email/messages/${m.id}/cancel`, { method: 'POST' }), 'Cancelled')}>
                Cancel email
              </Button>
            ) : null}
            {m.ownerAction === 'check_before_retry' ? (
              <Button variant="danger" className="min-h-11" loading={busy === 'again'} onClick={() => act('again', () => apiRequest(`/api/email/messages/${m.id}/send-again`, { method: 'POST', body: { confirm: true } }), 'Sending again')}>
                I checked: send again
              </Button>
            ) : null}
            {dirty ? <p className="w-full text-sm text-charcoal-500">Save the draft before approving it.</p> : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** A list of messages (stacked cards on phones) that opens the message dialog. */
export function MessageList({ items, empty, onChanged }: { items: EmailMessageDto[]; empty: string; onChanged: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!items.length) return <EmptyState title={empty} />;
  return (
    <>
      <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
        {items.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => setOpenId(m.id)} className="flex w-full min-w-0 flex-col items-start gap-1 px-4 py-3 text-left hover:bg-charcoal-50 sm:flex-row sm:items-center sm:justify-between">
              <span className="w-full min-w-0 sm:w-auto sm:flex-1">
                <span className="block truncate text-sm font-medium text-charcoal-900">{m.subject}</span>
                <span className="block truncate text-sm text-charcoal-500">
                  {m.customerName} · {MESSAGE_CLASS_LABELS[m.messageClass]}
                  {m.appointment ? ` · ${m.appointment}` : ''}
                  {m.sentAt ? ` · ${formatDateTime(m.sentAt)}` : m.scheduledFor ? ` · sends ${formatDateTime(m.scheduledFor)}` : ''}
                </span>
              </span>
              <MessageStatus m={m} />
            </button>
          </li>
        ))}
      </ul>
      <MessageDialog id={openId} open={openId !== null} onClose={() => setOpenId(null)} onChanged={onChanged} />
    </>
  );
}

/**
 * The approval queue (shared by Emails and Reviews): drafts the automations or the owner prepared, with Approve all
 * ready. Each item opens the full email first.
 */
export function ApprovalQueue({ items, onChanged, canApprove, blockedReason }: { items: EmailMessageDto[]; onChanged: () => void; canApprove: boolean; blockedReason: string | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      {!canApprove && blockedReason ? <Alert tone="info">{blockedReason}</Alert> : null}
      {items.length ? (
        <div className="flex justify-end">
          <Button
            className="min-h-11"
            disabled={!canApprove}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await apiRequest<{ approved: string[]; blocked: Array<{ id: string }> }>('/api/email/messages/approve-batch', { method: 'POST', body: { ids: items.map((i) => i.id).slice(0, 100) } });
                toast.success(`${r.approved.length} approved`, r.blocked.length ? `${r.blocked.length} could not be approved yet; open them to see why.` : undefined);
                onChanged();
              } catch (e) {
                toast.error('Not approved', (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve all ready ({items.length})
          </Button>
        </div>
      ) : null}
      <MessageList items={items} empty="Nothing waiting. Follow-ups and review requests appear here after appointments are completed." onChanged={onChanged} />
    </div>
  );
}
