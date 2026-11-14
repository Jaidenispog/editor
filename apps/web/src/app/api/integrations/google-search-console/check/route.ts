import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { checkWebsiteConnection } from '@/lib/website';

/** POST /api/integrations/google-search-console/check (owner): read-only check of the Search Console connection. */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await checkWebsiteConnection('google_search_console'), { status: 202 });
});
