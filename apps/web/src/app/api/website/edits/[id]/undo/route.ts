import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { undoEdit } from '@/lib/website';

/** POST /api/website/edits/[id]/undo (owner): creates the reverse change; the owner applies it with the normal confirm. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return NextResponse.json({ edit: await undoEdit(user, params.id) }, { status: 201 });
});
