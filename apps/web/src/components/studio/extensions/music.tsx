'use client';

import { Copy, Download, Music2, VolumeX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { VersionMusicDto } from '@/lib/shared/studio-dto';
import { SoundPanel } from '../sound-panel';
import type { EditCardExtension, EditCardSlotProps } from './types';

/** How often a card checks on its music-free version while it is being made. */
const VARIANT_POLL_MS = 4000;

/** One in-flight request per version state, shared by the card's banner and menu items. */
const requests = new Map<string, Promise<VersionMusicDto>>();

function loadVersionMusic(key: string, versionId: string): Promise<VersionMusicDto> {
  let p = requests.get(key);
  if (!p) {
    p = apiRequest<VersionMusicDto>(`/api/music/versions/${versionId}`);
    requests.set(key, p);
    p.catch(() => requests.delete(key));
    if (requests.size > 200) requests.delete(requests.keys().next().value as string);
  }
  return p;
}

/** The music facts of the card's version, refreshed when the version's state changes and while the music-free file is made. */
function useVersionMusic(props: EditCardSlotProps): { music: VersionMusicDto | null; refresh: () => void } {
  const { version } = props;
  const [music, setMusic] = useState<VersionMusicDto | null>(null);
  const [tick, setTick] = useState(0);
  const ready = version?.status === 'preview_ready';
  const key = version ? `${version.id}:${version.status}:${version.exportStatus}:${tick}` : '';
  useEffect(() => {
    if (!version || !ready) return;
    let alive = true;
    loadVersionMusic(key, version.id)
      .then((m) => alive && setMusic(m))
      .catch(() => alive && setMusic(null));
    return () => {
      alive = false;
    };
  }, [key, ready, version]);
  const making = music?.noMusicExport.status === 'queued' || music?.noMusicExport.status === 'rendering';
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => setTick((t) => t + 1), VARIANT_POLL_MS);
    return () => clearInterval(timer);
  }, [making]);
  return { music: ready && music?.versionId === version?.id ? music : null, refresh: () => setTick((t) => t + 1) };
}

async function saveLink(versionId: string, kind: 'export_no_music'): Promise<void> {
  const res = await apiRequest<{ url: string; filename: string }>(`/api/edit-versions/${versionId}/download?kind=${kind}`);
  const a = document.createElement('a');
  a.href = res.url;
  a.download = res.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "Make a music-free version" (the `no_music` export of the same version) and its progress or download. */
function MusicFreeButton({ props, music, refresh }: { props: EditCardSlotProps; music: VersionMusicDto; refresh: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const versionId = music.versionId;
  const state = music.noMusicExport;
  if (!music.sound.hasMusic) return null;
  if (state.status === 'queued' || state.status === 'rendering') {
    return (
      <span className="inline-flex min-h-9 items-center gap-2 text-sm text-charcoal-600" aria-live="polite">
        <Spinner className="size-4" /> Making the music-free version…
      </span>
    );
  }
  if (state.status === 'ready') {
    return (
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await saveLink(versionId, 'export_no_music');
          } catch (err) {
            toast.error('Could not download', err instanceof Error ? err.message : undefined);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download className="size-4" aria-hidden="true" /> Music-free version
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await apiRequest(`/api/edit-versions/${versionId}/export?variant=no_music`, { method: 'POST' });
          toast.success('Making a music-free version', 'Same cuts, text and colour, without the music. Add sound in the Instagram or TikTok app if you want it.');
          refresh();
          props.onChanged({ expectBusy: true });
        } catch (err) {
          toast.error('Could not start the music-free version', err instanceof Error ? err.message : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      <VolumeX className="size-4" aria-hidden="true" /> Make a music-free version
    </Button>
  );
}

/** Licence and clearance notes on a card: previews only, Meta-only label, the cleared platforms and the CC BY credit. */
function MusicBanner(props: EditCardSlotProps) {
  const toast = useToast();
  const { music, refresh } = useVersionMusic(props);
  if (!music || !music.sound.hasMusic) return null;
  const c = music.clearance;
  const failed = music.noMusicExport.status === 'failed' ? <p className="mt-1 text-xs text-red-700">{music.noMusicExport.message || 'The music-free version did not finish. Try again.'}</p> : null;
  if (c.state === 'blocked') {
    const unconfirmed = music.track?.licenceState === 'not_confirmed';
    return (
      <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <p className="font-medium">{unconfirmed ? 'Music licence not confirmed — previews only' : "This version's music isn't cleared for business use"}</p>
        <p className="mt-0.5">{c.reasons[0]} Make a music-free version, or confirm the licence in Settings → Music.</p>
        <div className="mt-2">
          <MusicFreeButton props={props} music={music} refresh={refresh} />
        </div>
        {failed}
      </div>
    );
  }
  return (
    <div className="rounded-md bg-charcoal-50 px-3 py-2 text-xs text-charcoal-700">
      {c.state === 'restricted' ? <p className="font-medium text-charcoal-900">{music.downloadLabel}</p> : null}
      <p>{music.clearanceSummary.replace(` ${music.downloadLabel ?? '§'}.`, '')}</p>
      {c.attributionText ? (
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <span>Credit to paste in your caption: {c.attributionText}</span>
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1 rounded border border-charcoal-200 bg-white px-2 text-charcoal-800 hover:bg-charcoal-100"
            onClick={() => {
              void navigator.clipboard?.writeText(c.attributionText ?? '').then(
                () => toast.success('Credit copied'),
                () => toast.error('Could not copy', 'Select the text and copy it instead.'),
              );
            }}
          >
            <Copy className="size-3.5" aria-hidden="true" /> Copy
          </button>
        </p>
      ) : null}
      {failed}
    </div>
  );
}

/** Card actions: the Sound panel and the music-free version. */
function MusicMenuItems(props: EditCardSlotProps) {
  const { music, refresh } = useVersionMusic(props);
  const [open, setOpen] = useState(false);
  const version = props.version;
  if (!version || version.status !== 'preview_ready') return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Music2 className="size-4" aria-hidden="true" /> Sound
      </Button>
      {music && music.clearance.state !== 'blocked' ? <MusicFreeButton props={props} music={music} refresh={refresh} /> : null}
      {open ? (
        <SoundPanel
          editId={props.edit.id}
          editName={props.edit.styleName}
          versionId={version.id}
          open={open}
          onClose={() => setOpen(false)}
          onDone={() => props.onChanged({ expectBusy: true })}
        />
      ) : null}
    </>
  );
}

/** Edit-card menu items and banner of the music controls and licence passport module. */
export const musicEditCardExtension: EditCardExtension = { id: 'music', Banner: MusicBanner, MenuItems: MusicMenuItems };
