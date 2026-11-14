import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { buttonClasses } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ConnectionsPanel } from '@/components/publishing/connections-panel';
import { PostList } from '@/components/publishing/post-list';
import { PublishingSettingsCard } from '@/components/publishing/publishing-settings-card';
import { getIntegrationStatuses } from '@/lib/integrations';
import { listPublishPosts } from '@/lib/publishing';
import { getCurrentUser } from '@/lib/session';
import { getSettings } from '@/lib/settings';

export const metadata: Metadata = { title: 'Publishing' };
export const dynamic = 'force-dynamic';

/**
 * Publishing: what needs the owner ("Your turn"), upcoming and in-progress posts, history, the honest connection
 * summary (posting it yourself always works) and the caption-ending setting.
 */
export default async function PublishingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const [queue, history, integrations, settings] = await Promise.all([listPublishPosts('queue', user, null), listPublishPosts('history', user, null), getIntegrationStatuses(), getSettings()]);
  return (
    <>
      <PageHeader
        eyebrow="Publishing"
        title="Publishing"
        description="Post finished edits to Instagram and TikTok with a caption and cover, now or at a Melbourne time. A post only shows as posted once the platform or you confirm it."
        actions={
          <Link href="/library" className={buttonClasses('primary', 'md', 'min-h-11')}>
            <Plus className="size-4" aria-hidden="true" /> Choose edits to publish
          </Link>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <PostList initialQueue={queue.posts} initialHistory={history.posts} isOwner={user.role === 'owner'} />
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Connections" />
            <CardBody>
              <ConnectionsPanel integrations={integrations.filter((i) => i.areas.includes('publishing'))} />
            </CardBody>
          </Card>
          <PublishingSettingsCard initialFooter={settings.publishing.captionFooter} canEdit={user.role === 'owner'} />
        </div>
      </div>
    </>
  );
}
