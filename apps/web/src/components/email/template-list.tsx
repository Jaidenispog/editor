'use client';

import { useState } from 'react';
import { MESSAGE_CLASS_LABELS, type MessageClass } from '@studio/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { EmailEditor } from './email-editor';
import type { EmailTemplateDto, LintDto } from './types';

const PURPOSES = [
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'review_request', label: 'Review request' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'rebooking', label: 'Rebooking' },
  { value: 'custom', label: 'Other' },
];
const CLASSES: Array<{ value: MessageClass; label: string }> = [
  { value: 'transactional_factual', label: MESSAGE_CLASS_LABELS.transactional_factual },
  { value: 'campaign', label: MESSAGE_CLASS_LABELS.campaign },
  { value: 'review_request', label: MESSAGE_CLASS_LABELS.review_request },
];

type Editing = { id: string | null; name: string; purpose: string; messageClass: MessageClass; subject: string; bodyMarkdown: string };

/** Emails → Templates: built-in neutral templates and the owner's own; archived instead of deleted (design §4.5). */
export function TemplateList({ items, onChanged }: { items: EmailTemplateDto[]; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [lint, setLint] = useState<LintDto | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const body = { name: editing.name, purpose: editing.purpose, messageClass: editing.messageClass, subject: editing.subject, bodyMarkdown: editing.bodyMarkdown };
      if (editing.id) await apiRequest(`/api/email/templates/${editing.id}`, { method: 'PATCH', body });
      else await apiRequest('/api/email/templates', { method: 'POST', body });
      toast.success('Template saved');
      setEditing(null);
      onChanged();
    } catch (e) {
      toast.error('Not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button className="min-h-11" onClick={() => setEditing({ id: null, name: '', purpose: 'custom', messageClass: 'transactional_factual', subject: '', bodyMarkdown: '' })}>
          New template
        </Button>
      </div>
      <ul className="divide-y divide-charcoal-100 rounded-[var(--radius-card)] border border-charcoal-200/70 bg-white">
        {items.map((t) => (
          <li key={t.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-charcoal-900">{t.name}</p>
              <p className="truncate text-sm text-charcoal-500">{t.subject}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge>{MESSAGE_CLASS_LABELS[t.messageClass]}</Badge>
                {t.builtIn ? <Badge tone="accent">Built in</Badge> : null}
                {!t.enabled ? <Badge tone="warning">Archived</Badge> : null}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" className="min-h-11" onClick={() => setEditing({ id: t.id, name: t.name, purpose: t.purpose, messageClass: t.messageClass, subject: t.subject, bodyMarkdown: t.bodyMarkdown })}>
                Edit
              </Button>
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={async () => {
                  try {
                    await apiRequest(`/api/email/templates/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } });
                    onChanged();
                  } catch (e) {
                    toast.error('Not changed', (e as Error).message);
                  }
                }}
              >
                {t.enabled ? 'Archive' : 'Restore'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit template' : 'New template'} className="max-w-4xl">
        {editing ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Name" value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <Select label="Type" value={editing.messageClass} options={CLASSES} onChange={(e) => setEditing({ ...editing, messageClass: e.target.value as MessageClass })} />
              <Select label="Used for" value={editing.purpose} options={PURPOSES} onChange={(e) => setEditing({ ...editing, purpose: e.target.value })} />
            </div>
            <EmailEditor messageClass={editing.messageClass} subject={editing.subject} bodyMarkdown={editing.bodyMarkdown} onChange={(n) => setEditing({ ...editing, ...n })} onLint={setLint} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="min-h-11" onClick={() => setEditing(null)}>
                Close
              </Button>
              <Button className="min-h-11" loading={busy} disabled={!editing.name.trim() || Boolean(lint?.errors.length)} onClick={save}>
                Save template
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
