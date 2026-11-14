import { IntegrationStatusList } from '@/components/app/integration-status-list';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { IntegrationStatus } from '@/lib/shared/integration-types';

/** Integration status cards with the names of any missing server settings (values are never shown). */
export function IntegrationsTab({ integrations }: { integrations: IntegrationStatus[] }) {
  return (
    <Card>
      <CardHeader
        title="Integrations"
        description="Server settings are added by whoever hosts the app (for example in the hosting dashboard or the .env file) and take effect after a restart. Secret values are never shown here."
      />
      <CardBody>
        <IntegrationStatusList integrations={integrations} showEnv />
      </CardBody>
    </Card>
  );
}
