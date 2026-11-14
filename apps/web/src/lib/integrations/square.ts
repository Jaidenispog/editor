import { connectionFor, envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/** Square Appointments. Stage A wording, moved here unchanged; the Square package (WP6) replaces it. */
export const buildSquareIntegrations: IntegrationBuilder = (env, facts) => {
  const sqMissing = missingEnv(env, ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET']);
  const sq = connectionFor(facts, 'square');
  const sqConnected = sq?.status === 'connected';
  return [
    {
      id: 'square',
      name: 'Square Appointments',
      areas: ['appointments', 'reviews', 'email'],
      configured: sqMissing.length === 0,
      connected: sqConnected,
      missingEnv: [...sqMissing, ...missingEnv(env, ['SQUARE_WEBHOOK_SIGNATURE_KEY'])],
      message: sqConnected
        ? `Connected${sq?.displayName ? ` to ${sq.displayName}` : ''}. Bookings sync from Square.`
        : sq?.status === 'needs_reauth'
          ? 'Square needs you to sign in again. Reconnect Square in Settings → Integrations.'
          : sqMissing.length
            ? `Needs setup: add ${envSentence(sqMissing)} from your Square developer dashboard to the server, then connect Square in Settings → Integrations. No bookings are shown until then.`
            : 'Square credentials are configured. Connect Square in Settings → Integrations to sync bookings.',
      ...(sq?.displayName ? { detail: sq.displayName } : {}),
      state: sqConnected ? 'connected' : sq?.status === 'needs_reauth' ? 'needs_reauth' : sqMissing.length ? 'not_configured' : 'not_connected',
      liveMode: sqMissing.length ? null : env.SQUARE_ENVIRONMENT === 'production' ? 'live' : 'sandbox',
      verified: false,
    },
  ];
};
