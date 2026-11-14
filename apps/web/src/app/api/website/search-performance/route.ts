import { AppError } from '@studio/core';
import { handleApi, requireOwner } from '@/lib/api';
import { getSearchPerformance } from '@/lib/website';

/** GET /api/website/search-performance?range=28d|3m|16m (owner): grouped Search Console numbers, or the honest state. */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const range = req.nextUrl.searchParams.get('range') ?? '28d';
  if (range !== '28d' && range !== '3m' && range !== '16m') throw new AppError('VALIDATION', 'Choose 28d, 3m or 16m.');
  return getSearchPerformance(range, true);
});
