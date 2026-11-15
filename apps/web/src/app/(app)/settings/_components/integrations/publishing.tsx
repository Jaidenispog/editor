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
import type { IntegrationStatus } from '@/lib/shared/integration-types';
import type { PublishingConnectionsDto, SocialAccountDto, ZernioConnectionDto } from '@/lib/shared/publishing-dto';
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
 * (only after a confirmed verification post), token expiry, and disconnect. TikTok always shows "Post it yourself",
 * plus the optional Zernio section when the server switches it on. Every control is the owner's; staff see the state.
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
        <TikTokSection integration={integrations.find((x): x is IntegrationStatus => x.id === 'tiktok')} />
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

/**
 * The TikTok part of the card (design §4.5): manual posting always; with TIKTOK_PUBLISH_PROVIDER=zernio on the server,
 * the optional "Automatic posting via Zernio" section: paste a key (owner only; it is never shown again), choose the
 * TikTok account Zernio lists, the read-only check, the verification state, the two switches (each only after its own
 * confirmed first post), the 15-a-day count and disconnect. Without the flag nothing about Zernio is shown.
 */
function TikTokSection({ integration }: { integration: IntegrationStatus | undefined }) {
  const toast = useToast();
  const [data, setData] = useState<ZernioConnectionDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [choice, setChoice] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<ZernioConnectionDto>('/api/integrations/zernio'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string, recheck = false): Promise<boolean> => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
      if (recheck) [3000, 8000].forEach((ms) => setTimeout(() => void load(), ms));
      return true;
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const z = data;
  const hasKey = Boolean(z?.keyHint) && z?.connectionStatus !== 'disconnected' && z?.connectionStatus !== 'none';
  return (
    <section className="space-y-3 border-t border-charcoal-100 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-charcoal-900">TikTok</h3>
        {z?.enabled ? <StatusPill status={integration?.state ?? 'not_configured'} label={integration?.state === 'connected' ? (integration.verified ? 'Connected' : 'Connected, not verified') : undefined} /> : null}
      </div>
      <p className="text-sm text-charcoal-600">Post it yourself: download, copy the caption, post in the TikTok app (add a Commercial Sound there if you want music).</p>
      {failed ? <Alert tone="danger">The TikTok connection state could not be loaded.</Alert> : null}
      {z?.enabled ? (
        <div className="space-y-3 rounded-lg border border-charcoal-200 p-3">
          <h4 className="text-sm font-semibold text-charcoal-900">Automatic posting via Zernio (optional)</h4>
          {!z.configured ? <p className="text-sm text-charcoal-600">Needs setup on the server: {z.missingEnv.join(', ')}.</p> : null}
          {z.configured ? (
            <>
              <p className="text-sm text-charcoal-600">Live: posts through Zernio are public immediately. TikTok allows 15 videos a day this way.</p>
              {z.lastError ? <Alert tone={z.connectionStatus === 'needs_reauth' ? 'warning' : 'danger'}>{z.lastError}</Alert> : null}
              {hasKey && !replacing ? <p className="text-sm text-charcoal-700">Key saved (ends …{z.keyHint})</p> : null}
              {z.canManage && (!hasKey || replacing) ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('key', () => apiRequest('/api/integrations/zernio', { method: 'POST', body: { apiKey: apiKey.trim() } }), 'Key saved. Checking it now (read-only); nothing is posted.', true).then((ok) => {
                      if (!ok) return;
                      setApiKey('');
                      setReplacing(false);
                    });
                  }}
                >
                  <Input
                    label="Zernio API key"
                    type="password"
                    autoComplete="off"
                    hint="Create a key in Zernio (API keys page). Best: switch off every area except Accounts and Publishing. The key is stored encrypted and never shown again."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" className="min-h-11" loading={busy === 'key'} disabled={apiKey.trim().length < 10}>
                      Save key
                    </Button>
                    {replacing ? (
                      <Button type="button" variant="ghost" className="min-h-11" onClick={() => setReplacing(false)}>
                        Keep the saved key
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : null}
              {hasKey && z.candidates.length > 0 && z.canManage && (!z.account || z.account.status !== 'connected') ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-charcoal-800">{z.account ? 'Choose your TikTok account again' : 'Choose your TikTok account'}</legend>
                  {z.candidates.map((c) => (
                    <label key={c.id} className="flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-charcoal-50">
                      <input type="radio" className="mt-1 size-4 accent-[var(--accent)]" name="zernio-account" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                      <span className="min-w-0 text-sm">
                        <span className="font-medium text-charcoal-900">@{c.username}</span>
                        {c.displayName ? <span className="text-charcoal-600"> · {c.displayName}</span> : null}
                        {c.problem ? <span className="block text-xs text-amber-800">{c.problem}</span> : null}
                      </span>
                    </label>
                  ))}
                  <Button className="min-h-11" loading={busy === 'choose'} disabled={!choice} onClick={() => void act('choose', () => apiRequest('/api/integrations/zernio/account', { method: 'POST', body: { zernioAccountId: choice } }), 'TikTok account chosen. Checking it now (read-only).', true)}>
                    Use this account
                  </Button>
                </fieldset>
              ) : null}
              {hasKey && z.candidates.length === 0 && z.connectionStatus === 'connected' && !z.account ? <p className="text-sm text-charcoal-600">Checking which TikTok accounts Zernio has…</p> : null}
              {z.account ? (
                <ZernioAccountRow
                  account={z.account}
                  canManage={z.canManage}
                  busy={busy}
                  onSwitch={(field, v, done) => void act(field, () => apiRequest(`/api/social-accounts/${z.account?.id ?? ''}`, { method: 'PATCH', body: { [field]: v } }), done)}
                />
              ) : null}
              {z.lastCheckedAt ? <p className="text-xs text-charcoal-500">Last checked {formatDateTime(z.lastCheckedAt)}</p> : null}
              {z.canManage ? (
                <div className="flex flex-wrap gap-2">
                  {hasKey ? (
                    <Button variant="secondary" className="min-h-11" loading={busy === 'zcheck'} onClick={() => void act('zcheck', () => apiRequest('/api/integrations/zernio/check', { method: 'POST', body: {} }), 'Checking (read-only); nothing is posted', true)}>
                      Check connection
                    </Button>
                  ) : null}
                  {hasKey && !replacing ? (
                    <Button variant="ghost" className="min-h-11" onClick={() => setReplacing(true)}>
                      Replace key
                    </Button>
                  ) : null}
                  {hasKey ? (
                    <Button variant="ghost" className="min-h-11" loading={busy === 'zdisconnect'} onClick={() => void act('zdisconnect', () => apiRequest('/api/integrations/zernio', { method: 'DELETE' }), 'Zernio disconnected')}>
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-charcoal-500">Only the studio owner can connect or change Zernio.</p>
              )}
              <details className="text-xs text-charcoal-600">
                <summary className="min-h-11 cursor-pointer py-3 font-medium text-charcoal-800">Faster updates (optional)</summary>
                <p>
                  In Zernio&apos;s webhook settings, add <span className="break-all font-mono">{z.webhookUrl}</span> with the post events and the secret the person running the server gives you.{' '}
                  {z.webhookSigning ? 'Signed deliveries are checked on this server.' : 'No webhook secret is set on this server yet, so deliveries are treated as hints only.'} Posts are checked regularly either way.
                </p>
              </details>
              {hasKey ? <p className="text-xs text-charcoal-500">To fully revoke access, also delete the key in Zernio. Posts already on TikTok stay there; delete them in the TikTok app.</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ZernioAccountRow({
  account,
  canManage,
  busy,
  onSwitch,
}: {
  account: NonNullable<ZernioConnectionDto['account']>;
  canManage: boolean;
  busy: string | null;
  onSwitch: (field: 'directPublishEnabled' | 'draftsEnabled', v: boolean, done: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-charcoal-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-charcoal-900">@{account.username}</p>
        <StatusPill status={account.status} />
      </div>
      {account.lastError ? <p className="text-xs text-red-700">{account.lastError}</p> : null}
      <p className="text-sm text-charcoal-600">
        {account.verified
          ? `First post through Zernio confirmed${account.verifiedAt ? ` on ${formatDateTime(account.verifiedAt, { dateStyle: 'medium', timeStyle: undefined })}` : ''}.`
          : 'Not verified. Your first post through Zernio is a real, public TikTok post: choose "Publish via Zernio" in the composer for an edit you are happy to share.'}
      </p>
      <p className="text-xs text-charcoal-500">{account.last24h} of 15 TikTok videos in the last 24 h (counted from posts sent from here)</p>
      <Switch
        checked={account.directPublishEnabled}
        disabled={!canManage || !account.verified || busy === 'directPublishEnabled'}
        onChange={(v) => onSwitch('directPublishEnabled', v, v ? 'Publishing via Zernio switched on' : 'Publishing via Zernio switched off')}
        label="Publish directly via Zernio"
        description={account.verified ? 'When off, choose "Post it yourself" in the composer.' : 'Available after your first post through Zernio.'}
      />
      <Switch
        checked={account.draftsEnabled}
        disabled={!canManage || !account.draftVerified || busy === 'draftsEnabled'}
        onChange={(v) => onSwitch('draftsEnabled', v, v ? 'Sending to TikTok drafts switched on' : 'Sending to TikTok drafts switched off')}
        label="Send to TikTok drafts"
        description={account.draftVerified ? 'Drafts arrive in your TikTok inbox; add a sound and post them in the app.' : 'Available after your first draft through Zernio reaches your TikTok inbox.'}
      />
    </div>
  );
}
