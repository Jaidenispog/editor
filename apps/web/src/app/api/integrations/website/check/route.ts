import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { checkWebsiteConnection } from '@/lib/website';

/** POST /api/integrations/website/check (owner): read-only WordPress check (nothing on the site changes). */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await checkWebsiteConnection('website'), {
    status: 202,
  });
});
