import { parseSquareConfig, squareIntegrationState } from '@studio/core';
import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/**
 * Square Appointments (WP6, design §4.1): the shared state from `squareIntegrationState`, the environment as the
 * live mode, and plain wording for each state. Never claims bookings are shown before a sync has run. Pure.
 */
export const buildSquareIntegrations: IntegrationBuilder = (env, facts) => {
  const sqMissing = missingEnv(env, ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET']);
  const webhookMissing = missingEnv(env, ['SQUARE_WEBHOOK_SIGNATURE_KEY']);
  const sq = connectionFor(facts, 'square');
  const environment = env.SQUARE_ENVIRONMENT ?? 'sandbox';
  const r = squareIntegrationState({
    envPresent: sqMissing.length === 0,
    webhookKeyPresent: webhookMissing.length === 0,
    environment,
    connection: sq ? { status: sq.status, externalAccountId: null, scopes: [], config: sq.config, capabilities: sq.capabilities, lastSyncAt: sq.lastSyncAt ?? null, lastError: sq.lastError ?? null } : null,
    now: new Date(),
  });
  const name = sq?.displayName || parseSquareConfig(sq?.config).snapshot?.merchantName || '';
  const envWords = environment === 'production' ? 'live' : 'sandbox (test)';
  let message: string;
  switch (r.state) {
    case 'not_configured':
      message = `Add ${envSentence(sqMissing)} from your Square developer dashboard to the server, then connect Square in Settings → Integrations. No bookings are shown until then.`;
      break;
    case 'not_connected':
      message = `Square is set up for the ${envWords} environment. Connect Square in Settings → Integrations to show your bookings.`;
      break;
    case 'needs_reauth':
      message =
        r.reauthReason === 'env_changed'
          ? `Studio Assistant is now set to ${environment === 'production' ? 'live' : 'sandbox (test)'} Square. Reconnect Square in Settings → Integrations; the other environment’s data will be removed.`
          : r.reauthReason === 'scopes'
            ? 'Square didn’t grant all the read permissions Studio Assistant needs. Reconnect Square in Settings → Integrations.'
            : 'Square needs you to sign in again. Reconnect Square in Settings → Integrations.';
      break;
    case 'error':
      message = `The last sync with Square failed${sq?.lastError ? `: ${sq.lastError}` : ''}. Studio Assistant tries again automatically.`;
      break;
    default: {
      const synced = sq?.lastSyncAt ? 'Bookings sync from Square every 10 minutes' : 'Fetching your bookings from Square';
      const hooks = r.webhooks === 'off' ? ' (webhooks aren’t set up, so changes arrive at the next sync)' : r.webhooks === 'quiet' ? ' (no webhook received for 3 days — check the subscription in Square)' : '';
      message = r.needsLocation
        ? `Connected${name ? ` to ${name}` : ''}. Your Square account has more than one location: choose your studio’s location in Settings → Integrations. Bookings are copied once you do.`
        : `Connected${name ? ` to ${name}` : ''}. ${synced}${hooks}.${r.stale && sq?.lastSyncAt ? ' Bookings may be out of date: the last successful sync was over 30 minutes ago.' : ''}`;
    }
  }
  return [
    {
      id: 'square',
      name: 'Square Appointments',
      areas: ['appointments', 'reviews', 'email'],
      configured: sqMissing.length === 0,
      connected: r.state === 'connected',
      missingEnv: [...sqMissing, ...webhookMissing],
      message,
      ...(name ? { detail: name } : {}),
      state: r.state,
      liveMode: r.liveMode,
      // Square's live verification is the Tier 1 self-test (WP6b); reads are never a verification.
      verified: false,
    },
  ];
};
