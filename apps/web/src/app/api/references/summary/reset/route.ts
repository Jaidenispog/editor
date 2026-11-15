import { handleApi, requireOwner } from '@/lib/api';
import { resetReferenceSummary } from '@/lib/references';

/**
 * POST /api/references/summary/reset — "Go back to each style's own": transitions, beat, reveal, zoom and music
 * matching return to the defaults; length, pace, colour and text stay as they are (owner only).
 */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return resetReferenceSummary(user);
});
