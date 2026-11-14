'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { GOOGLE_OAUTH_PRODUCTS, GoogleProductSchema } from '@studio/core';
import { IntegrationStatusList } from '@/components/app/integration-status-list';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { IntegrationStatus } from '@/lib/shared/integration-types';
import { BusinessProfileIntegrationCards } from './integrations/business_profile';
import { EmailIntegrationCards } from './integrations/email';
import { MusicIntegrationCards } from './integrations/music';
import { PreferencesIntegrationCards } from './integrations/preferences';
import { PublishingIntegrationCards } from './integrations/publishing';
import { SquareIntegrationCards } from './integrations/square';
import { TrendsIntegrationCards } from './integrations/trends';
import type { IntegrationCardsProps } from './integrations/types';
import { WebsiteIntegrationCards } from './integrations/website';

/** One component per module, in display order. Modules edit only their own `./integrations/<module>.tsx`. */
const MODULE_CARDS: ReadonlyArray<(props: IntegrationCardsProps) => ReactNode> = [
  MusicIntegrationCards,
  PreferencesIntegrationCards,
  TrendsIntegrationCards,
  PublishingIntegrationCards,
  SquareIntegrationCards,
  EmailIntegrationCards,
  WebsiteIntegrationCards,
  BusinessProfileIntegrationCards,
];

type Notice = { tone: 'success' | 'info' | 'danger'; text: string };

/** Reads the outcome a connect callback put in the address (e.g. after Google), then removes it from the address. */
function useConnectNotice(): Notice | null {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('google_error');
    const checking = GoogleProductSchema.safeParse(url.searchParams.get('checking'));
    const connected = GoogleProductSchema.safeParse(url.searchParams.get('connected'));
    let next: Notice | null = null;
    if (error) next = { tone: 'danger', text: error.slice(0, 300) };
    else if (checking.success) next = { tone: 'info', text: `${GOOGLE_OAUTH_PRODUCTS[checking.data].label} is connected. Checking your access now; this page updates when you reload it.` };
    else if (connected.success) next = { tone: 'success', text: `${GOOGLE_OAUTH_PRODUCTS[connected.data].label} is connected.` };
    if (!next) return;
    setNotice(next);
    for (const key of ['google_error', 'checking', 'connected']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.toString());
  }, []);
  return notice;
}

/** Integration status cards with the names of any missing server settings (values are never shown), plus module controls. */
export function IntegrationsTab({ integrations }: { integrations: IntegrationStatus[] }) {
  const notice = useConnectNotice();
  return (
    <div className="space-y-6">
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      <Card>
        <CardHeader
          title="Integrations"
          description="Server settings are added by whoever hosts the app (for example in the hosting dashboard or the .env file) and take effect after a restart. Secret values are never shown here."
        />
        <CardBody className="min-w-0 [overflow-wrap:anywhere]">
          {/* Setting names such as TRANSCRIPTION_PROVIDER=deepgram must wrap on a 390 px phone screen. */}
          <IntegrationStatusList integrations={integrations} showEnv />
        </CardBody>
      </Card>
      {MODULE_CARDS.map((Cards, i) => (
        <Cards key={i} integrations={integrations} />
      ))}
    </div>
  );
}
