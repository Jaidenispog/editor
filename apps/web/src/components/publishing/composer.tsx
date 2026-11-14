'use client';

import { Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MAX_VIDEOS_PER_BATCH, formatSeconds, type PostMode, type TargetPlatform } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { CandidateVersionDto, EligibilityDto, PublishPostDto } from '@/lib/shared/publishing-dto';
import { CaptionEditor } from './caption-editor';
import { addVideo, buildCreateRequest, draftProblems, initialDraft, type VideoDraft } from './composer-state';
import { CoverPicker } from './cover-picker';
import { DestinationPicker } from './destination-picker';
import { ReviewCard } from './review-card';
import { ScheduleInput } from './schedule-input';

const PLATFORMS: TargetPlatform[] = ['instagram', 'tiktok'];

/**
 * The publishing composer (design §4.1): starts with only the edits the owner chose (never all five), every platform
 * switched off; per video a caption, a cover, destinations with the music rule applied, and the timing in Melbourne
 * time. "Review" saves drafts and shows exactly what will be posted; only the owner can approve.
 */
export function Composer({ initialVersionIds }: { initialVersionIds: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [versionIds, setVersionIds] = useState<string[]>(() => initialVersionIds.reduce<string[]>((acc, id) => addVideo(acc, id), []));
  const [data, setData] = useState<EligibilityDto | null>(null);
  const [drafts, setDrafts] = useState<Record<string, VideoDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<CandidateVersionDto[] | null>(null);
  const [review, setReview] = useState<PublishPostDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setData(null);
      return;
    }
    try {
      const d = await apiRequest<EligibilityDto>(`/api/publishing/eligibility?versions=${encodeURIComponent(ids.join(','))}`);
      setData(d);
      setDrafts((prev) => Object.fromEntries(d.items.map((item) => [item.versionId, prev[item.versionId] ?? initialDraft(item, d.captionFooter)])));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load(versionIds);
  }, [load, versionIds]);

  const items = useMemo(() => (data ? versionIds.map((id) => data.items.find((i) => i.versionId === id)).filter((i): i is NonNullable<typeof i> => Boolean(i)) : []), [data, versionIds]);
  const problems = items.map((item) => (drafts[item.versionId] ? draftProblems(item, drafts[item.versionId]!) : ['Loading…']));
  const ready = items.length > 0 && problems.every((p) => p.length === 0);
  const update = (id: string, patch: Partial<VideoDraft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));

  const toReview = async () => {
    setBusy(true);
    try {
      const body = buildCreateRequest(items.map((i) => drafts[i.versionId]!));
      const res = await apiRequest<{ posts: PublishPostDto[] }>('/api/publish-posts', { method: 'POST', body });
      setReview(res.posts);
    } catch (e) {
      toast.error('Could not prepare the posts', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const backToEditing = async () => {
    const saved = review ?? [];
    setReview(null);
    await Promise.all(saved.map((p) => apiRequest(`/api/publish-posts/${p.id}`, { method: 'DELETE' }).catch(() => undefined)));
  };
  const approve = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await apiRequest('/api/publish-posts/approve', { method: 'POST', body: { postIds: review.map((p) => p.id) } });
      toast.success('Approved', 'Follow each post on the Publishing page.');
      router.push('/publishing');
    } catch (e) {
      toast.error('Could not approve', (e as Error).message);
      setBusy(false);
    }
  };

  if (versionIds.length === 0 && !picker) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <p className="text-sm text-charcoal-700">Choose the edits to publish. Nothing is picked for you.</p>
          <Button className="min-h-11" onClick={() => void apiRequest<{ versions: CandidateVersionDto[] }>('/api/publishing/candidates').then((r) => setPicker(r.versions))}>
            <Plus className="size-4" aria-hidden="true" /> Choose edits
          </Button>
        </CardBody>
      </Card>
    );
  }
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (versionIds.length > 0 && !data) {
    return (
      <p className="flex items-center gap-2 text-sm text-charcoal-600">
        <Spinner className="size-4" /> Loading the edits…
      </p>
    );
  }

  if (review) {
    const modes = new Set(review.map((p) => p.mode));
    const label = modes.has('scheduled') && modes.size === 1 ? `Schedule (${review.length} ${review.length === 1 ? 'post' : 'posts'})` : modes.has('draft_handoff') && modes.size === 1 ? `Prepare (${review.length} ${review.length === 1 ? 'video' : 'videos'})` : `Post now (${review.reduce((n, p) => n + p.targets.length, 0)} posts)`;
    return (
      <div className="space-y-4">
        <Alert tone="info" title="Check before posting">
          This is exactly what will be posted. Instagram and TikTok posts are public.
        </Alert>
        {review.map((p) => (
          <ReviewCard key={p.id} post={p} />
        ))}
        <div className="flex flex-wrap gap-2">
          {data?.canApprove ? (
            <Button className="min-h-11" loading={busy} onClick={() => void approve()}>
              {label}
            </Button>
          ) : (
            <Alert tone="info">Saved as drafts. The studio owner approves them before anything is posted.</Alert>
          )}
          <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => void backToEditing()}>
            Back to editing
          </Button>
          {!data?.canApprove ? (
            <Link href="/publishing" className={buttonClasses('secondary', 'md', 'min-h-11')}>
              Go to Publishing
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {items.map((item, idx) => {
        const d = drafts[item.versionId];
        if (!d) return null;
        const issues = problems[idx] ?? [];
        return (
          <Card key={item.versionId}>
            <CardHeader
              title={`${item.projectTitle} · ${item.styleName}`}
              description={`Version ${item.versionNo} · ${formatSeconds(item.durationSec)}${item.hasMusic ? ' · with music' : ''}`}
              actions={
                <Button variant="ghost" className="min-h-11" aria-label={`Remove ${item.styleName}`} onClick={() => setVersionIds((ids) => ids.filter((x) => x !== item.versionId))}>
                  <X className="size-4" aria-hidden="true" /> Remove
                </Button>
              }
            />
            <CardBody className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-5">
                <CoverPicker previewUrl={item.previewUrl} durationSec={item.durationSec} value={d.coverTimeSec} onChange={(coverTimeSec) => update(item.versionId, { coverTimeSec })} />
                <CaptionEditor value={d.caption} onChange={(caption) => update(item.versionId, { caption })} suffix={item.captionSuffix} footer={data?.captionFooter ?? ''} />
                {item.notes.map((n) => (
                  <p key={n} className="text-xs text-charcoal-600">
                    {n}
                  </p>
                ))}
              </div>
              <div className="space-y-4">
                <div className="space-y-3">
                  <p className="text-sm font-medium text-charcoal-800">Where</p>
                  {PLATFORMS.map((p) => (
                    <DestinationPicker key={p} item={item} platform={p} value={d.destinations[p]} quota={data?.quota ?? {}} onChange={(v) => update(item.versionId, { destinations: { ...d.destinations, [p]: v } })} />
                  ))}
                  {item.priorTargets.length ? (
                    <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal-800">
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.allowRepeat} onChange={(e) => update(item.versionId, { allowRepeat: e.target.checked })} /> Post again
                    </label>
                  ) : null}
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-charcoal-800">When</legend>
                  {(
                    [
                      ['now', 'Post now'],
                      ['scheduled', 'Schedule'],
                      ['draft_handoff', 'Prepare for manual posting'],
                    ] as Array<[PostMode, string]>
                  ).map(([mode, text]) => (
                    <label key={mode} className="flex min-h-11 items-center gap-2 text-sm text-charcoal-800">
                      <input
                        type="radio"
                        className="size-4 accent-[var(--accent)]"
                        name={`${item.versionId}-mode`}
                        checked={d.mode === mode}
                        onChange={() =>
                          update(item.versionId, {
                            mode,
                            ...(mode === 'draft_handoff' ? { destinations: { instagram: { ...d.destinations.instagram, method: 'manual' }, tiktok: { ...d.destinations.tiktok, method: 'manual' } } } : {}),
                          })
                        }
                      />
                      {text}
                    </label>
                  ))}
                  {d.mode === 'scheduled' ? <ScheduleInput value={d.schedule} onChange={(schedule) => update(item.versionId, { schedule })} /> : null}
                </fieldset>
                {issues.length ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-charcoal-600">
                    {issues.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </CardBody>
          </Card>
        );
      })}

      {picker ? (
        <Card>
          <CardHeader title="Add an edit" description={`Tick the edits you want, up to ${MAX_VIDEOS_PER_BATCH} at a time.`} />
          <CardBody>
            {picker.length === 0 ? <p className="text-sm text-charcoal-600">No finished edits yet.</p> : null}
            <ul className="divide-y divide-charcoal-100">
              {picker.map((c) => (
                <li key={c.versionId}>
                  <label className="flex min-h-11 items-center gap-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={versionIds.includes(c.versionId)}
                      disabled={!versionIds.includes(c.versionId) && versionIds.length >= MAX_VIDEOS_PER_BATCH}
                      onChange={(e) => setVersionIds((ids) => (e.target.checked ? addVideo(ids, c.versionId) : ids.filter((x) => x !== c.versionId)))}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-charcoal-900">
                        {c.projectTitle} · {c.styleName}
                      </span>
                      <span className="text-xs text-charcoal-500">
                        Version {c.versionNo}
                        {c.durationSec ? ` · ${formatSeconds(c.durationSec)}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <Button variant="secondary" className="mt-2 min-h-11" onClick={() => setPicker(null)}>
              Done
            </Button>
          </CardBody>
        </Card>
      ) : versionIds.length < MAX_VIDEOS_PER_BATCH ? (
        <Button variant="secondary" className="min-h-11" onClick={() => void apiRequest<{ versions: CandidateVersionDto[] }>('/api/publishing/candidates').then((r) => setPicker(r.versions))}>
          <Plus className="size-4" aria-hidden="true" /> Add another edit
        </Button>
      ) : (
        <p className="text-sm text-charcoal-600">At most {MAX_VIDEOS_PER_BATCH} videos at a time.</p>
      )}

      <div className="-mx-4 border-t sm:sticky sm:bottom-0 border-charcoal-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button className="min-h-11 w-full sm:w-auto" disabled={!ready || busy} loading={busy} onClick={() => void toReview()}>
          Review {items.length} {items.length === 1 ? 'video' : 'videos'}
        </Button>
        {!ready && items.length ? <p className="mt-1 text-xs text-charcoal-600">Finish the details above to continue.</p> : null}
      </div>
    </div>
  );
}
