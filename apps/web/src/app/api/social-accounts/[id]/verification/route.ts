import { z } from 'zod';
import { handleApi, parseJson } from '@/lib/api';
import { recordVerification } from '@/lib/publishing';

const Body = z.object({ result: z.enum(['seen', 'not_seen']), targetId: z.string().min(1).max(64) });

/** POST /api/social-accounts/[id]/verification (owner): "Can you see the reel?" after the first verification post. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => recordVerification(params.id, await parseJson(req, Body), user));
