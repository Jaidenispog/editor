import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { applyEdit } from '@/lib/website';

/**
 * POST /api/website/edits/[id]/apply (owner) `{ confirm: true, expectedAfter, expectedBefore?, expectedDestination? }`:
 * the explicit "Apply now". 409 when the wording, the old text or the WordPress destination changed since the dialog
 * opened; 422 without a connected adapter that supports the change.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(
    req,
    z.object({
      confirm: z.literal(true),
      expectedAfter: z.string().max(5000),
      expectedBefore: z.string().max(5000).nullable().optional(),
      expectedDestination: z.object({ host: z.string().max(253), environment: z.enum(['live', 'staging']) }).optional(),
    }),
  );
  return NextResponse.json(
    await applyEdit(user, params.id, body.expectedAfter, {
      expectedBefore: body.expectedBefore,
      expectedDestination: body.expectedDestination,
    }),
    { status: 202 },
  );
});
