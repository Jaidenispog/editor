import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { requestDraft } from '@/lib/website';

/** POST /api/website/edits/[id]/draft (owner): queues AI wording (titles and descriptions; only when AI is set up). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return NextResponse.json(await requestDraft(user, params.id), {
    status: 202,
  });
});
