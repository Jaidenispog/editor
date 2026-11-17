import { EDITING_STYLE_ROW_FIELDS } from '@studio/core';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { resetReferenceSummary } from '@/lib/references';

/** No body (or `{}`): every row. `{ field }`: that row only ("Change: use each style's own" on it). */
const ResetSchema = z.object({ field: z.enum(EDITING_STYLE_ROW_FIELDS).optional() }).strict();

/**
 * POST /api/references/summary/reset — "Go back to each style's own": transitions, beat, reveal, zoom and music
 * matching return to the defaults; length, pace, colour and text stay as they are (owner only). With `{ field }`, only
 * that row's editing-style values go back, every one accepting it set ("Cutting to the beat" also the beats per cut).
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, ResetSchema);
  return resetReferenceSummary(user, body.field);
});
