import { AppError } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { createReferenceUpload } from '@/lib/references';
import { CreateUploadSchema } from '@/lib/shared/studio-schemas';

/**
 * POST /api/references/uploads?projectId=…&useVision=1 — starts a chunked upload of a reference video (style only)
 * in a project the user can open. The body is the usual upload body; `useVision=1` records the owner's tick for the
 * on-screen text estimate (it is used only when AI is set up). Parts and completion use the normal upload routes.
 */
export const POST = handleApi(async ({ req, user }) => {
  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new AppError('VALIDATION', 'Choose the project to add the reference video to.', { details: [{ path: 'projectId', message: 'Required' }] });
  const useVision = req.nextUrl.searchParams.get('useVision') === '1';
  const body = await parseJson(req, CreateUploadSchema.omit({ kind: true }).extend({ kind: CreateUploadSchema.shape.kind.optional() }));
  const { kind: _ignored, ...rest } = body;
  return Response.json(await createReferenceUpload(projectId, user, rest, useVision), { status: 201 });
});
