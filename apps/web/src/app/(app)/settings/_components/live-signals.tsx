'use client';

import { ExternalLink, Lightbulb, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { YOUTUBE_CHART_FOOTER, formatTrendDate, formatTrendDateTime, hashtagLimitMessage, hashtagProblem, normaliseHashtag } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { InstagramPostDto, TrendSourceDto, TrendWatchDto } from '@/lib/trend-watches';
import type { TrendItemDto } from '@/lib/trends';

/** How many chart rows are shown before "Show all". */
const FIRST_ROWS = 10;

/** The pill for a source card: the watch's own state when it is on, else the shared integration state. */
function sourcePill(source: TrendSourceDto): { status: string; label: string } {
  const watch = source.watch;
  // Same words as Settings → Integrations for the same state ("Needs setup", "Missing server settings").
  if (!watch) return source.status.state === 'not_configured' ? { status: 'not_configured', label: 'Needs setup' } : { status: 'not_connected', label: 'Off' };
  switch (watch.status) {
    case 'ok':
      return { status: 'connected', label: 'On · read-only' };
    case 'pending':
      return { status: 'checking', label: 'Fetching' };
    case 'quota':
      return { status: 'quota', label: 'Daily limit reached' };
    case 'unavailable':
      return { status: 'unavailable', label: 'Not available' };
    case 'needs_reauth':
      return { status: 'needs_reauth', label: 'Reconnect needed' };
    default:
      return { status: 'error', label: 'Not working' };
  }
}

/**
 * Settings → Trends → Live signals: one card per official source (the YouTube AU popular chart and the Instagram
 * hashtag watch). Each card shows an explicit state, and every item shows when it was fetched. Turning a source on,
 * refreshing it and turning it off are owner actions; everything is read-only.
 */
export function LiveSignals({
  sources,
  live,
  isOwner,
  loading,
  onChanged,
  onUseAsIdea,
}: {
  sources: TrendSourceDto[];
  live: Array<{ watch: TrendWatchDto; items: TrendItemDto[] }>;
  isOwner: boolean;
  loading: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {sources.map((source) =>
        source.provider === 'instagram_hashtag' ? (
          <HashtagSourceCard
            key={source.provider}
            source={source}
            groups={live.filter((l) => l.watch.provider === 'instagram_hashtag')}
            isOwner={isOwner}
            onChanged={onChanged}
            onUseAsIdea={onUseAsIdea}
          />
        ) : (
          <SourceCard
            key={source.provider}
            source={source}
            items={live.find((l) => l.watch.id === source.watch?.id)?.items ?? []}
            isOwner={isOwner}
            onChanged={onChanged}
            onUseAsIdea={onUseAsIdea}
          />
        ),
      )}
    </div>
  );
}

function SourceCard({
  source,
  items,
  isOwner,
  onChanged,
  onUseAsIdea,
}: {
  source: TrendSourceDto;
  items: TrendItemDto[];
  isOwner: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'add' | 'refresh' | 'remove' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const watch = source.watch;
  const pill = sourcePill(source);
  const nextRefresh = watch?.nextRefreshAt ? new Date(watch.nextRefreshAt) : null;

  const run = async (kind: 'add' | 'refresh' | 'remove', work: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try {
      await work();
      toast.success(done);
      await onChanged();
    } catch (err) {
      toast.error('That did not work', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const add = () => run('add', () => apiRequest('/api/trends/watches', { method: 'POST', body: { provider: source.provider } }), 'Chart turned on. The first fetch runs in the background.');
  const refresh = () => (watch ? run('refresh', () => apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}/refresh`, { method: 'POST' }), 'Refresh started.') : undefined);
  const remove = () =>
    watch
      ? run(
          'remove',
          async () => {
            await apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
            setConfirmOff(false);
          },
          'Chart turned off and its items deleted.',
        )
      : undefined;

  const fetchedItems = items.length ? items : [];
  const heading = fetchedItems[0]?.label ?? null;
  const shown = showAll ? fetchedItems : fetchedItems.slice(0, FIRST_ROWS);
  const anyStale = fetchedItems.some((i) => i.stale);

  return (
    <section aria-labelledby={`source-${source.provider}`} className="rounded-xl border border-charcoal-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`source-${source.provider}`} className="text-sm font-semibold text-charcoal-900">
            {source.status.name}
          </h3>
          <p className="mt-0.5 text-xs text-charcoal-500">Official YouTube Data API · music, movies and gaming only · no Shorts filter</p>
        </div>
        <StatusPill status={pill.status} label={pill.label} />
      </div>

      {!watch ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-charcoal-600">{source.status.message}</p>
          {source.status.missingEnv.length ? (
            <div>
              <p className="text-xs font-medium text-charcoal-500">Missing server settings</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {source.status.missingEnv.map((name) => (
                  <li key={name}>
                    <code className="rounded bg-charcoal-100 px-1.5 py-0.5 text-xs text-charcoal-700">{name}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : isOwner ? (
            <Button size="sm" onClick={add} loading={busy === 'add'}>
              Show the chart
            </Button>
          ) : (
            <p className="text-xs text-charcoal-500">The owner can turn this on.</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {watch.status === 'pending' ? <Alert tone="info">Fetching the chart. This usually takes a few seconds; this page updates by itself.</Alert> : null}
          {watch.status === 'quota' ? <Alert tone="warning">{watch.statusMessage || 'YouTube’s daily limit was reached. It will try again tomorrow.'}</Alert> : null}
          {watch.status === 'error' || watch.status === 'unavailable' || watch.status === 'needs_reauth' ? (
            <Alert tone="warning" title="The last fetch did not work">
              {watch.statusMessage || 'Something went wrong while reading the chart.'}
              {watch.lastSuccessAt ? <span className="block text-xs">Last successful fetch: {formatTrendDateTime(watch.lastSuccessAt)}.</span> : null}
            </Alert>
          ) : null}

          {heading ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-medium text-charcoal-800">{heading}</h4>
                {anyStale ? <Badge tone="warning">Out of date</Badge> : null}
              </div>
              <ol className="mt-2 divide-y divide-charcoal-100 rounded-lg border border-charcoal-100">
                {shown.map((item) => (
                  <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                    <div className="min-w-0 sm:flex-1">
                      <p className="text-sm text-charcoal-900 [overflow-wrap:anywhere]">
                        <span className="mr-1.5 text-xs text-charcoal-400">{item.position ?? ''}</span>
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-xs text-charcoal-500 [overflow-wrap:anywhere]">
                        {item.channelTitle ? `${item.channelTitle} · ` : ''}
                        {item.categoryName ?? 'Other'}
                      </p>
                    </div>
                    <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-charcoal-700 hover:bg-charcoal-100"
                      >
                        Watch on YouTube <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                      <Button variant="ghost" size="sm" onClick={() => onUseAsIdea(item)} aria-label={`Use “${item.title}” as an idea`}>
                        <Lightbulb className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
              {fetchedItems.length > FIRST_ROWS ? (
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer' : `Show all ${fetchedItems.length}`}
                </Button>
              ) : null}
              <p className="mt-2 text-xs text-charcoal-500">{YOUTUBE_CHART_FOOTER}</p>
            </div>
          ) : watch.status === 'ok' ? (
            <p className="text-sm text-charcoal-600">YouTube returned no videos for Australia on the last fetch.</p>
          ) : null}

          {isOwner ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={refresh} loading={busy === 'refresh'} disabled={Boolean(nextRefresh) || watch.status === 'pending'}>
                <RefreshCw className="size-4" aria-hidden="true" /> {watch.status === 'error' ? 'Try again' : 'Refresh now'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
                Turn off
              </Button>
              {nextRefresh ? <span className="text-xs text-charcoal-500">Next manual refresh from {formatTrendDateTime(nextRefresh)}. It also refreshes once a day.</span> : null}
            </div>
          ) : (
            <p className="text-xs text-charcoal-500">Refreshed once a day. Only the owner can change this source.</p>
          )}
        </div>
      )}

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Turn off the YouTube chart?"
        description="Its fetched items are deleted now. You can turn it on again at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={busy === 'remove'}>
              Turn off
            </Button>
          </>
        }
      />
    </section>
  );
}

/** The pill for the Instagram hashtag card, from its shared integration state (one card, several hashtags). */
function hashtagPill(source: TrendSourceDto): { status: string; label: string } {
  const watched = source.watches?.length ?? 0;
  switch (source.status.state) {
    case 'not_configured':
      return { status: 'not_configured', label: 'Needs setup' };
    case 'needs_reauth':
      return { status: 'needs_reauth', label: 'Reconnect needed' };
    case 'unavailable':
      return { status: 'unavailable', label: 'Not available' };
    case 'error':
      return { status: 'error', label: 'Not working' };
    case 'connected':
      return { status: 'connected', label: 'On · read-only' };
    default:
      if (!watched) return { status: 'not_connected', label: 'Off' };
      return source.watch?.status === 'pending' ? { status: 'checking', label: 'Fetching' } : { status: 'not_connected', label: 'On · read-only' };
  }
}

/** Link to Settings → Integrations, where Instagram is connected (by the publishing module). */
function IntegrationsLink() {
  return (
    <Link href="/settings?tab=integrations" className="inline-block text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
      Open Settings → Integrations
    </Link>
  );
}

/**
 * The Instagram hashtag watch (design §4.12): hashtags the owner chose, read through the connected Instagram
 * account with Meta's official API. Shows the weekly limit (30 hashtags in any 7 days, at most 10 watched at once),
 * each hashtag's state and fetch time, and up to 9 top posts per hashtag as plain rows (type, posted date, counts as
 * Instagram reported them, a link). No images, captions or account names are stored or shown.
 */
function HashtagSourceCard({
  source,
  groups,
  isOwner,
  onChanged,
  onUseAsIdea,
}: {
  source: TrendSourceDto;
  groups: Array<{ watch: TrendWatchDto; items: TrendItemDto[]; posts?: InstagramPostDto[] }>;
  isOwner: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  const toast = useToast();
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pill = hashtagPill(source);
  const state = source.status.state;
  const watches = source.watches ?? [];
  const budget = source.budget;
  // Instagram must be connected (by the publishing module) before a hashtag can be watched.
  const ready = state !== 'not_configured' && state !== 'needs_reauth' && !(state === 'not_connected' && source.status.liveMode == null);
  const atMax = budget ? budget.enabled >= budget.maxEnabled : false;
  const weekFull = budget ? budget.used >= budget.limit : false;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const problem = hashtagProblem(tag);
    if (problem) {
      setTagError(problem);
      return;
    }
    setTagError(null);
    setAdding(true);
    try {
      await apiRequest('/api/trends/watches', { method: 'POST', body: { provider: 'instagram_hashtag', hashtag: tag } });
      toast.success(`Watching #${normaliseHashtag(tag)}`, 'The first fetch runs in the background.');
      setTag('');
      await onChanged();
    } catch (err) {
      setTagError(err instanceof Error ? err.message : 'The hashtag could not be added.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <section aria-labelledby="source-instagram_hashtag" className="rounded-xl border border-charcoal-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="source-instagram_hashtag" className="text-sm font-semibold text-charcoal-900">
            {source.status.name}
          </h3>
          <p className="mt-0.5 text-xs text-charcoal-500">Official Instagram API · top posts for hashtags you choose · read-only</p>
        </div>
        <StatusPill status={pill.status} label={pill.label} />
      </div>

      <div className="mt-3 space-y-3">
        {state === 'not_configured' ? (
          <>
            <p className="text-sm text-charcoal-600">{source.status.message}</p>
            {source.status.missingEnv.length ? (
              <div>
                <p className="text-xs font-medium text-charcoal-500">Missing server settings</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {source.status.missingEnv.map((name) => (
                    <li key={name}>
                      <code className="rounded bg-charcoal-100 px-1.5 py-0.5 text-xs text-charcoal-700">{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : !ready ? (
          <>
            {state === 'needs_reauth' ? <Alert tone="warning">{source.status.message}</Alert> : <p className="text-sm text-charcoal-600">{source.status.message}</p>}
            <IntegrationsLink />
          </>
        ) : (
          <>
            {state === 'unavailable' ? <Alert tone="warning">{source.status.message}</Alert> : null}
            {budget ? (
              <p className="text-xs text-charcoal-500">
                {budget.used} of {budget.limit} hashtags used this week · watching {budget.enabled} of {budget.maxEnabled}
              </p>
            ) : null}
            {weekFull && budget?.nextFreeAt ? <Alert tone="warning">{hashtagLimitMessage(budget.nextFreeAt)}</Alert> : null}
            {isOwner ? (
              <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
                <Input
                  label="Hashtag to watch (without #)"
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value);
                    if (tagError) setTagError(null);
                  }}
                  placeholder="skinfade"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={101}
                  error={tagError}
                  hint={atMax ? 'Remove a hashtag before adding another.' : 'Each new hashtag uses one of the 30 Instagram allows a week, for 7 days.'}
                  containerClassName="min-w-0 sm:flex-1"
                  disabled={atMax}
                />
                <Button type="submit" size="sm" className="sm:mt-7" loading={adding} disabled={atMax || !tag.trim()}>
                  Watch
                </Button>
              </form>
            ) : (
              <p className="text-xs text-charcoal-500">The owner chooses which hashtags are watched. They are refreshed once a day.</p>
            )}
            {watches.length === 0 ? (
              <p className="text-sm text-charcoal-600">No hashtags watched yet.</p>
            ) : (
              <div className="space-y-3">
                {watches.map((w) => {
                  const group = groups.find((g) => g.watch.id === w.id);
                  return <HashtagWatchBlock key={w.id} watch={w} items={group?.items ?? []} posts={group?.posts ?? []} isOwner={isOwner} onChanged={onChanged} onUseAsIdea={onUseAsIdea} />;
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Words for one hashtag's own state. */
function watchPill(watch: TrendWatchDto): { status: string; label: string } {
  switch (watch.status) {
    case 'ok':
      return { status: 'connected', label: 'Fetched' };
    case 'pending':
      return { status: 'checking', label: 'Fetching' };
    case 'quota':
      return { status: 'quota', label: 'Waiting' };
    case 'unavailable':
      return { status: 'unavailable', label: 'Not available' };
    case 'needs_reauth':
      return { status: 'needs_reauth', label: 'Reconnect needed' };
    default:
      return { status: 'error', label: 'Not working' };
  }
}

/** One watched hashtag: its state, its actions and its top posts. */
function HashtagWatchBlock({
  watch,
  items,
  posts,
  isOwner,
  onChanged,
  onUseAsIdea,
}: {
  watch: TrendWatchDto;
  items: TrendItemDto[];
  posts: InstagramPostDto[];
  isOwner: boolean;
  onChanged: () => Promise<void> | void;
  onUseAsIdea: (item: TrendItemDto) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'refresh' | 'remove' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const pill = watchPill(watch);
  const nextRefresh = watch.nextRefreshAt ? new Date(watch.nextRefreshAt) : null;
  const heading = items[0]?.label ?? null;
  const anyStale = items.some((i) => i.stale);
  const refreshLabel = watch.status === 'unavailable' ? 'Check again' : watch.status === 'error' ? 'Try again' : 'Refresh now';

  const run = async (kind: 'refresh' | 'remove', work: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try {
      await work();
      toast.success(done);
      await onChanged();
    } catch (err) {
      toast.error('That did not work', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const refresh = () => run('refresh', () => apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}/refresh`, { method: 'POST' }), 'Refresh started.');
  const remove = () =>
    run(
      'remove',
      async () => {
        await apiRequest(`/api/trends/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' });
        setConfirmOff(false);
      },
      `Stopped watching #${watch.query}.`,
    );

  return (
    <div className="rounded-lg border border-charcoal-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded-full bg-charcoal-100 px-2.5 py-0.5 text-sm font-medium text-charcoal-800 [overflow-wrap:anywhere]">#{watch.query}</span>
          <StatusPill status={pill.status} label={pill.label} />
        </div>
        {watch.lastSuccessAt ? <span className="text-xs text-charcoal-500">Fetched {formatTrendDateTime(watch.lastSuccessAt)}</span> : null}
      </div>

      <div className="mt-2 space-y-2">
        {watch.status === 'pending' ? <Alert tone="info">Fetching the top posts. This usually takes a few seconds; this page updates by itself.</Alert> : null}
        {watch.status === 'quota' || watch.status === 'error' || watch.status === 'unavailable' || watch.status === 'needs_reauth' ? (
          <Alert tone="warning">
            {watch.statusMessage || 'The last fetch did not work.'}
            {watch.lastSuccessAt && watch.status !== 'quota' ? <span className="block text-xs">Last successful fetch: {formatTrendDateTime(watch.lastSuccessAt)}.</span> : null}
          </Alert>
        ) : null}

        {heading && items.length ? (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium text-charcoal-800 [overflow-wrap:anywhere]">{heading}</h4>
              {anyStale ? <Badge tone="warning">Out of date</Badge> : null}
            </div>
            <ol className="mt-2 divide-y divide-charcoal-100 rounded-lg border border-charcoal-100">
              {items.map((item, i) => {
                const post = posts[i];
                return (
                  <li key={item.id} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
                    <div className="min-w-0 sm:flex-1">
                      <p className="text-sm text-charcoal-900">
                        <span className="mr-1.5 text-xs text-charcoal-400">{post?.rank ?? i + 1}</span>
                        {post ? post.mediaTypeLabel : 'Post'}
                        {post?.postedAt ? ` · posted ${formatTrendDate(post.postedAt)}` : ''}
                      </p>
                      {post?.countsLine ? <p className="mt-0.5 text-xs text-charcoal-500">{post.countsLine}, as Instagram reported them</p> : null}
                    </div>
                    <div className="-ml-2 flex shrink-0 items-center gap-1 sm:ml-0">
                      <a
                        href={post?.permalink ?? item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-charcoal-700 hover:bg-charcoal-100"
                      >
                        Open on Instagram <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                      <Button variant="ghost" size="sm" onClick={() => onUseAsIdea(item)} aria-label={`Use “${item.title}” as an idea`}>
                        <Lightbulb className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : watch.status === 'ok' ? (
          <p className="text-sm text-charcoal-600">Instagram returned no top posts for #{watch.query} on the last fetch.</p>
        ) : null}

        {isOwner ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={refresh} loading={busy === 'refresh'} disabled={Boolean(nextRefresh) || watch.status === 'pending'}>
              <RefreshCw className="size-4" aria-hidden="true" /> {refreshLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOff(true)}>
              Stop watching
            </Button>
            {nextRefresh ? <span className="text-xs text-charcoal-500">Next manual refresh from {formatTrendDateTime(nextRefresh)}. It also refreshes once a day.</span> : null}
          </div>
        ) : null}
      </div>

      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={`Stop watching #${watch.query}?`}
        description="Its fetched posts are deleted now. It still counts towards Instagram's 30 hashtags a week until 7 days after it was last read."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} loading={busy === 'remove'}>
              Stop watching
            </Button>
          </>
        }
      />
    </div>
  );
}
