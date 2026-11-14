import { statusLabel } from '@/components/ui/status-words';
import { integrationStateOf, type IntegrationStatus } from '@/lib/shared/integration-types';

/** The status pill of an integration card: a status word (for its colour) and the words shown. */
export interface IntegrationPill {
  status: string;
  label: string;
  /** Which icon the card shows: active, ready to connect, or anything else. */
  icon: 'connected' | 'ready' | 'idle';
}

/** Card words for the shared states; the rest use the app-wide status words ("Reconnect needed", "Not available"). */
const STATE_WORDS: Partial<Record<string, string>> = {
  connected: 'Active',
  not_connected: 'Ready to connect',
  not_configured: 'Needs setup',
  error: 'Not working',
};

/**
 * The pill for an integration, from its real state, used everywhere an integration is listed (Settings →
 * Integrations, section pages, the dashboard and module cards), so one card always reads the same. A card's own
 * `stateLabel` replaces the words and its `pillStatus` the colour; neither changes the state or the counts.
 */
export function integrationPill(i: Pick<IntegrationStatus, 'state' | 'configured' | 'connected' | 'stateLabel' | 'pillStatus'>): IntegrationPill {
  const state = integrationStateOf(i);
  const label = i.stateLabel ?? STATE_WORDS[state] ?? statusLabel(state);
  const icon = state === 'connected' ? 'connected' : state === 'not_connected' && !i.stateLabel ? 'ready' : 'idle';
  return { status: i.pillStatus ?? state, label, icon };
}

/** How many integrations still need a server setting (the dashboard's "need setup" count). */
export function countNeedingSetup(integrations: ReadonlyArray<Pick<IntegrationStatus, 'state' | 'configured' | 'connected'>>): number {
  return integrations.filter((i) => integrationStateOf(i) === 'not_configured').length;
}
