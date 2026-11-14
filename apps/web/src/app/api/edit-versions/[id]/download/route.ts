import { handleApi } from '@/lib/api';
import { DownloadKindSchema } from '@/lib/shared/studio-schemas';
import { downloadLink } from '@/lib/studio-edits';

/** GET /api/edit-versions/[id]/download — { url, filename }: expiring link to the export (or ?kind=preview). */
export const GET = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const kind = DownloadKindSchema.parse(req.nextUrl.searchParams.get('kind') ?? undefined);
  return downloadLink(params.id, user, kind);
});
