import { RecordConsentSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { consentDetail, recordConsent } from '@/lib/email';

/** GET /api/customers/[id]/consent (staff and owner): state, ledger, suppressions and the current wording. */
export const GET = handleApi<{ id: string }>(async ({ params }) => consentDetail(params.id));

/** POST /api/customers/[id]/consent (staff and owner): records express permission (the wording hash must match). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => recordConsent(user, params.id, await parseJson(req, RecordConsentSchema), req.headers.get('user-agent')));
