import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { saveWordPress } from '@/lib/website';

const WordPressSchema = z.object({
  // https only: `saveWordPress` refuses anything else (the one exception is the browser test's local fixture host,
  // and only under NODE_ENV=test with WEBSITE_FIXTURE_BASE_URL naming it).
  baseUrl: z.string().trim().url().max(300),
  username: z.string().trim().min(1).max(120),
  applicationPassword: z.string().trim().min(16).max(200),
});

/** POST /api/integrations/website/wordpress (owner): saves the Application Password (encrypted, never echoed) and checks it read-only. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, WordPressSchema);
  return NextResponse.json(await saveWordPress(user, body), { status: 202 });
});
