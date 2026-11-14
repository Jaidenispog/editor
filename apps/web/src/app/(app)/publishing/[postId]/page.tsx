import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { isAppError } from '@studio/core';
import { schema } from '@studio/db';
import { PageHeader } from '@/components/ui/page-header';
import { PostDetail } from '@/components/publishing/post-detail';
import { getDb } from '@/lib/db';
import { maybeSignedUrl } from '@/lib/media-links';
import { getPublishPost, postHistory } from '@/lib/publishing';
import { getCurrentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Post' };
export const dynamic = 'force-dynamic';

/** One post: the video, the caption, one card per destination with its manual steps and actions, and its history. */
export default async function PublishPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/publishing/${postId}`)}`);
  let post;
  try {
    post = await getPublishPost(postId, user);
  } catch (err) {
    if (isAppError(err) && err.code === 'NOT_FOUND') notFound();
    throw err;
  }
  const history = await postHistory(postId, user);
  const version = await getDb().query.editVersions.findFirst({ columns: { previewKey: true }, where: eq(schema.editVersions.id, post.versionId) });
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/publishing" className="hover:underline">
            Publishing
          </Link>
        }
        title={`${post.projectTitle} · ${post.styleName}`}
        description={post.versionNo ? `Version ${post.versionNo}` : undefined}
      />
      <PostDetail initial={{ ...post, history }} previewUrl={await maybeSignedUrl(version?.previewKey ?? null)} isOwner={user.role === 'owner'} />
    </>
  );
}
