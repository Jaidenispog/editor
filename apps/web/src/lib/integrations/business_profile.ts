import { BUSINESS_PROFILE_AWAITING_APPROVAL_MESSAGE, businessProfileApiState } from '@studio/core';
import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type ConnectionFact, type IntegrationBuilder, type IntegrationEnv } from './types.js';

/**
 * Google Business Profile (memo §7 Tier 2; email design §4.8 and §9.3, website design §4.7 and §10.5). One connection
 * (`google_business_profile`, scope `business.manage`, through the shared Google sign-in) serves the "Reviews on
 * Google" list and the Performance numbers. Google gives a project quota 0 until it approves Basic API Access, which
 * shows as "Waiting for Google approval", never as an error. Pure, unit tested; no message starts with "Needs setup:".
 */

/**
 * Where the connection stands, as the Reviews tab, the Website card and the Settings card show it. `checking` only
 * while a check is really queued or running; signed in with no check recorded and none running is `not_checked`.
 */
export type BusinessProfileState = 'not_configured' | 'not_connected' | 'checking' | 'not_checked' | 'awaiting_approval' | 'choose_location' | 'needs_reauth' | 'error' | 'connected';

/** Where Performance stands on the same connection. */
export type ProfilePerformanceState = 'not_connected' | 'not_checked' | 'awaiting_approval' | 'api_disabled' | 'error' | 'available';

/** The chosen location's name and title, or null. */
export function chosenProfileLocation(conn: ConnectionFact | undefined): { name: string; title: string } | null {
  const loc = conn?.config?.['location'];
  if (typeof loc !== 'string' || !/^locations\/[A-Za-z0-9_-]{1,100}$/.test(loc)) return null;
  const title = conn?.config?.['locationTitle'];
  return { name: loc, title: typeof title === 'string' ? title : '' };
}

/**
 * The connection's state from server settings and the stored row (pure). `checkInFlight` says whether a
 * `reviews.gbp.sync` is queued or running (the caller looks it up); without it, a row Google has not answered for yet is
 * `not_checked`, never "checking".
 */
