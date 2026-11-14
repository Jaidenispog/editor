import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/**
 * Google Business Profile. Stage A wording, moved here unchanged; the Business Profile package (WP9) adds the
 * "Waiting for Google approval" state and the Performance line. The connection itself uses the shared Google OAuth
 * routes (`/api/integrations/google/connect?product=business_profile`).
 */
export const buildBusinessProfileIntegrations: IntegrationBuilder = (env, facts) => {
  const gMissing = missingEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const gbp = connectionFor(facts, 'google_business_profile');
  return [
    {
      id: 'google_business_profile',
      name: 'Google Business Profile',
      areas: ['reviews', 'website'],
      configured: gMissing.length === 0,
      connected: gbp?.status === 'connected',
      missingEnv: gMissing,
      message:
        gbp?.status === 'connected'
          ? `Connected${gbp.displayName ? ` to ${gbp.displayName}` : ''}.`
          : gMissing.length
            ? `Needs setup: add ${envSentence(gMissing)} from a Google Cloud project to the server, then connect your Business Profile in Settings → Integrations. Review requests can still use your review link from Settings → Business.`
            : 'Google credentials are configured. Connect your Business Profile in Settings → Integrations to see reviews here.',
      ...(gbp?.displayName ? { detail: gbp.displayName } : {}),
      state: gbp?.status === 'connected' ? 'connected' : gbp?.status === 'needs_reauth' ? 'needs_reauth' : gMissing.length ? 'not_configured' : 'not_connected',
      liveMode: gbp?.status === 'connected' ? 'live' : null,
      verified: false,
    },
  ];
};
