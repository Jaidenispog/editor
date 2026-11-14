'use client';

import { useState } from 'react';
import { validatePostLink, type TargetPlatform } from '@studio/core';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';

/**
 * "I've posted it": an optional link to the post (checked against the platform's real link pattern before it is
 * sent). Without a link the destination reads "Posted (you confirmed)".
 */
export function ConfirmPostedDialog({
  open,
  platform,
  addingLink,
  onClose,
  onConfirm,
}: {
  open: boolean;
  platform: TargetPlatform;
  /** Only adding a link to a post that is already marked as posted. */
  addingLink?: boolean;
  onClose: () => void;
  onConfirm: (url: string | undefined) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = url.trim();
  const invalid = trimmed !== '' && !validatePostLink(platform, trimmed);
  const example = platform === 'instagram' ? 'https://www.instagram.com/reel/…' : 'https://www.tiktok.com/@you/video/…';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={addingLink ? 'Add the link to the post' : "I've posted it"}
      description={addingLink ? 'Paste the link so it shows here.' : 'Pasting the link is optional. Without it, the post shows as "Posted (you confirmed)".'}
      footer={
        <>
          <Button variant="secondary" className="min-h-11" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button
            className="min-h-11"
            loading={busy}
            disabled={invalid || (addingLink && !trimmed)}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(trimmed || undefined);
                setUrl('');
              } finally {
                setBusy(false);
              }
            }}
          >
            {addingLink ? 'Save link' : 'Mark as posted'}
          </Button>
        </>
      }
    >
      <Input label="Link to the post (optional)" placeholder={example} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="off" error={invalid ? `That doesn't look like a link to a ${platform === 'instagram' ? 'reel or post on Instagram' : 'TikTok video'}.` : null} />
    </Dialog>
  );
}
