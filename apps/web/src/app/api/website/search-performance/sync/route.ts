import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { refreshProfilePerformance } from '@/lib/business-profile';
import { requestSearchSync } from '@/lib/website';

/**
 * POST /api/website/search-performance/sync (owner) `{ source }`: refreshes Search Console, or the Business Profile
 * Performance numbers (the same as POST /api/website/business-profile-performance), each at most every 15 minutes.
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ source: z.enum(['search_console', 'business_profile']) }));
  if (body.source === 'business_profile') return NextResponse.json(await refreshProfilePerformance(user), { status: 202 });
  return NextResponse.json(await requestSearchSync(user), { status: 202 });
});
