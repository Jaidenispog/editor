'use client';

import Link from 'next/link';
import { useState } from 'react';
import { integrationPill } from '@/components/app/integration-pill';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { IntegrationCardsProps } from './types';

/**
 * Settings → Integrations controls for email (design §4.1): the read-only Postmark check ("no email is sent") and a
 * link to the Reviews page for the Google rating. The server owner adds the Postmark settings; nothing here sends.
 */
export function EmailIntegrationCards({ integrations }: IntegrationCardsProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const postmark = integrations.find((i) => i.id === 'postmark');
  const places = integrations.find((i) => i.id === 'google_places');
  if (!postmark) return null;
  const pill = integrationPill(postmark);
  const placesPill = places ? integrationPill(places) : null;
  return (
    <Card>
      <CardHeader title="Email and Google rating" description="Postmark sends approved emails. Checking the connection only reads your Postmark settings; no email is sent." />
      <CardBody className="space-y-5">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-charcoal-900">Email (Postmark)</h3>
            <StatusPill status={pill.status} label={pill.label} />
          </div>
          <p className="text-sm text-charcoal-600">{postmark.message}</p>
          <div className="flex flex-wrap gap-2">
            {postmark.configured ? (
              <Button
                variant="secondary"
                className="min-h-11"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await apiRequest('/api/email/check', { method: 'POST' });
                    toast.success('Checking Postmark', 'This only reads your settings. Reload in a moment to see the result.');
                  } catch (e) {
                    toast.error('Could not start the check', (e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Check connection
              </Button>
            ) : null}
            <Link href="/emails?tab=automations" className={buttonClasses('ghost', 'md', 'min-h-11')}>
              Email settings
            </Link>
          </div>
        </div>
        {places && placesPill ? (
          <div className="space-y-2 border-t border-charcoal-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-charcoal-900">{places.name}</h3>
              <StatusPill status={placesPill.status} label={placesPill.label} />
            </div>
            <p className="text-sm text-charcoal-600">{places.message}</p>
            <Link href="/reviews" className={buttonClasses('ghost', 'md', 'min-h-11')}>
              Open Reviews
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
