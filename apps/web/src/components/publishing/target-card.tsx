'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { TARGET_PLATFORM_NAMES, formatDateTime, type ResolveAction } from '@studio/core';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { PublishPostDto, TargetDto } from '@/lib/shared/publishing-dto';
import { ConfirmPostedDialog } from './confirm-posted-dialog';
import { METHOD_LABELS, TARGET_LABELS } from './labels';
import { ManualSteps } from './manual-steps';

/**
 * One destination of a post: status pill, the plain message, the manual steps when it is the owner's turn, and the
 * actions the server allows for its state. A link is shown only when the platform returned it or the owner pasted
 * one. Owner-only actions are hidden from staff (the API refuses them anyway).
 */
export function TargetCard({ post, target, isOwner, onChanged }: { post: PublishPostDto; target: TargetDto; isOwner: boolean; onChanged: (post?: PublishPostDto) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const has = (a: TargetDto['actions'][number]) => target.actions.includes(a);
  const name = TARGET_PLATFORM_NAMES[target.platform];

  const run = async (key: string, path: string, body?: unknown, done?: string) => {
    setBusy(key);
    try {
      const next = await apiRequest<PublishPostDto>(path, { method: 'POST', body: body ?? {} });
      if (done) toast.success(done);
      onChanged(next);
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const verify = async (result: 'seen' | 'not_seen') => {
    setBusy(result);
    try {
      await apiRequest(`/api/social-accounts/${target.accountId}/verification`, { method: 'POST', body: { result, targetId: target.id } });
      toast.success(result === 'seen' ? 'Thanks. You can now switch on direct publishing in Settings → Integrations.' : 'Noted. Direct publishing stays off.');
      onChanged();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const resolve = (action: ResolveAction, done: string) => run(action, `/api/publish-targets/${target.id}/resolve`, { action }, done);

  const yourTurn = target.status === 'manual_step_required' && (target.manualStep === 'post_in_app' || target.manualStep === 'finish_in_tiktok_app');
  const showSteps = has('download') && (target.method === 'manual' || yourTurn);
  return (
    <div className="rounded-xl border border-charcoal-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-charcoal-900">
            {name} · {target.handle}
          </p>
          <p className="text-xs text-charcoal-500">
            {METHOD_LABELS[target.method]} · {target.variant === 'no_music' ? '1080×1920 MP4, without music' : '1080×1920 MP4, with the edit’s sound'}
            {target.isVerification ? ' · First verification post' : ''}
          </p>
        </div>
        <StatusPill status={target.status} label={target.status === 'published' && target.confirmedByName ? 'Posted (you confirmed)' : TARGET_LABELS[target.status]} />
      </div>
      {target.statusMessage ? <p className="mt-2 text-sm text-charcoal-700">{target.statusMessage}</p> : null}
      {target.status === 'published' ? (
        <p className="mt-1 text-sm text-charcoal-600">
          {target.publishedAt ? `Posted ${formatDateTime(target.publishedAt)}` : 'Posted'}
          {target.confirmedByName ? ` · confirmed by ${target.confirmedByName}` : ''}
          {target.publishedUrl ? (
            <>
              {' · '}
              <a href={target.publishedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
                View on {name} <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {target.isVerification && post.status !== 'draft' && target.status !== 'published' ? (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">This is a real, public post on {target.handle}.</p>
      ) : null}
      {target.awaitingVerificationAnswer && isOwner && target.accountId ? (
        <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-medium text-sky-900">Can you see the reel on {target.handle}?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button className="min-h-11" loading={busy === 'seen'} onClick={() => void verify('seen')}>
              Yes, it&apos;s there
            </Button>
            <Button variant="secondary" className="min-h-11" loading={busy === 'not_seen'} onClick={() => void verify('not_seen')}>
              No / something&apos;s wrong
            </Button>
          </div>
        </div>
      ) : null}
      {target.manualStep === 'reconnect_account' ? (
        <p className="mt-2 text-sm">
          <Link href="/settings?tab=integrations" className="font-medium text-charcoal-900 underline decoration-[var(--accent)] decoration-2 underline-offset-4">
            Reconnect {name} in Settings
          </Link>
        </p>
      ) : null}
      {showSteps ? (
        <div className="mt-3">
          <ManualSteps targetId={target.id} platform={target.platform} noMusic={target.variant === 'no_music'} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {has('confirm') ? (
          <Button className="min-h-11" variant={target.status === 'published' ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
            {target.status === 'published' ? 'Add the link' : target.manualStep === 'check_before_retry' ? "It's posted" : "I've posted it"}
          </Button>
        ) : null}
        {isOwner && has('retry_anyway') ? (
          <Button variant="secondary" className="min-h-11" loading={busy === 'retry_anyway'} onClick={() => void resolve('retry_anyway', 'Sending again')}>
            It&apos;s not there – try again
          </Button>
        ) : null}
        {isOwner && has('post_without_music') ? (
          <Button className="min-h-11" loading={busy === 'post_without_music'} onClick={() => void resolve('post_without_music', 'Preparing the version without music')}>
            Post without music
          </Button>
        ) : null}
        {isOwner && has('retry') ? (
          <Button className="min-h-11" loading={busy === 'retry'} onClick={() => void run('retry', `/api/publish-targets/${target.id}/retry`, {}, 'Trying again')}>
            Retry
          </Button>
        ) : null}
        {isOwner && has('post_manually') ? (
          <Button variant="secondary" className="min-h-11" loading={busy === 'post_manually'} onClick={() => void resolve('post_manually', 'Switched to "Post it yourself"')}>
            Post it yourself
          </Button>
        ) : null}
        {has('undo') ? (
          <Button variant="ghost" className="min-h-11" loading={busy === 'undo'} onClick={() => void run('undo', `/api/publish-targets/${target.id}/undo-confirm`, {}, 'Undone')}>
            Undo &quot;posted&quot;
          </Button>
        ) : null}
      </div>
      <ConfirmPostedDialog
        open={confirming}
        platform={target.platform}
        addingLink={target.status === 'published'}
        onClose={() => setConfirming(false)}
        onConfirm={async (url) => {
          await run('confirm', `/api/publish-targets/${target.id}/confirm-posted`, url ? { url } : {}, target.status === 'published' ? 'Link saved' : 'Marked as posted');
          setConfirming(false);
        }}
      />
    </div>
  );
}
