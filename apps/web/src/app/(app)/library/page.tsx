import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { Download, Library } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { STYLES, type StyleId } from '@studio/core';
import { schema } from '@studio/db';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { buttonClasses } from '@/components/ui/button';
import { getDb } from '@/lib/db';
import { formatBytes, formatDateTime, formatSeconds } from '@/lib/format';
import { downloadNameFor, maybeSignedUrl } from '@/lib/media-links';

export const metadata: Metadata = { title: 'Content Library' };

function styleName(id: string): string {
  return (STYLES as Record<string, { name: string } | undefined>)[id as StyleId]?.name ?? id;
}

/** Content Library: every rendered preview and exported edit across projects, newest first. */
export default async function LibraryPage() {
  const rows = await getDb()
    .select({
      versionId: schema.editVersions.id,
      versionNo: schema.editVersions.versionNo,
      status: schema.editVersions.status,
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
    .where(and(isNull(schema.projects.deletedAt), isNull(schema.edits.deletedAt), or(isNotNull(schema.editVersions.previewKey), isNotNull(schema.editVersions.exportKey))))
    .orderBy(desc(schema.editVersions.updatedAt))
    .limit(60);

  const items = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      previewUrl: await maybeSignedUrl(r.previewKey),
      exportUrl: r.exportStatus === 'ready' ? await maybeSignedUrl(r.exportKey, { downloadName: downloadNameFor([r.projectTitle, styleName(r.styleId), `v${r.versionNo}`], 'mp4') }) : null,
    })),
  );

  return (
    <>
      <PageHeader eyebrow="Content Library" title="Content Library" description="Every preview and full-quality export you have made, across all projects. Links to the files expire, so refresh the page if one stops working." />
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
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <li key={item.versionId}>
              <Card className="overflow-hidden">
                <div className="aspect-[9/16] w-full bg-charcoal-950">
                  {item.previewUrl ? (
                    <video src={item.previewUrl} controls preload="metadata" playsInline className="size-full object-contain" aria-label={`Preview of ${styleName(item.styleId)} for ${item.projectTitle}`} />
                  ) : (
                    <div className="flex size-full items-center justify-center px-6 text-center text-sm text-charcoal-400">Preview not available</div>
                  )}
                </div>
                <div className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{styleName(item.styleId)}</p>
                    <StatusPill status={item.exportStatus === 'ready' ? 'ready' : item.status} label={item.exportStatus === 'ready' ? 'Exported' : undefined} />
                  </div>
                  <Link href={`/studio/${item.projectId}`} className="block truncate text-sm text-charcoal-600 hover:underline">
                    {item.projectTitle}
                  </Link>
                  <p className="text-xs text-charcoal-500">
                    Version {item.versionNo}
                    {item.previewDurationSec ? ` · ${formatSeconds(item.previewDurationSec)}` : ''} · {formatDateTime(item.updatedAt)}
                  </p>
                  {item.exportUrl ? (
                    <a href={item.exportUrl} className={buttonClasses('secondary', 'sm', 'w-full')}>
                      <Download className="size-4" aria-hidden="true" /> Download MP4{item.exportByteSize ? ` (${formatBytes(item.exportByteSize)})` : ''}
                    </a>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
