'use client';

import { Copy, Download, ImageDown, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TargetPlatform } from '@studio/core';
import { Button, buttonClasses } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { TargetMediaDto } from '@/lib/shared/publishing-dto';
import { MANUAL_STEPS_TEXT, sizeLabel } from './labels';

/**
 * Everything the owner needs to post one destination by hand, built for a phone: download (an expiring link to the
 * exact file), Share… (Web Share with the file where the browser supports it), copy caption, the cover image for
 * Instagram, and the numbered steps. When the file has no music, the music step is highlighted.
 */
export function ManualSteps({ targetId, platform, noMusic }: { targetId: string; platform: TargetPlatform; noMusic: boolean }) {
  const toast = useToast();
  const [media, setMedia] = useState<TargetMediaDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    let live = true;
    apiRequest<TargetMediaDto>(`/api/publish-targets/${targetId}/media`)
      .then((m) => live && setMedia(m))
      .catch((e: Error) => live && setError(e.message));
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.canShare === 'function');
    return () => {
      live = false;
    };
  }, [targetId]);

  const share = async () => {
    if (!media) return;
    setSharing(true);
    try {
      const blob = await (await fetch(media.videoUrl)).blob();
      const file = new File([blob], media.videoFilename, { type: 'video/mp4' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: media.caption });
      else toast.error('Sharing a video is not supported in this browser', 'Use Download instead.');
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast.error('The video could not be shared', 'Use Download instead.');
    } finally {
      setSharing(false);
    }
  };

  const steps = MANUAL_STEPS_TEXT[platform];
  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {media?.label ? <p className="text-sm font-medium text-amber-800">{media.label}</p> : null}
      <div className="flex flex-wrap gap-2">
        {media ? (
          <a href={media.videoUrl} download={media.videoFilename} className={buttonClasses('primary', 'md', 'min-h-11')}>
            <Download className="size-4" aria-hidden="true" /> {media.label ? 'Download (for Instagram/Facebook upload only)' : 'Download video'}
            {media.byteSize ? ` (${sizeLabel(media.byteSize)})` : ''}
          </a>
        ) : (
          <Button className="min-h-11" disabled>
            <Download className="size-4" aria-hidden="true" /> Getting the link…
          </Button>
        )}
        {canShare && media ? (
          <Button variant="secondary" className="min-h-11" onClick={() => void share()} loading={sharing}>
            <Share2 className="size-4" aria-hidden="true" /> {sharing ? `Getting video ready${media.byteSize ? ` (${sizeLabel(media.byteSize)})` : ''}…` : 'Share…'}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          className="min-h-11"
          disabled={!media}
          onClick={() => {
            if (!media) return;
            void navigator.clipboard.writeText(media.caption).then(
              () => toast.success('Caption copied'),
              () => toast.error('The caption could not be copied', 'Select it in the post details and copy it by hand.'),
            );
          }}
        >
          <Copy className="size-4" aria-hidden="true" /> Copy caption
        </Button>
        {platform === 'instagram' && media?.coverUrl ? (
          <a href={media.coverUrl} download className={buttonClasses('secondary', 'md', 'min-h-11')}>
            <ImageDown className="size-4" aria-hidden="true" /> Download cover image
          </a>
        ) : null}
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-charcoal-700">
        {steps.map((s) => (
          <li key={s} className={noMusic && /Sound|music/i.test(s) ? 'font-semibold text-charcoal-900' : undefined}>
            {s}
          </li>
        ))}
        {platform === 'instagram' && noMusic ? <li className="font-semibold text-charcoal-900">This file has no music: add music in the Instagram app if you want it</li> : null}
        <li>Come back here and tap &quot;I&apos;ve posted it&quot;</li>
      </ol>
    </div>
  );
}
