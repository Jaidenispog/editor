'use client';

import { Music, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { formatBytes, formatSeconds } from '@/lib/format';
import type { MusicTrackSummary } from '@/lib/music';

const LICENCE_KIND: Record<string, string> = {
  owner_upload: 'Your own upload',
  catalogue: 'Music catalogue',
  commercial_licence: 'Commercial licence',
  cc0: 'CC0 (no rights reserved)',
  cc_by: 'Creative Commons with attribution',
  public_domain: 'Public domain',
  unknown: 'Unknown source',
};

/** Music library: each track with its licence status. Uploading arrives with the Video Studio interface. */
export function MusicTab({ tracks }: { tracks: MusicTrackSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState<MusicTrackSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiRequest(`/api/music/${confirmDelete.id}`, { method: 'DELETE' });
      toast.success('Track removed');
      setConfirmDelete(null);
      router.refresh();
    } catch (err) {
      toast.error('Track not removed', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Music library"
        description="Tracks you have the rights to use. Uploading music, with a short licence form, arrives together with the Video Studio upload screen."
      />
      <CardBody>
        {tracks.length === 0 ? (
          <EmptyState icon={<Music />} title="No music yet" description="Your music library is empty. Edits can still use the original sound from your clips." />
        ) : (
          <ul className="divide-y divide-charcoal-100">
            {tracks.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{t.title}</p>
                    <StatusPill status={t.status} />
                  </div>
                  <p className="mt-0.5 text-sm text-charcoal-500">
                    {[t.artist || null, t.durationSec ? formatSeconds(t.durationSec) : null, t.bpm ? `${Math.round(t.bpm)} BPM` : null, formatBytes(t.byteSize)].filter(Boolean).join(' · ')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={t.licenceConfirmed ? 'success' : 'warning'}>{t.licenceConfirmed ? 'Licence confirmed' : 'Licence not confirmed'}</Badge>
                    <Badge>{LICENCE_KIND[t.licence.kind] ?? t.licence.kind}</Badge>
                    {t.licence.permitted.instagram ? <Badge tone="info">Instagram</Badge> : null}
                    {t.licence.permitted.tiktok ? <Badge tone="info">TikTok</Badge> : null}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(t)} aria-label={`Remove ${t.title}`}>
                  <Trash2 className="size-4" aria-hidden="true" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Remove this track?"
        description="The audio file is deleted. Edits already rendered keep their sound, but new edits cannot use this track."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={remove} loading={deleting}>
              Remove track
            </Button>
          </>
        }
      />
    </Card>
  );
}
