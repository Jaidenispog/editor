'use client';

import { SquareIntegrationCard } from '@/components/appointments/square-integration-card';
import type { IntegrationCardsProps } from './types';

/** Settings → Integrations card for Square appointments (WP6; WP6b adds the self-test and booking changes). */
export function SquareIntegrationCards({ integrations }: IntegrationCardsProps) {
  // Shown once Square is part of this deployment's list (it always is); the card loads its own detailed state.
  if (!integrations.some((i) => i.id === 'square')) return null;
  return <SquareIntegrationCard />;
}
