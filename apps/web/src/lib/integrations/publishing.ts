import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/** Manual posting always works; it is said first on every publishing card. */
export const INSTAGRAM_MANUAL_LINE = 'Post it yourself works now: download the video, copy the caption and post it in the Instagram app, then tap "I\'ve posted it".';
export const TIKTOK_MANUAL_LINE = 'Post it yourself works now: download the video, copy the caption and post it in the TikTok app (add a Commercial Sound there if you want music), then tap "I\'ve posted it".';

/**
 * Publishing destinations (design §5.3). Instagram: manual posting always, plus optional direct publishing through
 * Meta's Unified Login (system-user token, Development mode: posts are real and public), switched on only after a
 * first verification post. TikTok: manual posting only in Stage B (no direct TikTok API for a private app, memo §3;
 * the optional Zernio route is a later work package). The TikTok developer-app settings are not used.
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

  // --- TikTok (manual only in Stage B)
  out.push({
    id: 'tiktok',
    name: 'TikTok',
    areas: ['publishing'],
    configured: false,
    connected: false,
    missingEnv: [],
    message: `${TIKTOK_MANUAL_LINE} Automatic TikTok posting isn't available: TikTok doesn't allow it for a private app, and an optional provider may be added later.`,
    state: 'unavailable',
    liveMode: null,
    verified: false,
  });

  return out;
};
