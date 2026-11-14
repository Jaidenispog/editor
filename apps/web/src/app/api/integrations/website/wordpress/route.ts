import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { saveWordPress } from '@/lib/website';

const WordPressSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .url()
    .max(300)
    .refine((u) => u.startsWith('https://'), 'Use your site’s https:// address'),
  username: z.string().trim().min(1).max(120),
  applicationPassword: z.string().trim().min(16).max(200),
});

/** POST /api/integrations/website/wordpress (owner): saves the Application Password (encrypted, never echoed) and checks it read-only. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, WordPressSchema);
  return NextResponse.json(await saveWordPress(user, body), { status: 202 });
});
