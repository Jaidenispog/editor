import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateQueryGroups } from '@/lib/website';

const terms = (min: number, max: number, count: number) => z.array(z.string().trim().min(min).max(max)).max(count).optional();

/** PUT /api/website/query-groups (owner): the word lists used to group searches (applied when reading). */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(
    req,
    z
      .object({
        brandTerms: terms(2, 60, 10),
        placeTerms: terms(2, 60, 20),
        serviceTerms: terms(2, 40, 40),
      })
      .strict(),
  );
  return { website: await updateQueryGroups(body) };
});
