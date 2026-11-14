import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type ConnectionFact, type ConnectionFacts, type IntegrationBuilder, type IntegrationEnv } from './types.js';

/**
 * Email (Postmark) and Google rating (Places) cards, email design §4.1 and §4.8. Postmark replaces the Stage A
 * Resend card (memo §8 decision; plan §10.1). Every state is read from server settings and the last read-only
 * check; nothing here sends anything, and no message starts with "Needs setup:" (the pill says it).
 */

/** Server settings missing for Postmark sending (names only). */
export function postmarkMissingEnv(env: IntegrationEnv): string[] {
  const missing = env.EMAIL_PROVIDER === 'postmark' ? [] : ['EMAIL_PROVIDER'];
  return [...missing, ...missingEnv(env, ['POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'])];
}

/** The email card's state from the server settings and the stored `postmark` row (pure). */
export function postmarkCard(env: IntegrationEnv, conn: ConnectionFact | undefined): IntegrationStatus {
  const missing = postmarkMissingEnv(env);
  const base = { id: 'postmark', name: 'Email (Postmark)', areas: ['email', 'reviews'] as IntegrationStatus['areas'], missingEnv: missing, verified: false };
  if (missing.length) {
    return {
      ...base,
      configured: false,
      connected: false,
      state: 'not_configured',
      liveMode: null,
      message: `Emails can be written and saved as drafts, but nothing is sent until Postmark is connected. The server needs ${envSentence(missing)} (see the owner setup checklist).`,
    };
  }
  const caps = conn?.capabilities ?? {};
  const checked = Boolean(conn && conn.status !== 'not_configured' && conn.lastSyncAt);
  const from = env.EMAIL_FROM ? { detail: `From: ${env.EMAIL_FROM}` } : {};
  if (!checked) {
    return { ...base, ...from, configured: true, connected: false, state: 'not_connected', stateLabel: 'Ready to check', liveMode: null, message: 'Ready to check. This only reads your Postmark settings; no email is sent.' };
  }
  if (conn?.status === 'needs_reauth') {
    return { ...base, ...from, configured: true, connected: false, state: 'needs_reauth', liveMode: null, message: 'Postmark rejected the server token. Replace POSTMARK_SERVER_TOKEN on the server.' };
  }
  if (conn?.status === 'error') {
    return { ...base, ...from, configured: true, connected: false, state: 'error', liveMode: null, message: conn.lastError || 'The last Postmark check failed. Check again.' };
  }
  const sandbox = caps['deliveryType'] === 'sandbox';
  const liveMode = sandbox ? 'sandbox' : 'live';
  // Advisory DNS hints from the check (never errors: selectors and record names can differ).
  const hints = [
    caps['dmarcFound'] === false ? "We couldn't find a DMARC record for your sending domain." : null,
    caps['returnPathFound'] === false ? "We couldn't find the custom Return-Path record (pm-bounces) for your sending domain." : null,
  ].filter(Boolean);
  if (hints.length) Object.assign(from, { detail: [('detail' in from ? from.detail : null), ...hints].filter(Boolean).join(' ') });
  if (caps['approved'] === false) {
    return { ...base, ...from, configured: true, connected: true, state: 'awaiting_approval', stateLabel: 'Waiting for Postmark', liveMode, message: "Postmark is still reviewing your account. Until it's approved you can only email addresses at your own domain." };
  }
  if (caps['webhooksConfigured'] === false) {
    return {
      ...base,
      ...from,
      configured: true,
      connected: true,
      state: 'connected',
      stateLabel: 'Webhooks missing',
      pillStatus: 'pending_approval',
      liveMode,
      message: "Bounces and unsubscribes made through Postmark won't reach the app. Add the webhook (step 6 of the checklist). Marketing emails and review requests are on hold until then; information-only emails can still go.",
    };
  }
  return {
    ...base,
    ...from,
    configured: true,
    connected: true,
    state: 'connected',
    stateLabel: sandbox ? 'Test server' : 'Live',
    liveMode,
    message: sandbox ? "Emails are processed but not delivered to clients. Everything sent shows as 'Test — not delivered'." : 'Approved emails reach real clients. Every email still waits for your approval or an automation you switched on.',
  };
}

/** The Google rating card (Places API, Tier 1), pure. */
export function placesCard(env: IntegrationEnv, conn: ConnectionFact | undefined): IntegrationStatus {
  const missing = missingEnv(env, ['GOOGLE_MAPS_API_KEY']);
  const base = { id: 'google_places', name: 'Google rating (Places)', areas: ['reviews'] as IntegrationStatus['areas'], missingEnv: missing, verified: false };
  if (missing.length) {
    return { ...base, configured: false, connected: false, state: 'not_configured', liveMode: null, message: 'Optional: add a Google Maps key to show your Google rating on the Reviews page. Review requests work without it.' };
  }
  const placeId = typeof conn?.config?.['placeId'] === 'string' ? (conn.config['placeId'] as string) : null;
  if (!conn || !placeId) {
    return { ...base, configured: true, connected: false, state: 'not_connected', liveMode: null, message: 'Enter your Place ID under Reviews to show your Google rating.' };
  }
  if (conn.status === 'error') return { ...base, configured: true, connected: false, state: 'error', liveMode: null, message: `Google refused the request: ${conn.lastError ?? 'unknown reason'}` };
  if (conn.config?.['confirmed'] !== true) {
    return { ...base, configured: true, connected: false, state: 'not_connected', stateLabel: 'Confirm your place', liveMode: null, message: 'Confirm the place under Reviews before the rating is shown.' };
  }
  return { ...base, configured: true, connected: true, state: 'connected', liveMode: 'read_only', message: 'Your Google rating and review count are read once a day (rating from Google Maps).', ...(conn.displayName ? { detail: conn.displayName } : {}) };
}

/** Email sending (Postmark) and the Google rating (Places). */
export const buildEmailIntegrations: IntegrationBuilder = (env, facts: ConnectionFacts) => [postmarkCard(env, connectionFor(facts, 'postmark')), placesCard(env, connectionFor(facts, 'google_places'))];
