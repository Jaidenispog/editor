'use client';

import { CheckCheck, ExternalLink, Lightbulb, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { GOOGLE_TRENDS_URL, TIKTOK_CREATIVE_CENTER_URL, TREND_CATEGORIES, TREND_CATEGORY_LABELS } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';
import type { TrendsOverview } from '@/lib/trend-watches';
import type { TrendItemDto, TrendSummary } from '@/lib/trends';
import { LiveSignals } from './live-signals';
import { NoteTrendDialog } from './note-trend-dialog';

const CATEGORY_OPTIONS = TREND_CATEGORIES.map((c) => ({ value: c, label: TREND_CATEGORY_LABELS[c] }));

type Draft = { id?: string; title: string; summary: string; category: string; sourceName: string; sourceUrl: string };
const EMPTY: Draft = { title: '', summary: '', category: 'format', sourceName: '', sourceUrl: '' };

/** How often the page re-reads while a live source is being fetched, and for how long at most. */
const POLL_MS = 4000;
const POLL_LIMIT = 30;

/** The text "Use as idea" copies: only what the owner can see on the card. */
export function ideaText(item: Pick<TrendItemDto, 'title' | 'summary'>): string {
  return item.summary ? `Idea: ${item.title} — ${item.summary}` : `Idea: ${item.title}`;
}

/**
 * Settings → Trends: three groups that are never mixed — live signals from official sources (each item with its
 * fetch time), things staff noted themselves, and curated barber formats with their sources and review dates.
 * Nothing on this page is passed to the edit planners; "Use as idea" copies the card's text for the Studio's
 * Instructions box, where the owner can edit it.
 */
export function TrendsTab({ trends, disabled }: { trends: TrendSummary[]; disabled: boolean }) {
  const toast = useToast();
  const isOwner = !disabled;
  const [overview, setOverview] = useState<TrendsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<TrendItemDto | null>(null);
  const [idea, setIdea] = useState<string | null>(null);
  const polls = useRef(0);

  const reload = useCallback(async () => {
    try {
      setOverview(await apiRequest<TrendsOverview>('/api/trends'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Trends could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While a source is fetching, re-read every few seconds (a few minutes at most).
  const fetching = overview?.sources.some((s) => s.watch?.status === 'pending') ?? false;
  useEffect(() => {
    if (!fetching) {
      polls.current = 0;
      return;
    }
    if (polls.current >= POLL_LIMIT) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void reload();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [fetching, overview, reload]);

  const noted = useMemo(() => overview?.noted ?? trends.filter((t) => t.kind === 'noted'), [overview, trends]);
  const curated = useMemo(() => overview?.curated ?? trends.filter((t) => t.kind === 'curated'), [overview, trends]);
  const viewerId = overview?.viewer.id ?? null;

  const copyIdea = async (item: TrendItemDto) => {
    const text = ideaText(item);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Idea copied', 'Paste it into Instructions in the Video Studio and change it as you like.');
    } catch {
      setIdea(text);
    }
  };

  const saveCurated = async (e: FormEvent) => {
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
      await reload();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error('Reference not saved', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusyId(id);
    try {
      await work();
      if (done) toast.success(done);
      await reload();
    } catch (err) {
      toast.error('That did not work', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const item = toDelete;
    if (!item) return;
    await act(
      item.id,
      () => (item.kind === 'noted' ? apiRequest(`/api/trends/notes/${encodeURIComponent(item.id)}`, { method: 'DELETE' }) : apiRequest(`/api/trends?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })),
      item.kind === 'noted' ? 'Note deleted' : 'Reference deleted',
    );
    setToDelete(null);
  };

  return (
    <div className="space-y-6">
      {loadError ? (
        <Alert tone="danger" title="Trends could not be loaded">
          {loadError}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => void reload()}>
            Try again
          </button>
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Live signals" description="Fetched from official sources. Each item shows when it was fetched. Nothing is posted or changed on any account." />
        <CardBody>
          <LiveSignals sources={overview?.sources ?? []} live={overview?.live ?? []} isOwner={isOwner} loading={!overview && !loadError} onChanged={reload} onUseAsIdea={(i) => void copyIdea(i)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Noted by staff"
          description="Things the team saw themselves, such as on TikTok, which offers no trend data the app may read. Browse TikTok Creative Center and Google Trends with your own logins."
          actions={
            <Button size="sm" onClick={() => setNoting(true)}>
              <Plus className="size-4" aria-hidden="true" /> Note a trend
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <a href={TIKTOK_CREATIVE_CENTER_URL} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'sm')}>
              Open TikTok Creative Center <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
            <a href={GOOGLE_TRENDS_URL} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'sm')}>
              Open Google Trends <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
          {noted.length === 0 ? (
            <EmptyState title="Nothing noted yet" description="When you see an idea worth trying, note it here so the team can find it later." />
          ) : (
            <ul className="divide-y divide-charcoal-100">
              {noted.map((t) => (
                <TrendCard
                  key={t.id}
                  item={t}
                  busy={busyId === t.id}
                  onUseAsIdea={() => void copyIdea(t)}
                  {...(isOwner || (viewerId !== null && t.notedById === viewerId) ? { onDelete: () => setToDelete(t) } : {})}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Curated references"
          description="Barber content formats collected from published guides, each with its sources and when it was last reviewed. These are ideas only: nothing here is passed to the edit planner."
          actions={
            isOwner ? (
              <Button size="sm" variant="secondary" onClick={() => setDraft({ ...EMPTY })}>
                <Plus className="size-4" aria-hidden="true" /> Add reference
              </Button>
            ) : null
          }
        />
        <CardBody>
          {curated.length === 0 ? (
            <EmptyState title="No references" description={isOwner ? 'Add formats you like, with where you found them.' : 'The owner has not added any references.'} />
          ) : (
            <ul className="divide-y divide-charcoal-100">
              {curated.map((t) => (
                <TrendCard
                  key={t.id}
                  item={t}
                  busy={busyId === t.id}
                  onUseAsIdea={() => void copyIdea(t)}
                  {...(isOwner
                    ? {
                        onDelete: () => setToDelete(t),
                        onEdit: () => setDraft({ id: t.id, title: t.title, summary: t.summary, category: t.category, sourceName: t.sourceName, sourceUrl: t.sourceUrl }),
                        onMarkReviewed: () => void act(t.id, () => apiRequest('/api/trends', { method: 'PUT', body: { id: t.id, markVerified: true } }), 'Marked as reviewed today'),
                        onToggle: (enabled: boolean) => void act(t.id, () => apiRequest('/api/trends', { method: 'PUT', body: { id: t.id, enabled } })),
                      }
                    : {})}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <NoteTrendDialog open={noting} onClose={() => setNoting(false)} onSaved={reload} />

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit reference' : 'Add reference'}
        description="Describe the format in your own words and say where it comes from. Do not paste statistics or song names you cannot verify."
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
          <form id="trend-form" onSubmit={saveCurated} className="space-y-4" noValidate>
            <Input label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={160} required error={errors['title'] ?? null} />
            <Textarea label="Description" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} maxLength={2000} rows={4} error={errors['summary'] ?? null} />
            <Select label="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} options={CATEGORY_OPTIONS} />
            <Input label="Source" value={draft.sourceName} onChange={(e) => setDraft({ ...draft, sourceName: e.target.value })} maxLength={160} required placeholder="e.g. My own notes" error={errors['sourceName'] ?? null} />
            <Input
              label="Source link (optional)"
              hint="Without a link it is shown as an editor suggestion with no external source."
              type="url"
              value={draft.sourceUrl}
              onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })}
              maxLength={500}
              placeholder="https://"
              error={errors['sourceUrl'] ?? null}
            />
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title={toDelete?.kind === 'noted' ? 'Delete this note?' : 'Delete this reference?'}
        description={toDelete?.kind === 'noted' ? 'It is removed for everyone.' : 'Switching it off keeps it for later instead.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busyId === toDelete?.id}>
              Delete
            </Button>
          </>
        }
      />

      <Dialog
        open={idea !== null}
        onClose={() => setIdea(null)}
        title="Copy this idea"
        description="Your browser did not allow copying automatically. Select the text, copy it, and paste it into Instructions in the Video Studio."
        footer={
          <Button variant="secondary" onClick={() => setIdea(null)}>
            Done
          </Button>
        }
      >
        <Textarea label="Idea" hideLabel readOnly value={idea ?? ''} rows={4} onFocus={(e) => e.currentTarget.select()} />
      </Dialog>
    </div>
  );
}

/** One noted or curated item: title, its label (source and date), summary, links and actions. */
function TrendCard({
  item,
  busy,
  onUseAsIdea,
  onDelete,
  onEdit,
  onMarkReviewed,
  onToggle,
}: {
  item: TrendItemDto;
  busy: boolean;
  onUseAsIdea: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onMarkReviewed?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const curated = item.kind === 'curated';
  return (
    <li className={curated && !item.enabled ? 'py-4 opacity-60' : 'py-4'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-charcoal-900 [overflow-wrap:anywhere]">{item.title}</p>
          <p className="mt-0.5 text-xs text-charcoal-500 [overflow-wrap:anywhere]">{item.label}</p>
          {item.summary ? <p className="mt-1.5 text-sm text-charcoal-600 [overflow-wrap:anywhere]">{item.summary}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge>{TREND_CATEGORY_LABELS[item.category] ?? item.category}</Badge>
            {curated && item.dueForReview ? <Badge tone="warning">Due for review</Badge> : null}
          </div>
          {item.kind === 'noted' && item.sourceUrl ? (
            <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-charcoal-700 underline underline-offset-2 [overflow-wrap:anywhere]">
              Open the link <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
          {curated && item.sources.length ? (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-charcoal-700">Sources ({item.sources.length})</summary>
              <ul className="mt-1 space-y-1">
                {item.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-charcoal-600 underline underline-offset-2 [overflow-wrap:anywhere]">
                      {s.name} <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        {onToggle ? <Switch checked={item.enabled} onChange={onToggle} disabled={busy} label={<span className="text-xs text-charcoal-500">Active</span>} /> : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={onUseAsIdea}>
          <Lightbulb className="size-4" aria-hidden="true" /> Use as idea
        </Button>
        {onMarkReviewed ? (
          <Button variant="ghost" size="sm" onClick={onMarkReviewed} disabled={busy}>
            <CheckCheck className="size-4" aria-hidden="true" /> Mark reviewed
          </Button>
        ) : null}
        {onEdit ? (
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${item.title}`}>
            <Pencil className="size-4" aria-hidden="true" /> Edit
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} aria-label={`Delete ${item.title}`}>
            <Trash2 className="size-4" aria-hidden="true" /> Delete
          </Button>
        ) : null}
      </div>
    </li>
  );
}
