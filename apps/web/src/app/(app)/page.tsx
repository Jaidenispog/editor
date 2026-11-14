import { inArray } from 'drizzle-orm';
import { Activity, ArrowRight, FolderOpen, PlugZap } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { schema } from '@studio/db';
import { countNeedingSetup, integrationPill } from '@/components/app/integration-pill';
import { JobList } from '@/components/app/job-list';
import { NewProjectButton } from '@/components/app/new-project-dialog';
import { ProjectCard } from '@/components/app/project-card';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { getDb } from '@/lib/db';
import { getIntegrationStatuses } from '@/lib/integrations';
import { listActiveJobs, toJobDto } from '@/lib/jobs';
import { listProjects } from '@/lib/projects';
import type { SessionUser } from '@/lib/auth';
import { getCurrentUser } from '@/lib/session';
import { workerNotice } from '@/lib/shared/worker-notice';
import { getWorkerStatus } from '@/lib/worker-status';

export const metadata: Metadata = { title: 'Dashboard' };

async function activeJobsWithTitles(user: SessionUser) {
  const jobs = await listActiveJobs(user, 10);
  const ids = [...new Set(jobs.map((j) => j.projectId).filter((x): x is string => Boolean(x)))];
  const titles = ids.length
    ? new Map((await getDb().select({ id: schema.projects.id, title: schema.projects.title }).from(schema.projects).where(inArray(schema.projects.id, ids))).map((p) => [p.id, p.title]))
    : new Map<string, string>();
  return jobs.map((j) => toJobDto(j, j.projectId ? (titles.get(j.projectId) ?? null) : null));
}

/** Dashboard: recent projects, jobs in progress and integration status at a glance. */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  // Staff see only their own projects and jobs; the owner sees everything.
  const [projects, jobs, integrations, worker] = await Promise.all([listProjects(user, { limit: 6 }), activeJobsWithTitles(user), getIntegrationStatuses(), getWorkerStatus()]);
  // Shown only when no worker heartbeat is fresh; the quieter wording when nothing is waiting yet.
  const notice = workerNotice(worker, jobs.length > 0, { whenIdle: true });
  const firstName = user.displayName.split(/\s+/)[0] ?? '';
  const active = integrations.filter((i) => i.connected).length;
  const needsSetup = countNeedingSetup(integrations);

  return (
    <>
      <PageHeader eyebrow="Dashboard" title={firstName ? `G’day, ${firstName}` : 'Dashboard'} description="Pick up where you left off, or start a new project from today’s cuts." actions={<NewProjectButton />} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section aria-labelledby="recent-projects" className="xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="recent-projects" className="text-lg font-semibold">
              Recent projects
            </h2>
            {projects.length ? (
              <Link href="/studio" className="inline-flex items-center gap-1 text-sm font-medium text-charcoal-700 hover:text-charcoal-950">
                All projects <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
          {projects.length === 0 ? (
            <EmptyState icon={<FolderOpen />} title="No projects yet" description="Create your first project, then add the clips you filmed of a haircut." action={<NewProjectButton />} />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {projects.map((p) => (
                <li key={p.id}>
                  <ProjectCard project={p} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          <Card>
            <CardHeader title="In progress" description="Clips being analysed and edits being rendered." />
            <CardBody className="space-y-3 pt-2">
              {notice ? (
                <Alert tone="warning" title={notice.title}>
                  {notice.body}
                </Alert>
              ) : null}
              {jobs.length === 0 ? (
                <div className="flex items-center gap-3 rounded-lg bg-charcoal-50 px-4 py-4 text-sm text-charcoal-600">
                  <Activity className="size-5 text-charcoal-400" aria-hidden="true" />
                  {notice ? 'Nothing is waiting right now.' : 'Nothing is running right now.'}
                </div>
              ) : (
                <JobList jobs={jobs} showProject />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Integrations"
              description={`${active} active · ${needsSetup} need setup`}
              actions={
                <Link href="/settings?tab=integrations" className="text-sm font-medium text-charcoal-700 hover:text-charcoal-950">
                  Manage
                </Link>
              }
            />
            <CardBody className="pt-3">
              <ul className="space-y-2.5">
                {integrations.map((i) => {
                  const pill = integrationPill(i);
                  return (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                      <span className="flex min-w-0 items-center gap-2 text-charcoal-800">
                        <PlugZap className="size-4 shrink-0 text-charcoal-400" aria-hidden="true" />
                        <span className="min-w-0 truncate" title={i.name}>
                          {i.name}
                        </span>
                      </span>
                      <StatusPill status={pill.status} label={pill.label} />
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
