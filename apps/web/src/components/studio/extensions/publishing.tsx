'use client';

import { Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonClasses } from '@/components/ui/button';
import { PublishBadges } from '@/components/publishing/publish-badges';
import { apiRequest } from '@/lib/client/api-client';
import type { PublishBadgeDto } from '@/lib/shared/publishing-dto';
import type { EditCardExtension, EditCardSlotProps } from './types';

/** One request per version and status, shared by every card that shows the same version. */
const requests = new Map<string, Promise<PublishBadgeDto[]>>();

function loadBadges(key: string, versionId: string): Promise<PublishBadgeDto[]> {
  let p = requests.get(key);
  if (!p) {
    p = apiRequest<{ badges: PublishBadgeDto[] }>(`/api/publishing/badges?versions=${encodeURIComponent(versionId)}`).then((r) => r.badges);
    requests.set(key, p);
    p.catch(() => requests.delete(key));
    if (requests.size > 200) requests.delete(requests.keys().next().value as string);
  }
  return p;
}

/** Per-platform badges under the version (data from this module's own API, not the Studio status DTO). */
function Badges({ version }: EditCardSlotProps) {
  const [badges, setBadges] = useState<PublishBadgeDto[]>([]);
  const ready = version?.status === 'preview_ready';
  const key = version ? `${version.id}:${version.exportStatus}` : '';
  useEffect(() => {
    if (!version || !ready) return;
    let live = true;
    loadBadges(key, version.id)
      .then((b) => live && setBadges(b))
      .catch(() => live && setBadges([]));
    return () => {
      live = false;
    };
  }, [key, ready, version]);
  if (!ready) return null;
  return <PublishBadges badges={badges} />;
}

/** "Publish…" next to Download once the preview is ready: opens the composer with only this version. */
function MenuItems({ version }: EditCardSlotProps) {
  if (!version || version.status !== 'preview_ready') return null;
  return (
    <Link href={`/publishing/new?versions=${encodeURIComponent(version.id)}`} className={buttonClasses('secondary', 'md', 'min-h-11')}>
      <Send className="size-4" aria-hidden="true" /> Publish…
    </Link>
  );
}

/** Edit-card menu items and badges of the publishing module (WP4; WP10 adds nothing here). */
export const publishingEditCardExtension: EditCardExtension = { id: 'publishing', Badges, MenuItems };
