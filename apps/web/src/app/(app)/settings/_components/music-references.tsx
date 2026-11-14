'use client';

import { ExternalLink, Link2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { MusicReferenceDto, MusicReferencesDto } from '@/lib/shared/studio-dto';

const TYPE_LABEL: Record<MusicReferenceDto['itemType'], string> = { track: 'Track', album: 'Album', playlist: 'Playlist', artist: 'Artist' };

/**
 * Settings → Music → "Music references": private Spotify links with the owner's notes (memo §1). Link-only by
 * default: no iframe and no request to Spotify. The official player is shown only once embed mode is switched on
 * and everything it needs exists; going back to link-only is one click.
 */
export function MusicReferences() {
  const toast = useToast();
  const [data, setData] = useState<MusicReferencesDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<MusicReferencesDto>('/api/music/references'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Music references could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      await apiRequest('/api/music/references', { method: 'POST', body: { url, notes } });
      setUrl('');
      setNotes('');
      toast.success('Reference saved');
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'The link could not be saved.');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (ref: MusicReferenceDto) => {
    try {
      await apiRequest(`/api/music/references/${ref.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toast.error('Not removed', err instanceof Error ? err.message : undefined);
    }
  };

  const setMode = async (mode: 'link_only' | 'embed') => {
    setSwitching(true);
    try {
      setData(await apiRequest<MusicReferencesDto>('/api/music/references/mode', { method: 'PUT', body: { mode, ...(mode === 'embed' && ack ? { acknowledgeSpotifyTerms: true } : {}) } }));
      toast.success(mode === 'embed' ? 'Spotify player switched on' : 'Showing links only');
    } catch (err) {
      toast.error('Not changed', err instanceof Error ? err.message : undefined);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Music references" description="Spotify links for your own reference, such as the vibe you want for fade videos." />
      <CardBody className="space-y-4">
        <Alert tone="info">{data?.notice ?? 'Spotify links are kept for your own music reference only. They are not licensed for playing in the shop or in your videos.'}</Alert>
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
          <Input label="Spotify link" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} placeholder="https://open.spotify.com/track/…" error={addError ?? undefined} />
          <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="e.g. vibe for fade videos" />
          <Button type="submit" loading={adding} disabled={!url.trim()}>
            <Link2 className="size-4" aria-hidden="true" /> Save link
          </Button>
        </form>
        {loadError ? <Alert tone="danger">{loadError}</Alert> : null}
        {!data && !loadError ? <Skeleton className="h-16 w-full" /> : null}
        {data && data.references.length === 0 ? <EmptyState title="No references yet" description="Paste a Spotify track, album, playlist or artist link to keep it here." /> : null}
        {data && data.references.length > 0 ? (
          <ul className="divide-y divide-charcoal-100">
            {data.references.map((r) => (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{TYPE_LABEL[r.itemType]}</Badge>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-charcoal-900 underline decoration-[var(--accent)] underline-offset-4">
                    Open in Spotify <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                  <span className="text-xs text-charcoal-500">Spotify</span>
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void remove(r)} aria-label="Remove this reference">
                    <Trash2 className="size-4" aria-hidden="true" /> Remove
                  </Button>
                </div>
                {r.notes ? <p className="text-sm text-charcoal-700">{r.notes}</p> : null}
                {r.embedUrl ? (
                  <iframe
                    title={`Spotify ${TYPE_LABEL[r.itemType].toLowerCase()}`}
                    src={r.embedUrl}
                    loading="lazy"
                    className="h-[152px] w-full rounded-xl border-0"
                    allow="encrypted-media"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {data ? (
          <div className="rounded-lg border border-charcoal-200 p-3 text-sm">
            <p className="font-medium text-charcoal-900">{data.mode === 'embed' ? 'Showing the Spotify player' : 'Showing links only'}</p>
            {data.mode === 'embed' ? (
              <Button variant="secondary" size="sm" className="mt-2" loading={switching} onClick={() => void setMode('link_only')}>
                Show links only
              </Button>
            ) : (
              <div className="mt-2 space-y-2">
                <p className="text-charcoal-600">The official Spotify player can be shown on these private pages once your terms of use and privacy policy pages exist.</p>
                {data.missing.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-charcoal-600">
                    {data.missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                ) : null}
                {!data.termsAcknowledged ? (
                  <label className="flex min-h-11 items-center gap-2 text-charcoal-700">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    I have read Spotify&apos;s Developer Terms and Widget Terms
                  </label>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  loading={switching}
                  disabled={data.missing.some((m) => !m.startsWith('Your confirmation')) || (!data.termsAcknowledged && !ack)}
                  onClick={() => void setMode('embed')}
                >
                  Show the Spotify player
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
