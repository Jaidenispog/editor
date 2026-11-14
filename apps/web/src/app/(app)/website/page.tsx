import { Globe } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { WebsitePage as WebsitePageBody } from '@/components/website/website-page';
import { getCurrentUser } from '@/lib/session';
import { getSearchPerformance, getWebsiteOverview, listEdits } from '@/lib/website';

export const metadata: Metadata = { title: 'Website' };
export const dynamic = 'force-dynamic';

/**
 * Website and local search (design §10.1): owner-only. The setup checklist, the website check with prioritised
 * findings, prepared changes, and real Search Console numbers once Google is connected. No ranking promises.
 */
export default async function WebsitePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const header = (
    <PageHeader
      eyebrow="Website"
      title="Website and local search"
      description="See what Google and visitors see on your website, fix what matters first, and track real search numbers once Google is connected. We can't promise rankings — nobody can."
    />
  );
  if (user.role !== 'owner') {
    return (
      <>
        {header}
        <EmptyState icon={<Globe />} title="Only the studio owner can use the website tools." description="Ask the owner if something on the website needs changing." />
      </>
    );
  }
  const [overview, edits, search] = await Promise.all([getWebsiteOverview(), listEdits('open'), getSearchPerformance('28d', true)]);
  return (
    <>
      {header}
      <WebsitePageBody initial={overview} initialEdits={edits} initialSearch={search} />
    </>
  );
}
