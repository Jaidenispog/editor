import { envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/**
 * Email sending. Stage A wording (Resend), moved here unchanged by the foundations package; the email package (WP7)
 * replaces it with the Postmark card and the review-rating card of its design.
 */
export const buildEmailIntegrations: IntegrationBuilder = (env) => {
  const emMissing = missingEnv(env, ['RESEND_API_KEY', 'EMAIL_FROM']);
  return [
    {
      id: 'email',
      name: 'Email sending (Resend)',
      areas: ['email', 'reviews'],
      configured: emMissing.length === 0,
      connected: emMissing.length === 0,
      missingEnv: emMissing,
      message:
        emMissing.length === 0
          ? 'Email sending is set up. Every message still waits for your approval before it is sent.'
          : `Needs setup: create a Resend account, verify your sending domain, then add ${envSentence(emMissing)} to the server. Nothing is emailed until then.`,
      ...(emMissing.length === 0 && env.EMAIL_FROM ? { detail: `From: ${env.EMAIL_FROM}` } : {}),
      state: emMissing.length === 0 ? 'connected' : 'not_configured',
      liveMode: emMissing.length === 0 ? 'live' : null,
      verified: false,
    },
  ];
};
