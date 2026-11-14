import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { answerSelfTestNotification } from '@/lib/square/changes';
import { getSquareStatus } from '@/lib/square/status';

const BodySchema = z.object({ answer: z.enum(['yes', 'no', 'unknown']) }).strict();

/**
 * POST /api/integrations/square/self-test/notification (owner) `{ answer }`: whether the client received a
 * confirmation from Square for the test booking. Square does not document whether it notifies clients about changes
 * an app makes, so the change dialog's notification sentence comes from this answer. Returns the Square card state.
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, BodySchema);
  await answerSelfTestNotification(body.answer);
  return getSquareStatus(user);
});
