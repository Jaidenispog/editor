import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/**
 * Google Search Console (and, from WP8, website editing). Stage A wording, moved here unchanged; the website
 * package (WP8) replaces it with the states of its design. The connection uses the shared Google OAuth routes
 * (`/api/integrations/google/connect?product=search_console`).
 */
export const buildWebsiteIntegrations: IntegrationBuilder = (env, facts) => {
  const gMissing = missingEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const gsc = connectionFor(facts, 'google_search_console');
  return [
    {
      id: 'google_search_console',
      name: 'Google Search Console',
      areas: ['website'],
      configured: gMissing.length === 0,
      connected: gsc?.status === 'connected',
      missingEnv: gMissing,
      message:
        gsc?.status === 'connected'
          ? 'Connected. Search performance for your website is available.'
          : gMissing.length
            ? `Needs setup: add ${envSentence(gMissing)} to the server, then connect Search Console in Settings → Integrations. You also need your website verified in Search Console.`
            : 'Google credentials are configured. Connect Search Console in Settings → Integrations (your website must be verified there).',
      state: gsc?.status === 'connected' ? 'connected' : gsc?.status === 'needs_reauth' ? 'needs_reauth' : gMissing.length ? 'not_configured' : 'not_connected',
      liveMode: gsc?.status === 'connected' ? 'read_only' : null,
      verified: false,
    },
  ];
};
