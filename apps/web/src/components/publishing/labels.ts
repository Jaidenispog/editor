import type { PostStatus, PublishMethod, TargetStatus } from '@studio/core';

/** Words the publishing pages use for statuses (design §9.4: plain words; "Your turn", "Posted"). */
export const TARGET_LABELS: Record<TargetStatus, string> = {
  queued: 'Queued',
  processing: 'Processing',
  published: 'Posted',
  failed: 'Failed',
  manual_step_required: 'Your turn',
  cancelled: 'Cancelled',
};

export const POST_LABELS: Record<PostStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  in_progress: 'In progress',
  complete: 'Complete',
  partial: 'Partly posted',
  failed: 'Not posted',
  cancelled: 'Cancelled',
};

export const METHOD_LABELS: Record<PublishMethod, string> = {
  manual: 'Post it yourself',
  instagram_api: 'Publish from Studio Assistant',
  zernio: 'Publish via Zernio',
};

/** The composer's and cards' words for one way of posting (Zernio drafts and first verification posts included). */
export function methodLabel(method: PublishMethod, delivery: 'publish' | 'draft' | undefined, isVerification: boolean): string {
  if (method === 'zernio') {
    const base = delivery === 'draft' ? 'Send to TikTok drafts via Zernio' : 'Publish via Zernio';
    return isVerification ? `First verification post (${base.charAt(0).toLowerCase()}${base.slice(1)})` : base;
  }
  return isVerification ? 'First verification post (publish from Studio Assistant)' : METHOD_LABELS[method];
}

/**
 * The warning on a first verification post (composer, review step and the destination card): a Zernio draft goes to
 * the TikTok inbox and is not public, everything else is a real, public post.
 */
export function verificationNotice(method: PublishMethod, delivery: 'publish' | 'draft' | undefined, handle: string): string {
  return method === 'zernio' && delivery === 'draft' ? `This sends a real draft to the TikTok inbox of ${handle}.` : `This is a real, public post on ${handle}.`;
}

/** Numbered manual steps per platform (design §4.4). */
export const MANUAL_STEPS_TEXT = {
  instagram: ['Open Instagram and tap +', 'Choose Reel, then the video you downloaded', "Cover: pick the frame, or 'Add from camera roll' with the cover image", 'Paste the caption', 'Tap Share'],
  tiktok: ['Open TikTok and tap +', 'Tap Upload and choose the video', 'Sounds: add a Commercial Sound if you want music', 'Paste the caption', 'Tap Post'],
} as const;

/** "1.2 MB" style size. */
export function sizeLabel(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
