'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';
import { formatDate } from '@/lib/format';
import type { TrendSummary } from '@/lib/trends';

const CATEGORIES = [
  { value: 'format', label: 'Format' },
  { value: 'hook', label: 'Hook' },
  { value: 'pacing', label: 'Pacing' },
  { value: 'text_style', label: 'Text style' },
  { value: 'sound', label: 'Sound' },
  { value: 'other', label: 'Other' },
];

type Draft = { id?: string; title: string; summary: string; category: string; sourceName: string; sourceUrl: string };
const EMPTY: Draft = { title: '', summary: '', category: 'format', sourceName: '', sourceUrl: '' };

/** Trend references: curated formats the planner can draw on, each with its source and when it was last checked. */
export function TrendsTab({ trends, disabled }: { trends: TrendSummary[]; disabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<TrendSummary | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setErrors({});
    try {
      const { id, ...fields } = draft;
      if (id) await apiRequest('/api/trends', { method: 'PUT', body: { id, ...fields, markVerified: true } });
      else await apiRequest('/api/trends', { method: 'POST', body: fields });
      toast.success(id ? 'Reference updated' : 'Reference added');
      setDraft(null);
      router.refresh();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Reference not saved', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (t: TrendSummary, enabled: boolean) => {
    setBusyId(t.id);
    try {
      await apiRequest('/api/trends', { method: 'PUT', body: { id: t.id, enabled } });
      router.refresh();
    } catch (err) {
      toast.error('Could not update', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    setBusyId(toDelete.id);
    try {
      await apiRequest(`/api/trends?id=${encodeURIComponent(toDelete.id)}`, { method: 'DELETE' });
      toast.success('Reference deleted');
      setToDelete(null);
      router.refresh();
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Trends and references"
        description="Content formats the edit planner may draw on. These are hand-curated descriptions, not live trend data — switch off any you do not want used."
        actions={
          <Button size="sm" onClick={() => setDraft({ ...EMPTY })} disabled={disabled}>
            <Plus className="size-4" aria-hidden="true" /> Add reference
          </Button>
        }
      />
      <CardBody>
        {trends.length === 0 ? (
          <EmptyState title="No references" description="Add formats you like so the planner can follow them." />
        ) : (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-charcoal-100 text-xs font-medium text-charcoal-500">
                <tr>
                  <th scope="col" className="px-5 py-2 sm:px-6">Reference</th>
                  <th scope="col" className="px-3 py-2">Source</th>
                  <th scope="col" className="px-3 py-2">Last checked</th>
                  <th scope="col" className="px-3 py-2">In use</th>
                  <th scope="col" className="px-5 py-2 sm:px-6"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-charcoal-100">
                {trends.map((t) => (
                  <tr key={t.id} className={t.enabled ? '' : 'opacity-60'}>
                    <td className="max-w-sm px-5 py-3 align-top sm:px-6">
                      <p className="font-medium text-charcoal-900">{t.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-charcoal-500">{t.summary}</p>
                      <Badge className="mt-1.5">{CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category}</Badge>
                    </td>
                    <td className="px-3 py-3 align-top text-charcoal-600">
                      {t.sourceUrl ? (
                        <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                          {t.sourceName}
                        </a>
                      ) : (
                        t.sourceName
                      )}
                      <span className="block text-xs text-charcoal-400">{t.sourceKind === 'curated' ? 'Curated' : 'Live source'}</span>
                    </td>
                    <td className="px-3 py-3 align-top whitespace-nowrap text-charcoal-600">{formatDate(t.lastVerifiedAt)}</td>
                    <td className="px-3 py-3 align-top">
                      <Switch checked={t.enabled} onChange={(v) => toggle(t, v)} disabled={disabled || busyId === t.id} label={<span className="sr-only">Use {t.title}</span>} />
                    </td>
                    <td className="px-5 py-3 align-top whitespace-nowrap sm:px-6">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${t.title}`}
                          disabled={disabled}
                          onClick={() => setDraft({ id: t.id, title: t.title, summary: t.summary, category: t.category, sourceName: t.sourceName, sourceUrl: t.sourceUrl })}
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={`Delete ${t.title}`} disabled={disabled} onClick={() => setToDelete(t)}>
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit reference' : 'Add reference'}
        description="Describe the format in your own words. Do not paste statistics or song names you cannot verify."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" form="trend-form" loading={saving}>
              Save
            </Button>
          </>
        }
      >
        {draft ? (
          <form id="trend-form" onSubmit={save} className="space-y-4" noValidate>
            <Input label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={160} required error={errors['title'] ?? null} />
            <Textarea label="Description" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} maxLength={2000} rows={4} error={errors['summary'] ?? null} />
            <Select label="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} options={CATEGORIES} />
            <Input label="Source" value={draft.sourceName} onChange={(e) => setDraft({ ...draft, sourceName: e.target.value })} maxLength={160} required placeholder="e.g. My own notes" error={errors['sourceName'] ?? null} />
            <Input label="Source link (optional)" type="url" value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} maxLength={500} placeholder="https://" error={errors['sourceUrl'] ?? null} />
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Delete this reference?"
        description="It will no longer be offered to the planner. Switching it off keeps it for later instead."
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={busyId === toDelete?.id}>
              Delete
            </Button>
          </>
        }
      />
    </Card>
  );
}
