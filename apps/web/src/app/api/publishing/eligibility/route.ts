import { handleApi } from '@/lib/api';
import { getPublishingEligibility } from '@/lib/publishing';

/** GET /api/publishing/eligibility?versions=a,b (session): what the composer may offer for each chosen edit. */
export const GET = handleApi(async ({ req, user }) => {
  const ids = (req.nextUrl.searchParams.get('versions') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return getPublishingEligibility(ids, user);
});
