'use client';

import { useEffect, useState } from 'react';
import { WEBSITE_PLATFORM_NAMES, type PlatformHint } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import { liveModeLabel, type IntegrationStatus } from '@/lib/shared/integration-types';
import type { IntegrationCardsProps } from './types';

function Pill({ status }: { status: IntegrationStatus | undefined }) {
  return <StatusPill status={status?.pillStatus ?? status?.state ?? 'not_configured'} label={status?.stateLabel} />;
}

/**
 * Settings → Integrations cards of the website module (design §4.7): Google Search Console (read-only; connect,
 * check, disconnect with optional deletion of stored numbers) and Website editing through WordPress (Application
 * Password, saved encrypted and never shown again; read-only check; disconnect). Every action is the owner's.
 */
export function WebsiteIntegrationCards({ integrations }: IntegrationCardsProps) {
  const toast = useToast();
  const gsc = integrations.find((i) => i.id === 'google_search_console');
  const wp = integrations.find((i) => i.id === 'website_editing');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ baseUrl: '', username: '', applicationPassword: '' });
  const [deleteData, setDeleteData] = useState(false);
  const [platform, setPlatform] = useState<PlatformHint | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<{ platformHint: PlatformHint | null; setup: { website: string } }>('/api/website', { signal: controller.signal })
      .then((o) => {
        setPlatform(o.platformHint);
        setForm((f) => (f.baseUrl ? f : { ...f, baseUrl: /^https:\/\//.test(o.setup.website) ? o.setup.website : '' }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
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
  const gscConnected = gsc && (gsc.state === 'connected' || gsc.state === 'error' || gsc.state === 'needs_reauth');
  const wpSaved = wp && wp.state !== 'not_connected';
  return (
    <Card>
      <CardHeader title="Website and search" description="Optional. Your website check works without these; they add real Google search numbers and applying changes from here." />
      <CardBody className="space-y-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-charcoal-900">Google Search Console</h3>
            <Pill status={gsc} />
          </div>
          <p className="text-sm text-charcoal-600 [overflow-wrap:anywhere]">{gsc?.message}</p>
          {gsc?.detail ? <p className="text-xs text-charcoal-500 [overflow-wrap:anywhere]">Property: {gsc.detail}</p> : null}
          <p className="text-xs text-charcoal-500">
            Read-only: Studio Assistant can&apos;t change anything in Search Console.{gsc?.liveMode ? ` ${liveModeLabel(gsc.liveMode)}.` : ''}
          </p>
          {gsc?.configured ? (
            <div className="flex flex-wrap items-center gap-2">
              {!gscConnected || gsc.state === 'needs_reauth' ? (
                <a href="/api/integrations/google/connect?product=search_console" className={buttonClasses('primary', 'md', 'min-h-11')}>
                  {gsc.state === 'needs_reauth' ? 'Reconnect' : 'Connect Search Console'}
                </a>
              ) : null}
              {gscConnected ? (
                <Button
                  variant="secondary"
                  className="min-h-11"
                  loading={busy === 'gsc-check'}
                  onClick={() => void act('gsc-check', () => apiRequest('/api/integrations/google-search-console/check', { method: 'POST', body: {} }), 'Checking (read-only)')}
                >
                  Check again
                </Button>
              ) : null}
              {gscConnected ? (
                <>
                  <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal-700">
                    <input type="checkbox" className="size-5" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
                    Also delete stored search data
                  </label>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    loading={busy === 'gsc-off'}
                    onClick={() =>
                      void act(
                        'gsc-off',
                        () => apiRequest(`/api/integrations/google-search-console?deleteData=${deleteData ? 'true' : 'false'}`, { method: 'DELETE' }),
                        'Search Console disconnected',
                      )
                    }
                  >
                    Disconnect
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="space-y-3 border-t border-charcoal-100 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-charcoal-900">Website editing (WordPress)</h3>
            <Pill status={wp} />
          </div>
          <p className="text-sm text-charcoal-600">{wp?.message}</p>
          {wp?.liveMode === 'staging' ? <Alert tone="warning">Staging site: changes applied from here go to this WordPress site, not your public website.</Alert> : null}
          {platform && platform !== 'unknown' && platform !== 'wordpress' ? (
            <p className="text-sm text-charcoal-600">
              Your website looks like it&apos;s built with {WEBSITE_PLATFORM_NAMES[platform]}. Studio Assistant can&apos;t edit {WEBSITE_PLATFORM_NAMES[platform]} sites; prepared
              changes come with copy-paste steps instead.
            </p>
          ) : null}
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                'wp-save',
                async () => {
                  await apiRequest('/api/integrations/website/wordpress', { method: 'POST', body: form });
                  setForm((f) => ({ ...f, applicationPassword: '' }));
                },
                'Saved — checking WordPress (read-only)',
              );
            }}
          >
            <Input
              label="WordPress site address"
              type="url"
              placeholder="https://"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              containerClassName="sm:col-span-2"
              maxLength={300}
            />
            <Input label="WordPress username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} maxLength={120} autoComplete="off" />
            <Input
              label="Application Password"
              type="password"
              value={form.applicationPassword}
              onChange={(e) => setForm({ ...form, applicationPassword: e.target.value })}
              maxLength={200}
              autoComplete="new-password"
              {...(wpSaved ? { placeholder: 'Saved — hidden' } : {})}
            />
            <p className="text-xs text-charcoal-500 sm:col-span-2">
              Create a separate WordPress user with the Editor role, then Users → Profile → Application Passwords. Studio Assistant never sees your normal WordPress password.
              Saving runs a read-only check; nothing on your site changes.
            </p>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" className="min-h-11" loading={busy === 'wp-save'} disabled={!form.baseUrl || !form.username || form.applicationPassword.trim().length < 16}>
                Save and check
              </Button>
              {wpSaved ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  loading={busy === 'wp-check'}
                  onClick={() => void act('wp-check', () => apiRequest('/api/integrations/website/check', { method: 'POST', body: {} }), 'Checking (read-only)')}
                >
                  Check again
                </Button>
              ) : null}
              {wpSaved ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  loading={busy === 'wp-off'}
                  onClick={() => void act('wp-off', () => apiRequest('/api/integrations/website', { method: 'DELETE' }), 'WordPress disconnected')}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
          </form>
          {wpSaved ? <p className="text-xs text-charcoal-500">To fully revoke access, delete the Application Password in WordPress.</p> : null}
        </section>
      </CardBody>
    </Card>
  );
}
