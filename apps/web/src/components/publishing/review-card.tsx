import { TARGET_PLATFORM_NAMES, formatSeconds } from '@studio/core';
import type { PublishPostDto } from '@/lib/shared/publishing-dto';
import { methodLabel, verificationNotice } from './labels';

/**
 * The review step's summary of one saved draft, per destination: account, method, the exact file, the final caption
 * with its credit line, the cover time and when it goes. Verification posts carry the "real, public post" warning.
 */
export function ReviewCard({ post }: { post: PublishPostDto }) {
  return (
    <div className="space-y-3 rounded-xl border border-charcoal-200 bg-white p-4">
      <p className="text-sm font-semibold text-charcoal-900">
        {post.projectTitle} · {post.styleName}
        {post.versionNo ? ` · version ${post.versionNo}` : ''}
      </p>
      <ul className="space-y-2">
        {post.targets.map((t) => (
          <li key={t.id} className="rounded-lg bg-charcoal-50 p-3 text-sm">
            <p className="font-medium text-charcoal-900">
              {TARGET_PLATFORM_NAMES[t.platform]} · {t.handle}
            </p>
            <p className="text-charcoal-700">
              {methodLabel(t.method, t.delivery, t.isVerification)} · 1080×1920 MP4, {t.variant === 'no_music' ? 'without music' : 'with the edit’s sound'}
            </p>
            {t.isVerification ? (
              <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                {verificationNotice(t.method, t.delivery, t.handle)} Choose an edit you&apos;re happy to share.
              </p>
            ) : null}
            {t.method === 'zernio' && t.delivery === 'publish' ? <p className="mt-1 text-charcoal-700">Public immediately on TikTok. Cover at the frame you chose.</p> : null}
            {t.method === 'zernio' && t.delivery === 'draft' ? <p className="mt-1 text-charcoal-700">Choose the cover in the TikTok app.</p> : null}
          </li>
        ))}
      </ul>
      <div>
        <p className="text-xs font-medium text-charcoal-500">Final caption</p>
        <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm text-charcoal-800">{post.caption || 'No caption'}</p>
      </div>
      <p className="text-sm text-charcoal-700">
        Cover at {formatSeconds(post.coverTimeSec ?? 0)} ·{' '}
        {post.mode === 'scheduled' && post.scheduledForLabel ? `Scheduled for ${post.scheduledForLabel}` : post.mode === 'draft_handoff' ? 'Prepared for you to post' : 'Posts as soon as the video is ready'}
      </p>
    </div>
  );
}
