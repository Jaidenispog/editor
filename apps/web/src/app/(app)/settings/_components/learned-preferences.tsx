'use client';

import { ChevronDown, ChevronUp, Film } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { STYLES, describeReferenceProfile, formatTrendDate, openSuggestions, type LearnableField, type StyleId } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { RelativeTime } from '@/components/ui/relative-time';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { PreferencesView } from '@/lib/preferences';
import type { ReferenceListItem } from '@/lib/references';

/** A learnable value in plain words. */
export function formatPreferenceValue(field: LearnableField, value: unknown): string {
  switch (field) {
    case 'defaultDurationSec':
      return `${String(value)} seconds`;
    case 'styleOrder':
      return Array.isArray(value) ? (value as StyleId[]).map((s) => STYLES[s]?.name ?? s).join(' → ') : '';
    case 'musicVolume':
      return `${Math.round(Number(value) * 100)}%`;
    case 'textDensity':
      return value === 'none' ? 'None' : value === 'light' ? 'Light' : 'Medium';
    default:
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }
}

function SourceChip({ source, referenceName }: { source: PreferencesView['fields'][number]['source']; referenceName: string }) {
  if (source === 'learned') return <Badge className="border border-[var(--accent)] bg-white">Learned</Badge>;
  if (source === 'owner') return <Badge tone="neutral">Set by you</Badge>;
  if (source === 'reference') return <Badge tone="info">{referenceName ? `From reference video ‘${referenceName}’` : 'From reference video'}</Badge>;
  return <Badge tone="neutral">Default</Badge>;
}

/**
 * Settings → Editing preferences, top part: what the editor has learned, where each value comes from, the evidence
 * behind it, pin / "Let it learn", recent choices and "Reset what it learned". Staff see it read-only.
 */
