'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { PublishingConnectionsDto, SocialAccountDto } from '@/lib/shared/publishing-dto';
import type { IntegrationCardsProps } from './types';

type Notice = { tone: 'success' | 'info' | 'danger'; text: string };

/** Reads the outcome the Instagram callback put in the address, then removes it. */
function useInstagramNotice(): Notice | null {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('instagram_error');
    const state = url.searchParams.get('instagram');
    if (!error && !state) return;
    setNotice(error ? { tone: 'danger', text: error.slice(0, 300) } : state === 'checking' ? { tone: 'info', text: 'Instagram is connected. Checking your account now (read-only); this card updates in a moment.' } : { tone: 'success', text: 'Instagram is connected.' });
    url.searchParams.delete('instagram_error');
    url.searchParams.delete('instagram');
    window.history.replaceState(null, '', url.toString());
  }, []);
  return notice;
}

/**
 * Settings → Integrations card for publishing (design §4.5): Instagram connect (Meta Unified Login), the read-only
 * check, the account-ID form when discovery comes back empty, the verification state, the direct-publishing switch
 * (only after a confirmed verification post), token expiry, and disconnect. TikTok shows "Post it yourself" only.
 * Every control is the owner's; staff see the state.
 */
export function PublishingIntegrationCards({ integrations }: IntegrationCardsProps) {
  const toast = useToast();
  const notice = useInstagramNotice();
  const [data, setData] = useState<PublishingConnectionsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [igId, setIgId] = useState('');
  const ig = integrations.find((i) => i.id === 'instagram');

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<PublishingConnectionsDto>('/api/publishing/connections'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // While the first check runs, look again a few times.
  useEffect(() => {
    if (notice?.tone !== 'info') return;
    const timers = [3000, 8000, 15000].map((ms) => setTimeout(() => void load(), ms));
    return () => timers.forEach(clearTimeout);
  }, [notice, load]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const i = data?.instagram;
  const canManage = data?.canManage ?? false;
  const connected = i?.connectionStatus === 'connected' || i?.connectionStatus === 'error' || i?.connectionStatus === 'needs_reauth';
  return (
    <Card>
      <CardHeader title="Publishing" description="Posting it yourself always works: download, copy the caption, post in the app, then tap “I've posted it”. Direct publishing to Instagram is optional." />
      <CardBody className="space-y-5">
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
        {failed ? <Alert tone="danger">The publishing connection state could not be loaded.</Alert> : null}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-charcoal-900">Instagram direct publishing</h3>
            <StatusPill status={ig?.state ?? 'not_configured'} label={ig?.state === 'connected' ? (ig.verified ? 'Connected' : 'Connected, not verified') : undefined} />
          </div>
          {!i ? <p className="text-sm text-charcoal-600">Loading…</p> : null}
          {i && !i.configured ? (
            <p className="text-sm text-charcoal-600">
              Needs setup on the server: {i.missingEnv.join(', ')}. The setup checklist is in the deployment notes (a Meta business app in Development mode with one System-user configuration).
            </p>
          ) : null}
          {i?.configured ? (
            <>
              <p className="text-sm text-charcoal-600">Meta app in Development mode (expected for a single business). Posts are real and public.</p>
              {i.lastError ? <Alert tone={i.connectionStatus === 'needs_reauth' ? 'warning' : 'danger'}>{i.lastError}</Alert> : null}
              {i.tokenExpiresAt === null && connected ? <p className="text-sm text-charcoal-600">Token does not expire.</p> : null}
              {i.tokenExpiresAt ? (
                <p className={i.tokenExpiringSoon ? 'text-sm font-medium text-amber-800' : 'text-sm text-charcoal-600'}>
                  Token expires {formatDateTime(i.tokenExpiresAt, { dateStyle: 'medium', timeStyle: undefined })}
                  {i.tokenExpiringSoon ? ': reconnect soon so direct posting keeps working.' : '.'}
                </p>
              ) : null}
              {i.lastCheckedAt ? <p className="text-xs text-charcoal-500">Last checked {formatDateTime(i.lastCheckedAt)} · Graph {i.graphVersion}</p> : null}
              {i.accounts.map((a) => (
                <AccountRow key={a.id} account={a} canManage={canManage} busy={busy} onToggle={(v) => void act(`switch-${a.id}`, () => apiRequest(`/api/social-accounts/${a.id}`, { method: 'PATCH', body: { directPublishEnabled: v } }), v ? 'Direct publishing switched on' : 'Direct publishing switched off')} />
              ))}
              {canManage && connected && (i.discoveryEmpty || i.accounts.length === 0) ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('igid', () => apiRequest('/api/integrations/instagram/account', { method: 'POST', body: { igUserId: igId.trim() } }), 'Checking that account (read-only)');
                  }}
                >
                  <Input label="Instagram account ID" hint="Instagram didn't tell us which account to use. Find the ID in Meta Business Settings → Accounts → Instagram accounts." inputMode="numeric" value={igId} onChange={(e) => setIgId(e.target.value)} />
                  <Button type="submit" className="min-h-11" loading={busy === 'igid'} disabled={!/^\d{5,30}$/.test(igId.trim())}>
                    Check this account
                  </Button>
                </form>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {i.connectionStatus === 'none' || i.connectionStatus === 'disconnected' || i.connectionStatus === 'needs_reauth' ? (
                    <a href="/api/integrations/instagram/connect" className={buttonClasses('primary', 'md', 'min-h-11')}>
                      {i.connectionStatus === 'needs_reauth' ? 'Reconnect Instagram' : 'Connect Instagram'}
                    </a>
                  ) : null}
                  {connected ? (
                    <Button variant="secondary" className="min-h-11" loading={busy === 'check'} onClick={() => void act('check', () => apiRequest('/api/integrations/meta/check', { method: 'POST', body: {} }), 'Checking (read-only); nothing is posted')}>
                      Check connection
                    </Button>
                  ) : null}
                  {connected ? (
                    <Button variant="ghost" className="min-h-11" loading={busy === 'disconnect'} onClick={() => void act('disconnect', () => apiRequest('/api/integrations/meta', { method: 'DELETE' }), 'Instagram disconnected')}>
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-charcoal-500">Only the studio owner can connect or change Instagram.</p>
              )}
              {connected ? <p className="text-xs text-charcoal-500">To fully revoke access, also remove the system user&apos;s token in Meta Business Settings.</p> : null}
            </>
          ) : null}
        </section>
        <section className="space-y-1 border-t border-charcoal-100 pt-4">
          <h3 className="text-sm font-semibold text-charcoal-900">TikTok</h3>
          <p className="text-sm text-charcoal-600">Post it yourself: download, copy the caption, post in the TikTok app (add a Commercial Sound there if you want music).</p>
        </section>
      </CardBody>
    </Card>
  );
}

function AccountRow({ account, canManage, busy, onToggle }: { account: SocialAccountDto; canManage: boolean; busy: string | null; onToggle: (v: boolean) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-charcoal-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-charcoal-900">@{account.username}</p>
        <StatusPill status={account.status} />
      </div>
      <p className="text-sm text-charcoal-600">
        {account.verified ? `First verification post confirmed${account.verifiedAt ? ` on ${formatDateTime(account.verifiedAt, { dateStyle: 'medium', timeStyle: undefined })}` : ''}.` : 'Connected. Direct posting is off until your first verification post: choose "First verification post" in the composer for a real edit you are happy to share.'}
      </p>
      {account.quotaTotal !== null ? (
        <p className="text-xs text-charcoal-500">
          {account.quotaUsage ?? 0} of {account.quotaTotal} posts used in the last 24 h{account.quotaCheckedAt ? ` (checked ${formatDateTime(account.quotaCheckedAt, { dateStyle: undefined, timeStyle: 'short' })})` : ''}
        </p>
      ) : null}
      {account.lastError ? <p className="text-xs text-red-700">{account.lastError}</p> : null}
      <Switch
        checked={account.directPublishEnabled}
        disabled={!canManage || !account.verified || busy === `switch-${account.id}`}
        onChange={onToggle}
        label="Publish directly from Studio Assistant"
        description={account.verified ? 'When off, choose "Post it yourself" in the composer.' : 'Available after your first verification post.'}
      />
    </div>
  );
}
