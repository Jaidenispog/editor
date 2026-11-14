import { handleApi } from '@/lib/api';
import { DownloadKindSchema } from '@/lib/shared/studio-schemas';
import { downloadLink } from '@/lib/studio-edits';

/**
 * GET /api/edit-versions/[id]/download[?kind=export_no_music|preview] — { url, filename, label?, musicClearance? }: an
 * expiring link to the export (default), the music-free export or the preview.
 */
export const GET = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const kind = DownloadKindSchema.parse(req.nextUrl.searchParams.get('kind') ?? undefined);
  return downloadLink(params.id, user, kind);
});
