import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { checkBusinessProfile } from '@/lib/business-profile';

/**
 * POST /api/integrations/google-business-profile/check (owner): "Check again". Re-reads locations and reviews and
 * re-probes Performance access, all read-only. It is also how the owner asks whether Google has approved access yet.
 */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await checkBusinessProfile(user), { status: 202 });
});
