import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { Composer } from '@/components/publishing/composer';
import { getCurrentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Publish' };
export const dynamic = 'force-dynamic';

/** The composer for the edits in `?versions=a,b` (only those; nothing is preselected for the owner). */
export default async function NewPublishPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp['versions']) ? sp['versions'].join(',') : (sp['versions'] ?? '');
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9-]{1,64}$/.test(s))
    .slice(0, 5);
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/publishing/new${raw ? `?versions=${raw}` : ''}`)}`);
  return (
    <>
      <PageHeader eyebrow="Publishing" title="Publish" description="Set a caption and cover, choose where each video goes and when. You see exactly what will be posted before anything is sent." />
      <Composer initialVersionIds={ids} />
    </>
  );
}
