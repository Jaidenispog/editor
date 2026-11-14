'use client';

import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { PublishPostDto } from '@/lib/shared/publishing-dto';
import { POST_LABELS } from './labels';
import { TargetCard } from './target-card';

type Detail = PublishPostDto & { history: Array<{ at: string; action: string; label: string }> };

/**
 * One post: the video preview, the final caption (copy button), the cover, one card per destination and the post's
 * own history (Melbourne times). Refreshes every 5 s while a destination is queued or processing.
 */
export function PostDetail({ initial, previewUrl, isOwner }: { initial: Detail; previewUrl: string | null; isOwner: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [post, setPost] = useState<Detail>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => setPost(await apiRequest<Detail>(`/api/publish-posts/${initial.id}`)), [initial.id]);
  const active = post.targets.some((t) => t.status === 'queued' || t.status === 'processing');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const cancellable = post.approvedAt && post.targets.some((t) => t.actions.includes('cancel'));
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <div className="space-y-4">
        <div className="mx-auto aspect-[9/16] w-full max-w-xs overflow-hidden rounded-xl bg-charcoal-950">
          {previewUrl ? <video src={previewUrl} controls playsInline preload="metadata" className="size-full object-contain" aria-label={`Preview of ${post.styleName}`} /> : <p className="p-6 text-center text-sm text-charcoal-300">Preview not available</p>}
        </div>
        {post.coverUrl ? (
          <div>
            <p className="text-xs font-medium text-charcoal-500">Cover</p>
            <img src={post.coverUrl} alt="Chosen cover frame" className="mt-1 w-24 rounded-md border border-charcoal-200" />
          </div>
        ) : null}
      </div>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={post.status} label={POST_LABELS[post.status]} />
          <span className="text-sm text-charcoal-600">{post.statusMessage}</span>
        </div>
        {post.mode === 'scheduled' && post.scheduledForLabel ? <p className="text-sm text-charcoal-700">Scheduled for {post.scheduledForLabel}</p> : null}
        {post.status === 'draft' ? (
          <Alert tone="info">
            {isOwner ? 'This post is a draft: nothing is sent until you approve it. Check the destinations below first.' : 'This post is a draft. The studio owner approves it before anything is posted.'}
            {isOwner ? (
              <div className="mt-2">
                <Button
                  className="min-h-11"
                  loading={busy === 'approve'}
                  onClick={async () => {
                    setBusy('approve');
                    try {
                      await apiRequest('/api/publish-posts/approve', { method: 'POST', body: { postIds: [post.id] } });
                      await refresh();
                      toast.success('Approved');
                    } catch (e) {
                      toast.error('Could not approve', (e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {post.mode === 'scheduled' ? 'Approve and schedule' : post.mode === 'draft_handoff' ? 'Approve and prepare' : 'Approve and post now'}
                </Button>
              </div>
            ) : null}
          </Alert>
        ) : null}
        <Card>
          <CardHeader
            title="Caption"
            actions={
              <Button
                variant="secondary"
                className="min-h-11"
                onClick={() => void navigator.clipboard.writeText(post.caption).then(() => toast.success('Caption copied'), () => toast.error('The caption could not be copied'))}
              >
                <Copy className="size-4" aria-hidden="true" /> Copy
              </Button>
            }
          />
          <CardBody>
            <p className="whitespace-pre-wrap break-words text-sm text-charcoal-800">{post.caption || 'No caption'}</p>
          </CardBody>
        </Card>
        <section aria-label="Destinations" className="space-y-3">
          {post.targets.map((t) => (
            <TargetCard key={t.id} post={post} target={t} isOwner={isOwner} onChanged={(next) => (next ? setPost((p) => ({ ...p, ...next })) : void refresh())} />
          ))}
        </section>
        <div className="flex flex-wrap gap-2">
          {isOwner && cancellable ? (
            <Button
              variant="danger"
              className="min-h-11"
              loading={busy === 'cancel'}
              onClick={async () => {
                setBusy('cancel');
                try {
                  await apiRequest(`/api/publish-posts/${post.id}/cancel`, { method: 'POST', body: {} });
                  await refresh();
                  toast.success('Cancelled', 'Anything already posted stays on the platform.');
                } catch (e) {
                  toast.error('Could not cancel', (e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              Cancel what hasn&apos;t been sent
            </Button>
          ) : null}
          {post.status === 'draft' ? (
            <Button
              variant="secondary"
              className="min-h-11"
              loading={busy === 'delete'}
              onClick={async () => {
                setBusy('delete');
                try {
                  await apiRequest(`/api/publish-posts/${post.id}`, { method: 'DELETE' });
                  router.push('/publishing');
                } catch (e) {
                  toast.error('Could not delete the draft', (e as Error).message);
                  setBusy(null);
                }
              }}
            >
              Delete draft
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-charcoal-500">Published posts stay on Instagram and TikTok. To remove one, delete it in the app.</p>
        {post.history.length ? (
          <Card>
            <CardHeader title="History" />
            <CardBody>
              <ul className="space-y-1 text-sm text-charcoal-700">
                {post.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <span className="text-charcoal-500">{formatDateTime(h.at)}</span> · {h.label}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
