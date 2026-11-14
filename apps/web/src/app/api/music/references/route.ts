import { handleApi, parseJson } from '@/lib/api';
import { AddReferenceSchema, addReference, listReferences } from '@/lib/music-references';

/** GET /api/music/references — { mode, storedMode, canEmbed, missing, notice, references } (signed in). */
export const GET = handleApi(async () => listReferences());

/** POST /api/music/references — { url, notes? } → the saved reference (owner only; 409 when already saved). */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, AddReferenceSchema);
  return Response.json({ reference: await addReference(user, body) }, { status: 201 });
});
