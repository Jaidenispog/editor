import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { Library } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { META_ONLY_FILE_SUFFIX, META_ONLY_LABEL, STYLES, musicClearanceFor, type StyleId } from '@studio/core';
import { schema } from '@studio/db';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { buttonClasses } from '@/components/ui/button';
import { LibraryGrid, type LibraryItem } from '@/components/publishing/library-grid';
import { getDb } from '@/lib/db';
import { formatBytes, formatDateTime, formatSeconds } from '@/lib/format';
import { downloadNameFor, maybeSignedUrl } from '@/lib/media-links';
import { publishBadgesFor } from '@/lib/publishing';
import { getCurrentUser } from '@/lib/session';
import { projectVisibilityFilter } from '@/lib/studio-access';

export const metadata: Metadata = { title: 'Content Library' };

function styleName(id: string): string {
  return (STYLES as Record<string, { name: string } | undefined>)[id as StyleId]?.name ?? id;
}

/**
 * Content Library: every rendered preview and exported edit across the projects the user may open, newest first,
 * with per-platform publishing badges, a Publish link per finished edit and a Select mode for publishing several.
 */
export default async function LibraryPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const db = getDb();
  const rows = await db
    .select({
      versionId: schema.editVersions.id,
      versionNo: schema.editVersions.versionNo,
      status: schema.editVersions.status,
      plan: schema.editVersions.plan,
      previewKey: schema.editVersions.previewKey,
      previewDurationSec: schema.editVersions.previewDurationSec,
      exportStatus: schema.editVersions.exportStatus,
      exportKey: schema.editVersions.exportKey,
      exportByteSize: schema.editVersions.exportByteSize,
      updatedAt: schema.editVersions.updatedAt,
      styleId: schema.edits.styleId,
      isFavourite: schema.edits.isFavourite,
      projectId: schema.projects.id,
      projectTitle: schema.projects.title,
    })
    .from(schema.editVersions)
    .innerJoin(schema.edits, eq(schema.editVersions.editId, schema.edits.id))
    .innerJoin(schema.projects, eq(schema.edits.projectId, schema.projects.id))
    .where(and(isNull(schema.projects.deletedAt), projectVisibilityFilter(user), isNull(schema.edits.deletedAt), or(isNotNull(schema.editVersions.previewKey), isNotNull(schema.editVersions.exportKey))))
    .orderBy(desc(schema.editVersions.updatedAt))
    .limit(60);

  const trackIds = [...new Set(rows.map((r) => r.plan?.audio.music?.trackId).filter((x): x is string => Boolean(x)))];
  const tracks = trackIds.length ? await db.query.musicTracks.findMany({ where: inArray(schema.musicTracks.id, trackIds) }) : [];
  const badges = await publishBadgesFor(rows.map((r) => r.versionId), user);

  const items: LibraryItem[] = await Promise.all(
    rows.map(async (r) => {
      const track = tracks.find((t) => t.id === r.plan?.audio.music?.trackId);
      const metaOnly = Boolean(track && !track.deletedAt && musicClearanceFor(track.licence).destinationLock === 'meta_only');
      const exported = r.exportStatus === 'ready';
      return {
        versionId: r.versionId,
        versionNo: r.versionNo,
        status: r.status,
        previewUrl: await maybeSignedUrl(r.previewKey),
        exportUrl: exported ? await maybeSignedUrl(r.exportKey, { downloadName: downloadNameFor([r.projectTitle, styleName(r.styleId), `v${r.versionNo}`, metaOnly ? META_ONLY_FILE_SUFFIX : null], 'mp4') }) : null,
        exportSizeLabel: exported && r.exportByteSize ? formatBytes(r.exportByteSize) : null,
        durationLabel: r.previewDurationSec ? formatSeconds(r.previewDurationSec) : '',
        updatedLabel: formatDateTime(r.updatedAt),
        styleName: styleName(r.styleId),
        projectId: r.projectId,
        projectTitle: r.projectTitle,
        publishable: r.status === 'preview_ready' && Boolean(r.plan),
        exported,
        downloadLabel: exported && metaOnly ? META_ONLY_LABEL : null,
        badges: badges.filter((b) => b.versionId === r.versionId),
      };
    }),
  );

  return (
    <>
      <PageHeader eyebrow="Content Library" title="Content Library" description="Every preview and full-quality export across the projects you can open. Links to the files expire, so refresh the page if one stops working." />
      {items.length === 0 ? (
        <EmptyState
          icon={<Library />}
          title="Nothing rendered yet"
          description="When you generate edits in the Video Studio, their previews and exports appear here."
          action={
            <Link href="/studio" className={buttonClasses('primary')}>
              Go to the Video Studio
            </Link>
          }
        />
      ) : (
        <LibraryGrid items={items} />
      )}
    </>
  );
}
