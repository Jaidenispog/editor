import { handleApi } from '@/lib/api';
import { publishBadgesFor } from '@/lib/publishing';

/** GET /api/publishing/badges?versions=a,b (session): per-platform badges for Studio and Library cards. */
export const GET = handleApi(async ({ req, user }) => {
  const ids = (req.nextUrl.searchParams.get('versions') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { badges: await publishBadgesFor(ids, user) };
});
