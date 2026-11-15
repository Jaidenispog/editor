import { ReferenceSummaryFieldSchema } from '@studio/core';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { decideReferenceSummary } from '@/lib/references';

const DecideSchema = z
  .object({
    accept: z.array(ReferenceSummaryFieldSchema).max(10).default([]),
    dismiss: z.array(ReferenceSummaryFieldSchema).max(10).default([]),
    valueKeys: z.partialRecord(ReferenceSummaryFieldSchema, z.string().max(400)).default({}),
  })
  .strict();

/**
 * POST /api/references/summary/decide — { accept, dismiss, valueKeys }: use or dismiss summary rows (owner only).
 * 409 when a row's suggestion changed since it was shown.
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, DecideSchema);
  return decideReferenceSummary(user, body);
});
