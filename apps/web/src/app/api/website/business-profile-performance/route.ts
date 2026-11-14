import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleApi, requireOwner } from '@/lib/api';
import { getProfilePerformance, refreshProfilePerformance } from '@/lib/business-profile';

const RangeSchema = z.enum(['28d', '3m', '12m']).catch('28d');

/**
 * GET /api/website/business-profile-performance?range=28d|3m|12m (owner): calls, direction requests, website clicks,
 * bookings, message clicks and views, only as Google returned them (website design §4.6, §9.2).
 */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return getProfilePerformance(RangeSchema.parse(req.nextUrl.searchParams.get('range') ?? '28d'));
});

/** POST /api/website/business-profile-performance (owner): refresh the numbers (at most every 15 minutes). */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await refreshProfilePerformance(user), { status: 202 });
});
