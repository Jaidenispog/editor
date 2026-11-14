import { handleApi } from '@/lib/api';
import { ExportVariantQuerySchema } from '@/lib/shared/studio-schemas';
import { requestExport } from '@/lib/studio-edits';

/**
 * POST /api/edit-versions/[id]/export[?variant=no_music] — queues the full-quality render (idempotent while queued or
 * rendering). The standard file needs music the licence clears (409 with `details.musicClearance` otherwise); the
 * music-free file of the same version never does.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const variant = ExportVariantQuerySchema.parse(req.nextUrl.searchParams.get('variant') ?? undefined);
  return Response.json(await requestExport(params.id, user, variant), { status: 202 });
});