export function businessProfileState(env: IntegrationEnv, conn: ConnectionFact | undefined, checkInFlight = false): BusinessProfileState {
  if (missingEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']).length) return 'not_configured';
  if (!conn || conn.status === 'disconnected' || conn.status === 'not_configured') return 'not_connected';
  if (conn.status === 'needs_reauth') return 'needs_reauth';
  if (conn.status === 'error') return 'error';
  const access = businessProfileApiState(conn.capabilities?.['apiAccess']);
  if (access === 'awaiting_approval') return 'awaiting_approval';
  if (access === null) return checkInFlight ? 'checking' : 'not_checked';
  if (!chosenProfileLocation(conn)) return 'choose_location';
  return 'connected';
}

/** Performance on the same connection (website design §10.5, derived). */
export function profilePerformanceState(env: IntegrationEnv, conn: ConnectionFact | undefined): ProfilePerformanceState {
  const state = businessProfileState(env, conn);
  if (state === 'awaiting_approval') return 'awaiting_approval';
  if (state !== 'connected') return 'not_connected';
  const perf = businessProfileApiState(conn?.capabilities?.['performanceApi']);
  if (perf === 'available') return 'available';
  if (perf === 'awaiting_approval') return 'awaiting_approval';
  if (perf === 'api_disabled') return 'api_disabled';
  if (perf === 'error') return 'error';
  return 'not_checked';
}

/** The Settings card's one Performance line (website design §4.7). While a check runs it never asks to check again. */
export function performanceLine(state: ProfilePerformanceState, checkInFlight = false): string | null {
  switch (state) {
    case 'available':
      return 'Performance numbers: available.';
    case 'awaiting_approval':
      return 'Performance numbers: waiting for Google approval.';
    case 'api_disabled':
      return 'Performance numbers: the Business Profile Performance API is not turned on in Google Cloud.';
    case 'error':
      return checkInFlight ? "Performance numbers: Google's last answer couldn't be used; a new check is running." : "Performance numbers: Google's last answer couldn't be used. Press Check again.";
    case 'not_checked':
      return 'Performance numbers: not checked yet.';
    default:
      return null;
  }
}

/** The Settings → Integrations card (pure). `checkInFlight`: a `reviews.gbp.sync` is queued or running. */
export function businessProfileCard(env: IntegrationEnv, conn: ConnectionFact | undefined, checkInFlight = false): IntegrationStatus {
  const missing = missingEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const state = businessProfileState(env, conn, checkInFlight);
  const location = chosenProfileLocation(conn);
  const perf = performanceLine(profilePerformanceState(env, conn), checkInFlight);
  const base = {
    id: 'google_business_profile',
    name: 'Google Business Profile',
    areas: ['reviews', 'website'] as IntegrationStatus['areas'],
    configured: missing.length === 0,
    missingEnv: missing,
    verified: false,
    ...(location?.title ? { detail: location.title } : {}),
  };
  const withPerf = (text: string) => (perf ? `${text} ${perf}` : text);
  switch (state) {
    case 'not_configured':
      return {
        ...base,
        connected: false,
        state,
        liveMode: null,
        message: `Optional: lists your Google reviews and Business Profile numbers here. It needs a Google Cloud project (add ${envSentence(missing)} to the server) and Google's approval. Review requests work without it.`,
      };
    case 'not_connected':
      return { ...base, connected: false, state, liveMode: null, message: 'Connect your Business Profile to list your Google reviews here. It needs Google’s approval, which isn’t guaranteed for a single shop.' };
    case 'needs_reauth':
      return { ...base, connected: false, state, liveMode: 'read_only', message: conn?.lastError || 'Google needs you to sign in again. Reconnect your Business Profile.' };
    case 'error':
      if (checkInFlight) {
        return { ...base, connected: false, state, stateLabel: 'Checking again', pillStatus: 'processing', liveMode: 'read_only', message: "The last check couldn't read your Business Profile. Checking again now (read-only)…" };
      }
      return { ...base, connected: false, state, liveMode: 'read_only', message: conn?.lastError || "Your Business Profile couldn't be read. Press Check again." };
    case 'awaiting_approval':
      return { ...base, connected: true, state, stateLabel: 'Waiting for Google', liveMode: 'read_only', message: BUSINESS_PROFILE_AWAITING_APPROVAL_MESSAGE };
    case 'checking':
      return { ...base, connected: true, state: 'connected', stateLabel: 'Checking', pillStatus: 'processing', liveMode: 'read_only', message: 'Signed in. Checking your Business Profile (read-only)…' };
    case 'not_checked':
      return {
        ...base,
        connected: true,
        state: 'connected',
        stateLabel: 'Not checked yet',
        pillStatus: 'manual_step_required',
        liveMode: 'read_only',
        message: 'Signed in. Google hasn’t been asked about your Business Profile yet, or the first check didn’t finish. Press Check again under Reviews → Reviews on Google.',
      };
    case 'choose_location':
      return {
        ...base,
        connected: true,
        state: 'connected',
        stateLabel: 'Choose location',
        pillStatus: 'manual_step_required',
        liveMode: 'read_only',
        message: conn?.lastError || 'Choose which Business Profile location is the studio, under Reviews → Reviews on Google.',
      };
    default:
      return {
        ...base,
        connected: true,
        state: 'connected',
        liveMode: 'read_only',
        message: withPerf("Connected (read-only, live data). Studio Assistant can't change or reply to anything on Google."),
      };
  }
}

/** Google Business Profile: one card for reviews and Performance. */
export const buildBusinessProfileIntegrations: IntegrationBuilder = (env, facts) => [
  businessProfileCard(env, connectionFor(facts, 'google_business_profile'), facts.checksInFlight?.includes('google_business_profile') ?? false),
];
