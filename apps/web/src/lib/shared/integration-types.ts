import type { IntegrationState, LiveMode } from '@studio/core';

export type { IntegrationState, LiveMode } from '@studio/core';

/** Sections of the app an integration belongs to (used to filter status cards per page). */
export type IntegrationArea = 'video' | 'publishing' | 'appointments' | 'email' | 'reviews' | 'website' | 'storage' | 'trends';

/** One integration as shown in Settings → Integrations and on each section page. Never contains secrets. */
export interface IntegrationStatus {
  id: string;
  name: string;
  areas: IntegrationArea[];
  /** The server has the credentials it needs (environment variables are present). */
  configured: boolean;
  /** An account is connected (or, for key-only services, the key is present and the feature is active). */
  connected: boolean;
  /** Plain-language explanation of the current state and what the owner needs to do next. */
  message: string;
  /** Names (never values) of environment variables still missing. */
  missingEnv: string[];
  /** Optional detail such as the model in use or the connected account name. */
  detail?: string;
  /**
   * The shared state word (Stage B/C contract): not_configured, not_connected, connected, awaiting_approval,
   * unavailable, needs_reauth or error. Older entries derive it from `configured`/`connected`.
   */
  state?: IntegrationState;
  /** Live data, a provider's development or sandbox mode, a staging site, or read-only access; null when not applicable. */
  liveMode?: LiveMode | null;
  /** A recorded live verification exists (first real post, Square self-test). Never set by a connection check. */
  verified?: boolean;
  /**
   * Words for the status pill when the state word alone would mislead, for example a links-only card that has no
   * account to connect ("Links only · no account needed" rather than "Ready to connect"). The pill keeps the state's
   * colour. Leave unset to use the shared words for the state.
   */
  stateLabel?: string;
}

/** The state word for a card: the explicit `state`, or one derived from the older booleans. */
export function integrationStateOf(i: Pick<IntegrationStatus, 'state' | 'configured' | 'connected'>): IntegrationState {
  if (i.state) return i.state;
  if (i.connected) return 'connected';
  return i.configured ? 'not_connected' : 'not_configured';
}

/** Plain label for a live mode, shown next to the state. */
export function liveModeLabel(mode: LiveMode | null | undefined): string | null {
  switch (mode) {
    case 'live':
      return 'Live';
    case 'development_live':
      return 'Live (development mode)';
    case 'sandbox':
      return 'Sandbox: test data only';
    case 'staging':
      return 'Staging site';
    case 'read_only':
      return 'Read-only, live data';
    default:
      return null;
  }
}
