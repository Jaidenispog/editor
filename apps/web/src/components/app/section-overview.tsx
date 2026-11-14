import { CheckCircle2, ListChecks } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { getIntegrationStatuses, type IntegrationArea } from '@/lib/integrations';
import { IntegrationStatusList, IntegrationsSettingsLink } from './integration-status-list';

/**
 * Standard page for a section that depends on outside services: what the section will do, what the owner
 * must provide, and the live status of the related integrations. Shows no sample or invented data.
 */
export async function SectionOverview({
  eyebrow,
  title,
  description,
  area,
  features,
  requirements,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  area: IntegrationArea;
  features: string[];
  requirements: string[];
  children?: ReactNode;
}) {
  const integrations = (await getIntegrationStatuses()).filter((i) => i.areas.includes(area));
  const ready = integrations.length > 0 && integrations.every((i) => i.connected);
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Connections" description={ready ? 'Everything this section needs is connected.' : 'This section turns on once these are set up. Nothing here is simulated.'} actions={<IntegrationsSettingsLink />} />
          <CardBody>
            <IntegrationStatusList integrations={integrations} className="md:grid-cols-1" />
          </CardBody>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="What this section will do" />
            <CardBody>
              <ul className="space-y-3">
                {features.map((f) => (
                  <li key={f} className="flex gap-3 text-sm text-charcoal-700">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="What we need from you" />
            <CardBody>
              <ul className="space-y-3">
                {requirements.map((r) => (
                  <li key={r} className="flex gap-3 text-sm text-charcoal-700">
                    <ListChecks className="mt-0.5 size-4 shrink-0 text-charcoal-400" aria-hidden="true" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          {children}
        </div>
      </div>
    </>
  );
}
