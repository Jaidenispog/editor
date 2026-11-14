import { ReferenceSuggestionFieldSchema } from '@studio/core';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { decideReference } from '@/lib/references';

const DecideSchema = z
  .object({ accept: z.array(ReferenceSuggestionFieldSchema).max(4).default([]), dismiss: z.array(ReferenceSuggestionFieldSchema).max(4).default([]) })
  .strict();

/** POST /api/references/[assetId]/decide — { accept, dismiss }: use or dismiss a reference's suggestions (owner only). */
export const POST = handleApi<{ assetId: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, DecideSchema);
  return decideReference(user, params.assetId, body);
});
