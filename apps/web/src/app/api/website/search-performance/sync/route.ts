import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { requestSearchSync } from '@/lib/website';

/** POST /api/website/search-performance/sync (owner) `{ source }`: refreshes Search Console (at most every 15 minutes). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ source: z.enum(['search_console', 'business_profile']) }));
  if (body.source !== 'search_console') throw new AppError('UNSUPPORTED', 'Business Profile numbers are not available yet.');
  return NextResponse.json(await requestSearchSync(user), { status: 202 });
});
