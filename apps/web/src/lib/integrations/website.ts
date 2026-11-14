import type { IntegrationStatus } from '../shared/integration-types.js';
import { connectionFor, envSentence, missingEnv, type ConnectionFact, type IntegrationBuilder } from './types.js';

/**
 * Website module cards (design §10.5): Google Search Console (read-only, through the shared Google sign-in with
 * `product=search_console`) and Website editing (WordPress, optional; needs no server settings). Pure, unit tested.
 * Messages never start with "Needs setup:" (the pill says it) and never imply data or access that isn't there.
 */

/** The Search Console property chosen for the website, if any. */
export function chosenProperty(conn: ConnectionFact | undefined): string | null {
  const v = conn?.config?.['siteUrl'];
  return typeof v === 'string' && v ? v : null;
}

function searchConsoleCard(env: Parameters<IntegrationBuilder>[0], conn: ConnectionFact | undefined): IntegrationStatus {
  const missing = missingEnv(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const base = {
    id: 'google_search_console',
    name: 'Google Search Console',
    areas: ['website' as const],
    missingEnv: missing,
    configured: missing.length === 0,
    verified: false,
  };
  if (missing.length) {
    return {
      ...base,
      connected: false,
      state: 'not_configured',
      liveMode: null,
      message: `Optional: shows how many people found you on Google search. It needs a Google Cloud project: add ${envSentence(missing)} to the server (see the setup steps).`,
    };
  }
  if (!conn || conn.status === 'disconnected' || conn.status === 'not_configured') {
    return {
      ...base,
      connected: false,
      state: 'not_connected',
      liveMode: null,
      message: 'Connect Google Search Console to see real search numbers. Your website must be verified in Search Console first.',
    };
  }
  if (conn.status === 'needs_reauth') {
    return {
      ...base,
      connected: false,
      state: 'needs_reauth',
      liveMode: 'read_only',
      message: conn.lastError || 'Google needs you to sign in again. Reconnect Search Console.',
    };
  }
  if (conn.status === 'error') {
    return {
      ...base,
      connected: false,
      state: 'error',
      liveMode: 'read_only',
      message: conn.lastError || "Search Console couldn't be checked. Press Check again.",
    };
  }
  const property = chosenProperty(conn);
  if (!property) {
    return {
      ...base,
      connected: true,
      state: 'connected',
      stateLabel: 'Choose property',
      pillStatus: 'manual_step_required',
      liveMode: 'read_only',
      message: conn.lastError || 'Connected. Choose the Search Console property for your website on the Website page.',
    };
  }
  return {
    ...base,
    connected: true,
    state: 'connected',
    liveMode: 'read_only',
    detail: property,
    message: "Connected (read-only, live data). Studio Assistant can't change anything in Search Console.",
  };
}

function wordPressCard(conn: ConnectionFact | undefined): IntegrationStatus {
  const base = {
    id: 'website_editing',
    name: 'Website editing (WordPress)',
    areas: ['website' as const],
    missingEnv: [],
    configured: true,
    verified: false,
  };
  const environment = conn?.capabilities?.['environment'] === 'live' ? 'live' : conn?.capabilities?.['environment'] === 'staging' ? 'staging' : null;
  if (!conn || conn.status === 'disconnected') {
    return {
      ...base,
      connected: false,
      state: 'not_connected',
      liveMode: null,
      message: 'Optional: connect a WordPress site to apply page text and image descriptions from here. Every other change comes with copy-paste steps.',
    };
  }
  if (conn.status === 'not_configured') {
    return {
      ...base,
      connected: false,
      state: 'not_connected',
      stateLabel: 'Checking',
      pillStatus: 'processing',
      liveMode: null,
      message: 'Saved. Checking the connection (read-only); nothing on your site changes.',
    };
  }
  if (conn.status === 'needs_reauth')
    return {
      ...base,
      connected: false,
      state: 'needs_reauth',
      liveMode: environment,
      message: conn.lastError || 'WordPress refused the connection. Enter a new Application Password.',
    };
  if (conn.status === 'error')
    return {
      ...base,
      connected: false,
      state: 'error',
      liveMode: environment,
      message: conn.lastError || "WordPress couldn't be checked. Press Check again.",
    };
  const roles = typeof conn.capabilities?.['roles'] === 'string' ? conn.capabilities['roles'] : '';
  const role = roles.includes('administrator') ? 'Administrator' : roles.includes('editor') ? 'Editor' : roles.split(',')[0] || 'user';
  const who = conn.displayName ? `${conn.displayName} (${role})` : role;
  return {
    ...base,
    connected: true,
    state: 'connected',
    liveMode: environment ?? 'live',
    detail: `${role} · ${environment === 'staging' ? 'staging site' : 'live site'}`,
    message: `Connected as ${who}. Changes from here: page text and image descriptions. Page titles, search descriptions and structured data are changed by hand (steps provided).${typeof conn.capabilities?.['note'] === 'string' ? ` ${conn.capabilities['note']}` : ''}`,
  };
}

/** Google Search Console and Website editing (WordPress). */
export const buildWebsiteIntegrations: IntegrationBuilder = (env, facts) => [
  searchConsoleCard(env, connectionFor(facts, 'google_search_console')),
  wordPressCard(connectionFor(facts, 'website')),
];
