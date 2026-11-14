import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { listUserSessions } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { getIntegrationStatuses } from '@/lib/integrations';
import { maybeSignedUrl } from '@/lib/media-links';
import { listLibraryTracks } from '@/lib/music';
import { getCurrentSession } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { getStorageUsage } from '@/lib/storage-usage';
import { listTrends } from '@/lib/trends';
import { SettingsTabs } from './_components/settings-tabs';

export const metadata: Metadata = { title: 'Settings' };

/** Settings: branding, business, editing preferences, music, trends, integrations, security and storage. */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const params = await searchParams;
  const tab = typeof params['tab'] === 'string' ? params['tab'] : 'branding';
  const env = getEnv();
  const settings = await getSettings();
  const [integrations, tracks, trends, sessions, usage, logoUrl] = await Promise.all([
    getIntegrationStatuses(),
    listLibraryTracks(),
    listTrends(),
    listUserSessions(session.user.id),
    getStorageUsage(),
    maybeSignedUrl(settings.brand.logoStorageKey),
  ]);
  return (
    <>
      <PageHeader eyebrow="Settings" title="Settings" description="Your brand, business details and how edits are made. Changes apply to new edits straight away." />
      <SettingsTabs
        initialTab={tab}
        isOwner={session.user.role === 'owner'}
        settings={settings}
        logoUrl={logoUrl}
        integrations={integrations}
        tracks={tracks}
        trends={trends}
        user={session.user}
        sessions={sessions.map((s) => ({
          id: s.id,
          current: s.id === session.sessionId,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
        }))}
        storage={{ driver: env.STORAGE_DRIVER, usage, linkTtlMinutes: Math.round(env.MEDIA_LINK_TTL_SECONDS / 60), maxUploadBytes: env.MAX_UPLOAD_BYTES }}
      />
    </>
  );
}
