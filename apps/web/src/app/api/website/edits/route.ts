import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createOwnerEdit, listEdits } from '@/lib/website';

const OwnerEditSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image_alt_text'),
    pageUrl: z.string().url().max(500),
    imageSrc: z.string().max(500),
    after: z.string().trim().min(3).max(125),
  }),
  z.object({
    kind: z.literal('text_replace'),
    pageUrl: z.string().url().max(500),
    before: z.string().min(1).max(500),
    after: z.string().max(500),
  }),
]);

/** GET /api/website/edits?status=open|done|dismissed (owner): prepared changes for one tab. */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const status = req.nextUrl.searchParams.get('status') ?? 'open';
  if (status !== 'open' && status !== 'done' && status !== 'dismissed') throw new AppError('VALIDATION', 'Choose open, done or dismissed.');
  return { edits: await listEdits(status) };
});

/** POST /api/website/edits (owner): a change written by the owner (image description or text correction). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, OwnerEditSchema);
  return NextResponse.json({ edit: await createOwnerEdit(user, body) }, { status: 201 });
});
