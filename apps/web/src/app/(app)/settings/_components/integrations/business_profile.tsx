'use client';

import { useState } from 'react';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { liveModeLabel } from '@/lib/shared/integration-types';
import type { IntegrationCardsProps } from './types';

/**
 * Settings → Integrations card of the Google Business Profile module (email design §4.8, website design §4.7): connect
 * through the shared Google sign-in (`product=business_profile`, scope `business.manage` only), "Check again" (read-only,
 * also how the owner learns that Google approved access), and disconnect with optional deletion of the stored reviews
 * and numbers. The location is chosen on the Reviews page, where the reviews are.
 */
export function BusinessProfileIntegrationCards({ integrations }: IntegrationCardsProps) {
  const toast = useToast();
  const gbp = integrations.find((i) => i.id === 'google_business_profile');
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  if (!gbp) return null;
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done, 'Reload this page in a moment to see the result.');
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const signedIn = gbp.state !== 'not_configured' && gbp.state !== 'not_connected';
  return (
    <Card>
      <CardHeader
        title="Google Business Profile"
        description="Optional. Lists your Google reviews on the Reviews page and your listing's numbers on the Website page. Review requests work without it."
        actions={<StatusPill status={gbp.pillStatus ?? gbp.state ?? 'not_configured'} label={gbp.stateLabel} />}
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-charcoal-600 [overflow-wrap:anywhere]">{gbp.message}</p>
        {gbp.detail ? <p className="text-xs text-charcoal-500 [overflow-wrap:anywhere]">Location: {gbp.detail}</p> : null}
        <p className="text-xs text-charcoal-500">
          Read-only: Studio Assistant can&apos;t change, reply to or remove anything on Google.{gbp.liveMode ? ` ${liveModeLabel(gbp.liveMode)}.` : ''}
        </p>
        {gbp.configured ? (
          <div className="flex flex-wrap items-center gap-2">
            {!signedIn || gbp.state === 'needs_reauth' ? (
              <a href="/api/integrations/google/connect?product=business_profile" className={buttonClasses('primary', 'md', 'min-h-11')}>
                {gbp.state === 'needs_reauth' ? 'Reconnect' : 'Connect Business Profile'}
              </a>
            ) : null}
            {signedIn && gbp.stateLabel === 'Choose location' ? (
              <a href="/reviews?tab=google" className={buttonClasses('primary', 'md', 'min-h-11')}>
                Choose location
              </a>
            ) : null}
            {signedIn && gbp.state !== 'needs_reauth' ? (
              <Button
                variant="secondary"
                className="min-h-11"
                loading={busy === 'check'}
                onClick={() => void act('check', () => apiRequest('/api/integrations/google-business-profile/check', { method: 'POST', body: {} }), 'Checking (read-only)')}
              >
                Check again
              </Button>
            ) : null}
            {signedIn ? (
              <>
                <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal-700">
                  <input type="checkbox" className="size-5" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
                  Also delete stored Google reviews and numbers
                </label>
                <Button
                  variant="ghost"
                  className="min-h-11"
                  loading={busy === 'off'}
                  onClick={() =>
                    void act('off', () => apiRequest(`/api/integrations/google-business-profile?deleteData=${deleteData ? 'true' : 'false'}`, { method: 'DELETE' }), 'Business Profile disconnected')
                  }
                >
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
