import { ArrowLeft, UploadCloud } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@studio/core';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { formatDateTime } from '@/lib/format';
import { getProjectOrThrow } from '@/lib/projects';

export const metadata: Metadata = { title: 'Project' };

async function loadProject(id: string) {
  try {
    return await getProjectOrThrow(id);
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
}

/** Project page in the Video Studio. The upload and generation interface is added on top of this page. */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = await loadProject(projectId);
  return (
    <>
      <Link href="/studio" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-charcoal-600 hover:text-charcoal-950">
        <ArrowLeft className="size-4" aria-hidden="true" /> All projects
      </Link>
      <PageHeader eyebrow="Video Studio" title={project.title} description={project.clientName ? `Client: ${project.clientName}` : `Created ${formatDateTime(project.createdAt)}`} />
      <section aria-labelledby="video-studio-heading">
        <Card>
          <CardBody className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-charcoal-900" aria-hidden="true">
              <UploadCloud className="size-6" />
            </span>
            <h2 id="video-studio-heading" className="mt-4 text-lg font-semibold">
              Video Studio
            </h2>
            <p className="mt-2 max-w-md text-sm text-charcoal-600">
              {project.title} is ready. The upload and “Generate 5 edits” controls for this project are being added to this page next.
            </p>
            {project.notes ? <p className="mt-4 max-w-md rounded-lg bg-charcoal-50 px-4 py-3 text-left text-sm whitespace-pre-line text-charcoal-700">{project.notes}</p> : null}
          </CardBody>
        </Card>
      </section>
    </>
  );
}
