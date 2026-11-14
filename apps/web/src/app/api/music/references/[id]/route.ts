import { handleApi, parseJson } from '@/lib/api';
import { UpdateReferenceSchema, deleteReference, updateReference } from '@/lib/music-references';

/** PATCH /api/music/references/[id] — { notes } (owner only). */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, UpdateReferenceSchema);
  return { reference: await updateReference(params.id, user, body) };
});

/** DELETE /api/music/references/[id] — removes the reference (owner only). */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  await deleteReference(params.id, user);
  return { ok: true };
});
