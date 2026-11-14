import type { IntegrationStatus } from '@/lib/shared/integration-types';

/** What every module's Settings → Integrations card component receives. */
export interface IntegrationCardsProps {
  /** Every integration status (a module picks its own entries by id). */
  integrations: IntegrationStatus[];
}
