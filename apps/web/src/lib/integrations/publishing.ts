import type { IntegrationStatus } from '../shared/integration-types.js';
import { envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/**
 * Publishing destinations (Instagram, TikTok). Stage A wording, moved here unchanged by the foundations package;
 * the publishing package (WP4, then WP10) replaces it with the manual-first wording of its design.
 */
export const buildPublishingIntegrations: IntegrationBuilder = (env, facts) => {
  const out: IntegrationStatus[] = [];
  const social = (platform: string) => facts.socialAccounts.find((s) => s.platform === platform && s.status === 'connected');

  // --- Instagram
  const igMissing = missingEnv(env, ['META_APP_ID', 'META_APP_SECRET']);
  const ig = social('instagram');
  out.push({
    id: 'instagram',
    name: 'Instagram',
    areas: ['publishing'],
    configured: igMissing.length === 0,
    connected: Boolean(ig),
    missingEnv: igMissing,
    message: ig
      ? `Connected as @${ig.username}.`
      : igMissing.length
        ? `Needs setup: a Meta developer app is required. Add ${envSentence(igMissing)} to the server, then connect your Instagram professional account in Settings → Integrations.`
        : 'The Meta app is configured. Connect your Instagram professional account in Settings → Integrations to publish Reels. Until then, download the export and post it from your phone.',
    ...(ig ? { detail: `@${ig.username}` } : {}),
    state: ig ? 'connected' : igMissing.length ? 'not_configured' : 'not_connected',
    liveMode: null,
    verified: false,
  });

  // --- TikTok
  const ttMissing = missingEnv(env, ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
  const tt = social('tiktok');
  out.push({
    id: 'tiktok',
    name: 'TikTok',
    areas: ['publishing'],
    configured: ttMissing.length === 0,
    connected: Boolean(tt),
    missingEnv: ttMissing,
    message: tt
      ? `Connected as @${tt.username}. Videos are sent to your TikTok drafts for you to finish in the app.`
      : ttMissing.length
        ? `Needs setup: a TikTok developer app is required. Add ${envSentence(ttMissing)} to the server, then connect TikTok in Settings → Integrations. Until then, download the export and upload it in the TikTok app.`
        : 'The TikTok app is configured. Connect your TikTok account in Settings → Integrations to send videos to your drafts.',
    ...(tt ? { detail: `@${tt.username}` } : {}),
    state: tt ? 'connected' : ttMissing.length ? 'not_configured' : 'not_connected',
    liveMode: null,
    verified: false,
  });

  return out;
};
