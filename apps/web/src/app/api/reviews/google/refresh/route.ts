import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { refreshGoogleReviews } from '@/lib/business-profile';

/** POST /api/reviews/google/refresh (owner): re-reads Google reviews (read-only); 429 within 10 minutes of the last read. */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await refreshGoogleReviews(user), { status: 202 });
});
