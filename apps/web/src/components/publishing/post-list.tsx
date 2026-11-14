'use client';

import { ExternalLink, Send } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TARGET_PLATFORM_NAMES } from '@studio/core';
import { buttonClasses } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { Tabs } from '@/components/ui/tabs';
import { apiRequest } from '@/lib/client/api-client';
import type { PublishPostDto, PublishPostListDto } from '@/lib/shared/publishing-dto';
import { POST_LABELS, TARGET_LABELS } from './labels';
import { TargetCard } from './target-card';

/** How often the list refreshes while anything is still moving (same pattern as the Studio's status polling). */
const POLL_MS = 5000;

function isActive(p: PublishPostDto): boolean {
  return p.targets.some((t) => t.status === 'queued' || t.status === 'processing');
}

/** One post as a compact card: thumbnail, project and style, caption excerpt, time and one pill per platform. */
function PostSummary({ post }: { post: PublishPostDto }) {
  return (
    <Card className="overflow-hidden">
      <Link href={`/publishing/${post.id}`} className="flex gap-3 p-3 hover:bg-charcoal-50">
        <div className="aspect-[9/16] w-16 shrink-0 overflow-hidden rounded-md bg-charcoal-950">
          {post.coverUrl ? <img src={post.coverUrl} alt="" className="size-full object-cover" /> : null}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-charcoal-900">
              {post.projectTitle} · {post.styleName}
            </p>
            <StatusPill status={post.status} label={POST_LABELS[post.status]} />
          </div>
          <p className="line-clamp-2 text-sm text-charcoal-600">{post.caption || 'No caption'}</p>
          <p className="text-xs text-charcoal-500">{post.mode === 'scheduled' && post.scheduledForLabel ? post.scheduledForLabel : post.mode === 'draft_handoff' ? 'Prepared for manual posting' : 'Post now'}</p>
          <ul className="flex flex-wrap gap-1.5">
            {post.targets.map((t) => (
              <li key={t.id} className="flex items-center gap-1">
                <StatusPill status={t.status} label={`${TARGET_PLATFORM_NAMES[t.platform]} · ${TARGET_LABELS[t.status]}`} />
                {t.publishedUrl ? <ExternalLink className="size-3.5 text-charcoal-500" aria-label="Has a link" /> : null}
              </li>
            ))}
          </ul>
        </div>
      </Link>
    </Card>
  );
}

/**
 * The Publishing page's live list: "Your turn" (destinations waiting for the owner, with their actions), then tabs
 * for upcoming/in-progress posts and history. Refreshes every 5 s while anything is queued or processing.
 */
export function PostList({ initialQueue, initialHistory, isOwner }: { initialQueue: PublishPostDto[]; initialHistory: PublishPostDto[]; isOwner: boolean }) {
  const [queue, setQueue] = useState(initialQueue);
  const [history, setHistory] = useState(initialHistory);
  const refresh = useCallback(async () => {
    const [q, h] = await Promise.all([apiRequest<PublishPostListDto>('/api/publish-posts?view=queue'), apiRequest<PublishPostListDto>('/api/publish-posts?view=history')]);
    setQueue(q.posts);
    setHistory(h.posts);
  }, []);
  const active = queue.some(isActive);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const yourTurn = queue.flatMap((p) => p.targets.filter((t) => t.status === 'manual_step_required').map((t) => ({ post: p, target: t })));
  if (queue.length === 0 && history.length === 0) {
    return (
      <EmptyState
        icon={<Send />}
        title="Nothing to post yet"
        description="Open an edit in the Video Studio or the Content Library and choose Publish."
        action={
          <Link href="/library" className={buttonClasses('primary', 'md', 'min-h-11')}>
            Go to the Content Library
          </Link>
        }
      />
    );
  }
  return (
    <div className="space-y-6">
      {yourTurn.length ? (
        <section aria-labelledby="your-turn" className="space-y-3">
          <h2 id="your-turn" className="text-base font-semibold text-charcoal-900">
            Your turn ({yourTurn.length})
          </h2>
          {yourTurn.map(({ post, target }) => (
            <div key={target.id} className="space-y-1">
              <Link href={`/publishing/${post.id}`} className="text-xs font-medium text-charcoal-600 hover:underline">
                {post.projectTitle} · {post.styleName}
              </Link>
              <TargetCard post={post} target={target} isOwner={isOwner} onChanged={() => void refresh()} />
            </div>
          ))}
        </section>
      ) : null}
      <Tabs
        label="Posts"
        items={[
          {
            id: 'upcoming',
            label: `Upcoming and in progress (${queue.length})`,
            content: queue.length ? (
              <ul className="grid gap-3 lg:grid-cols-2">
                {queue.map((p) => (
                  <li key={p.id}>
                    <PostSummary post={p} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-charcoal-600">Nothing waiting.</p>
            ),
          },
          {
            id: 'history',
            label: `History (${history.length})`,
            content: history.length ? (
              <ul className="grid gap-3 lg:grid-cols-2">
                {history.map((p) => (
                  <li key={p.id}>
                    <PostSummary post={p} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-charcoal-600">No finished posts yet.</p>
            ),
          },
        ]}
      />
    </div>
  );
}
