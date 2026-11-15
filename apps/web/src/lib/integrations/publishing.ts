import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/** Manual posting always works; it is said first on every publishing card. */
export const INSTAGRAM_MANUAL_LINE = 'Post it yourself works now: download the video, copy the caption and post it in the Instagram app, then tap "I\'ve posted it".';
export const TIKTOK_MANUAL_LINE = 'Post it yourself works now: download the video, copy the caption and post it in the TikTok app (add a Commercial Sound there if you want music), then tap "I\'ve posted it".';

/**
 * Publishing destinations (design §5.3). Instagram: manual posting always, plus optional direct publishing through
 * Meta's Unified Login (system-user token, Development mode: posts are real and public), switched on only after a
 * first verification post. TikTok: manual posting always (no direct TikTok API for a private app, memo §3), plus,
 * only when the server sets TIKTOK_PUBLISH_PROVIDER=zernio, optional automatic posting through Zernio (design §7.2:
 * a pasted API key, the TikTok account Zernio lists, live and public immediately, switched on only after a first
 * verification post). The TikTok developer-app settings are not used.
 */
export const buildPublishingIntegrations: IntegrationBuilder = (env, facts) => {
  const out: IntegrationStatus[] = [];

  // --- Instagram
  const igMissing = missingEnv(env, ['META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID']);
  const meta = connectionFor(facts, 'meta');
  const accounts = facts.socialAccounts.filter((s) => s.platform === 'instagram');
  const live = accounts.find((s) => s.status === 'connected');
  const verified = accounts.some((s) => Boolean(s.capabilities?.['verifiedDirectAt']));
  const handle = live ? `@${live.username}` : null;
  let state: IntegrationStatus['state'];
  let message: string;
  if (igMissing.length) {
    state = 'not_configured';
    message = `${INSTAGRAM_MANUAL_LINE} Direct publishing needs setup: add ${envSentence(igMissing)} to the server, then connect Instagram here.`;
  } else if (!meta || meta.status === 'disconnected' || meta.status === 'not_configured') {
    state = 'not_connected';
    message = `${INSTAGRAM_MANUAL_LINE} Direct publishing is ready to connect: press Connect Instagram below.`;
  } else if (meta.status === 'needs_reauth' || (accounts.length > 0 && accounts.every((a) => a.status === 'needs_reauth'))) {
    state = 'needs_reauth';
    message = `${INSTAGRAM_MANUAL_LINE} Direct publishing needs reconnecting: ${meta.lastError ?? 'Meta no longer accepts the connection.'}`;
  } else if (meta.status === 'error' || !live) {
    state = 'error';
    message = `${INSTAGRAM_MANUAL_LINE} Direct publishing has a problem: ${meta.lastError ?? 'the account could not be checked yet.'}`;
  } else {
    state = 'connected';
    message = verified
      ? `Connected as ${handle}. ${live.capabilities?.['verifiedDirectAt'] ? 'The first verification post was confirmed.' : ''} Meta app in Development mode (expected for a single business): posts are real and public.`.replace(/\s+/g, ' ')
      : `Connected as ${handle}. Direct posting is off until your first verification post. Meta app in Development mode (expected for a single business): posts are real and public.`;
  }
  out.push({
    id: 'instagram',
    name: 'Instagram',
    areas: ['publishing'],
    configured: igMissing.length === 0,
    connected: state === 'connected',
    missingEnv: igMissing,
    message,
    ...(handle ? { detail: handle } : {}),
    state,
    liveMode: state === 'connected' ? 'development_live' : null,
    verified: state === 'connected' && verified,
  });

  // --- TikTok (manual always; Zernio only when the server switches it on)
  out.push(tiktokStatus(env, facts));

  return out;
};

/**
 * The TikTok card (design §5.3, "TikTok via Zernio" column). Without TIKTOK_PUBLISH_PROVIDER=zernio nothing about
 * Zernio is said: TikTok is posted by hand. With it: not configured (no ZERNIO_API_BASE_URL), not connected (no key
 * saved, or no TikTok account chosen yet), needs re-authorisation (Zernio refused the key, or the account must be
 * reconnected or chosen again), error, or connected and live (posts are public immediately).
 */
function tiktokStatus(env: Parameters<IntegrationBuilder>[0], facts: Parameters<IntegrationBuilder>[1]): IntegrationStatus {
  const card = { id: 'tiktok', name: 'TikTok', areas: ['publishing' as const] };
  if (env.TIKTOK_PUBLISH_PROVIDER !== 'zernio') {
    return {
      ...card,
      configured: false,
      connected: false,
      missingEnv: [],
      message: `${TIKTOK_MANUAL_LINE} Automatic TikTok posting isn't switched on: TikTok doesn't allow it for a private app, and the optional route through Zernio is off on this server.`,
      state: 'unavailable',
      liveMode: null,
      verified: false,
    };
  }
  const missing = missingEnv(env, ['ZERNIO_API_BASE_URL']);
  const zernio = connectionFor(facts, 'zernio');
  const accounts = facts.socialAccounts.filter((s) => s.platform === 'tiktok' && s.status !== 'disconnected');
  const account = accounts[0];
  const verified = Boolean(account?.capabilities?.['verifiedDirectAt']);
  const handle = account ? `@${account.username}` : null;
  let state: IntegrationStatus['state'];
  let message: string;
  if (missing.length) {
    state = 'not_configured';
    message = `${TIKTOK_MANUAL_LINE} Automatic posting through Zernio needs setup: add ${envSentence(missing)} to the server.`;
  } else if (!zernio || zernio.status === 'disconnected' || zernio.status === 'not_configured') {
    state = 'not_connected';
    message = `${TIKTOK_MANUAL_LINE} Automatic posting through Zernio is ready to connect: paste a Zernio API key below.`;
  } else if (zernio.status === 'needs_reauth') {
    state = 'needs_reauth';
    message = `${TIKTOK_MANUAL_LINE} Zernio needs a new key: ${zernio.lastError ?? "Zernio didn't accept the saved key."}`;
  } else if (zernio.status === 'error') {
    state = 'error';
    message = `${TIKTOK_MANUAL_LINE} Automatic posting through Zernio has a problem: ${zernio.lastError ?? 'the key could not be checked yet.'}`;
  } else if (!account) {
    state = 'not_connected';
    message = `${TIKTOK_MANUAL_LINE} Zernio accepted the key. Choose your TikTok account below.`;
  } else if (account.status !== 'connected') {
    state = 'needs_reauth';
    message = `${TIKTOK_MANUAL_LINE} ${handle} needs attention in Zernio: reconnect TikTok there (approve every permission), or choose your account again below.`;
  } else {
    state = 'connected';
    message = verified
      ? `Connected as ${handle} through Zernio. Live: posts are public immediately.`
      : `Connected as ${handle} through Zernio. Not verified: your first post through Zernio is a real, public TikTok post. Live: posts are public immediately.`;
  }
  return {
    ...card,
    configured: missing.length === 0,
    connected: state === 'connected',
    missingEnv: missing,
    message,
    ...(handle ? { detail: handle } : {}),
    state,
    liveMode: state === 'connected' ? 'live' : null,
    verified: state === 'connected' && verified,
  };
}