export function LearnedPreferences({ canEdit, onChanged }: { canEdit: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<PreferencesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await apiRequest<PreferencesView>('/api/preferences'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load what was learned.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, path: string, body: Record<string, unknown>, done?: string) => {
    setBusy(key);
    try {
      await apiRequest(path, { method: 'POST', body });
      if (done) toast.success(done);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error('Not changed', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !view) {
    return (
      <Alert tone="warning" title="What was learned could not be loaded">
        {loadError}{' '}
        <button type="button" className="font-medium underline" onClick={() => void load()}>
          Try again
        </button>
      </Alert>
    );
  }
  if (!view) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </CardBody>
      </Card>
    );
  }

  const { learned, learning } = view;
  const nothingYet = learned.eventsConsidered === 0;
  return (
    <Card>
      <CardHeader
        title="What the editor has learned"
        description="Your favourites, downloads, revisions and hidden edits become better starting points. Nothing is trained; every value is shown here and can be undone."
      />
      <CardBody className="space-y-5">
        <Switch
          checked={learning.enabled}
          onChange={(enabled) => void act('learning', '/api/preferences/learning', { enabled }, enabled ? 'Learning switched on' : 'Learning switched off')}
          label="Learn from my choices"
          description={
            nothingYet ? (
              'Favourite, download or revise a few edits and the editor will start adapting. Nothing has been learned yet.'
            ) : (
              <>
                Learned from {learned.eventsConsidered} choice{learned.eventsConsidered === 1 ? '' : 's'}
                {learned.since ? ` since ${formatTrendDate(learned.since)}` : ''}.{' '}
                {learned.computedAt ? (
                  <>
                    Updated <RelativeTime date={learned.computedAt} />.
                  </>
                ) : null}
              </>
            )
          }
          disabled={!canEdit || busy !== null}
        />
        {!canEdit ? <p className="text-sm text-charcoal-500">Only the studio owner can change these. You can see what the editor uses.</p> : null}
        {learned.error ? (
          <Alert tone="warning" title="Could not update what was learned. Your settings still work.">
            {canEdit ? (
              <Button size="sm" variant="secondary" className="mt-2" loading={busy === 'recompute'} onClick={() => void act('recompute', '/api/preferences/recompute', {}, 'Updating what was learned')}>
                Try again
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {!learning.enabled && !nothingYet ? <p className="text-sm text-charcoal-500">Not used while learning is off. The values below are what is in use now.</p> : null}

        <ul className="divide-y divide-charcoal-100 rounded-xl border border-charcoal-200/70">
          {view.fields.map((f) => (
            <li key={f.field} className={`flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:justify-between ${!learning.enabled && f.source === 'learned' ? 'opacity-60' : ''}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-charcoal-900">{f.label}</span>
                  <SourceChip source={f.source} referenceName={f.pin?.referenceName ?? ''} />
                </div>
                <p className="text-sm text-charcoal-800">{formatPreferenceValue(f.field, f.value)}</p>
                {f.source === 'learned' && f.explanation ? <p className="text-xs text-charcoal-500">{f.explanation}</p> : null}
                {f.notEnoughEvidence && !f.pin ? <p className="text-xs text-charcoal-500">Not enough choices yet — using your setting.</p> : null}
                {f.suggestion ? (
                  <p className="text-xs text-charcoal-600">
                    The editor would suggest {formatPreferenceValue(f.field, f.suggestion.value)} from your recent choices.{' '}
                    {canEdit ? (
                      <button type="button" className="min-h-11 font-medium underline md:min-h-0" disabled={busy !== null} onClick={() => void act(`use:${f.field}`, '/api/preferences/pin', { field: f.field, pinned: true, value: f.suggestion?.value }, 'Suggestion used')}>
                        Use it
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </div>
              {canEdit ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {f.pin ? (
                    <Button size="sm" variant="ghost" className="min-h-11 md:min-h-8" loading={busy === `unpin:${f.field}`} onClick={() => void act(`unpin:${f.field}`, '/api/preferences/pin', { field: f.field, pinned: false }, 'The editor can learn this again')}>
                      Let it learn
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="min-h-11 md:min-h-8" loading={busy === `pin:${f.field}`} onClick={() => void act(`pin:${f.field}`, '/api/preferences/pin', { field: f.field, pinned: true }, 'Kept as your setting')}>
                      Keep this
                    </Button>
                  )}
                  {f.field !== 'styleOrder' ? (
                    <a href={`#pref-${f.field}`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-charcoal-800 underline underline-offset-4 md:min-h-8">
                      Change
                    </a>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => setShowRecent((v) => !v)} aria-expanded={showRecent} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-charcoal-800">
            {showRecent ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />} See recent choices
          </button>
          {canEdit ? (
            <Button variant="secondary" size="sm" className="min-h-11 md:min-h-8" onClick={() => setConfirmReset(true)} disabled={nothingYet && Object.keys(learned.fields).length === 0}>
              Reset what it learned
            </Button>
          ) : null}
        </div>
        {showRecent ? (
          view.recent.length ? (
            <ul className="space-y-1.5 text-sm text-charcoal-700">
              {view.recent.map((r) => (
                <li key={r.id}>
                  {r.text} · <span className="text-charcoal-500">{r.when}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-charcoal-500">No choices recorded yet.</p>
          )
        ) : null}
      </CardBody>
      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset what it learned?"
        description="The editor forgets what it learned from your favourites, downloads, revisions and hidden edits before now. Your own settings stay as they are. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === 'reset'}
              onClick={async () => {
                await act('reset', '/api/preferences/reset', { confirm: true }, 'Learning reset');
                setConfirmReset(false);
              }}
            >
              Reset
            </Button>
          </>
        }
      />
    </Card>
  );
}

/** Settings → Editing preferences → Reference videos (every project), owner only. */
export function ReferenceSuggestionsList() {
  const [refs, setRefs] = useState<ReferenceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<{ references: ReferenceListItem[] }>('/api/references')
      .then((r) => setRefs(r.references))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load reference videos.'));
  }, []);
  return (
    <Card>
      <CardHeader title="Reference videos" description="Videos you added in a project to suggest pace and look. Only their measurements are kept; the files are deleted once measured." />
      <CardBody>
        {error ? <Alert tone="warning">{error}</Alert> : null}
        {!refs && !error ? <Skeleton className="h-16 w-full" /> : null}
        {refs && refs.length === 0 ? <p className="text-sm text-charcoal-500">No reference videos yet. Add one from a project in the Video Studio (“Add a reference video (style only)”).</p> : null}
        {refs && refs.length ? (
          <ul className="divide-y divide-charcoal-100">
            {refs.map((r) => {
              const waiting = r.profile ? openSuggestions(r.profile).length : 0;
              return (
                <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <Film className="mt-0.5 size-4 shrink-0 text-charcoal-400" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-charcoal-900">
                        {r.filename} <span className="font-normal text-charcoal-500">· {r.projectTitle}</span>
                      </p>
                      <p className="text-xs text-charcoal-600">{r.profile ? describeReferenceProfile(r.profile) : r.statusMessage || 'Not measured yet'}</p>
                      {waiting ? <p className="text-xs text-charcoal-600">{waiting} suggestion{waiting === 1 ? '' : 's'} waiting for you</p> : null}
                    </div>
                  </div>
                  <Link href={`/studio/${r.projectId}`} className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-charcoal-800 underline underline-offset-4">
                    Open project
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}
