'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { NOTED_TREND_PLATFORMS, TREND_CATEGORIES, TREND_CATEGORY_LABELS, melbourneDateOf, type NotedTrendPlatform, type TrendCategory } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';

const PLATFORM_OPTIONS: Array<{ value: NotedTrendPlatform; label: string }> = [
  { value: 'tiktok', label: 'TikTok' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'in_person', label: 'In the shop' },
  { value: 'other', label: 'Other' },
];

type Draft = { title: string; summary: string; platform: NotedTrendPlatform; sourceUrl: string; seenOn: string; category: TrendCategory };

/** Today is filled in when the dialog opens (not while rendering), so server and browser render the same form. */
function emptyDraft(): Draft {
  return { title: '', summary: '', platform: 'tiktok', sourceUrl: '', seenOn: '', category: 'format' };
}

/**
 * "Note a trend": anyone signed in records something they saw themselves (for example on TikTok, which offers no
 * trend data the app may read). Saved as "Noted by <name> on <date>"; never shown as live data.
 */
export function NoteTrendDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Melbourne's today, set when the dialog opens; the server checks the date again.
  const [today, setToday] = useState('');
  useEffect(() => {
    if (!open) return;
    const now = melbourneDateOf(new Date());
    setToday(now);
    setDraft((d) => (d.seenOn ? d : { ...d, seenOn: now }));
  }, [open]);

  const close = () => {
    setErrors({});
    onClose();
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      await apiRequest('/api/trends/notes', { method: 'POST', body: draft });
      toast.success('Noted', 'It is listed under Noted by staff.');
      setDraft(emptyDraft());
      onClose();
      await onSaved();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Not saved', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Note a trend"
      description="Write what you saw. Don't add view counts or 'trending' unless the app showed you a number."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="note-trend-form" loading={saving}>
            Save note
          </Button>
        </>
      }
    >
      <form id="note-trend-form" onSubmit={save} className="space-y-4" noValidate>
        <Input label="What did you see?" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={160} required placeholder="e.g. Slow fade close-ups with no talking" error={errors['title'] ?? null} />
        <Textarea label="Describe it (optional)" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} maxLength={2000} rows={3} error={errors['summary'] ?? null} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Where?" value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value as NotedTrendPlatform })} options={PLATFORM_OPTIONS.filter((o) => NOTED_TREND_PLATFORMS.includes(o.value))} error={errors['platform'] ?? null} />
          <Select
            label="Type"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value as TrendCategory })}
            options={TREND_CATEGORIES.map((c) => ({ value: c, label: TREND_CATEGORY_LABELS[c] }))}
            error={errors['category'] ?? null}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Date seen" type="date" value={draft.seenOn} max={today || undefined} onChange={(e) => setDraft({ ...draft, seenOn: e.target.value })} required error={errors['seenOn'] ?? null} />
          <Input label="Link (optional)" type="url" value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} maxLength={500} placeholder="https://" error={errors['sourceUrl'] ?? null} />
        </div>
      </form>
    </Dialog>
  );
}
