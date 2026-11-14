'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppSettings } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Tabs } from '@/components/ui/tabs';
import type { IntegrationStatus } from '@/lib/shared/integration-types';
import type { MusicTrackSummary } from '@/lib/music';
import type { TrendSummary } from '@/lib/trends';
import { BrandingTab } from './branding-tab';
import { BusinessTab } from './business-tab';
import { IntegrationsTab } from './integrations-tab';
import { MusicTab } from './music-tab';
import { PreferencesTab } from './preferences-tab';
import { SecurityTab, type SessionRow } from './security-tab';
import { StorageTab, type StorageInfo } from './storage-tab';
import { TrendsTab } from './trends-tab';

const TAB_IDS = ['branding', 'business', 'preferences', 'music', 'trends', 'integrations', 'security', 'storage'] as const;

/** Client-side settings tabs; the active tab is mirrored in ?tab= so links can open a specific tab. */
export function SettingsTabs(props: {
  initialTab: string;
  isOwner: boolean;
  settings: AppSettings;
  logoUrl: string | null;
  integrations: IntegrationStatus[];
  tracks: MusicTrackSummary[];
  trends: TrendSummary[];
  user: { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
  sessions: SessionRow[];
  storage: StorageInfo;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState((TAB_IDS as readonly string[]).includes(props.initialTab) ? props.initialTab : 'branding');
  const ownerOnly = !props.isOwner ? <Alert tone="info" className="mb-6">Only the studio owner can change these settings. You can still view them.</Alert> : null;

  const onChange = (id: string) => {
    setTab(id);
    router.replace(`${pathname}?tab=${id}`, { scroll: false });
  };

  return (
    <Tabs
      label="Settings sections"
      value={tab}
      onValueChange={onChange}
      items={[
        { id: 'branding', label: 'Branding', content: <>{ownerOnly}<BrandingTab brand={props.settings.brand} logoUrl={props.logoUrl} disabled={!props.isOwner} /></> },
        { id: 'business', label: 'Business', content: <>{ownerOnly}<BusinessTab business={props.settings.business} disabled={!props.isOwner} /></> },
        { id: 'preferences', label: 'Editing preferences', content: <>{ownerOnly}<PreferencesTab preferences={props.settings.preferences} disabled={!props.isOwner} /></> },
        { id: 'music', label: 'Music library', content: <MusicTab tracks={props.tracks} /> },
        { id: 'trends', label: 'Trends & references', content: <TrendsTab trends={props.trends} disabled={!props.isOwner} /> },
        { id: 'integrations', label: 'Integrations', content: <IntegrationsTab integrations={props.integrations} /> },
        { id: 'security', label: 'Users & security', content: <SecurityTab user={props.user} sessions={props.sessions} /> },
        { id: 'storage', label: 'Storage & data', content: <StorageTab storage={props.storage} /> },
      ]}
    />
  );
}
