import { NextResponse } from 'next/server';
import { handleApi, requireOwner } from '@/lib/api';
import { listAudits, requestAudit } from '@/lib/website';

/** GET /api/website/audits?limit=20 (owner): earlier checks with their summaries. */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? '20');
  return { audits: await listAudits(Number.isFinite(limit) ? limit : 20) };
});

/** POST /api/website/audits (owner): starts a check (one at a time, 5-minute cool-down). 202 with the job. */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return NextResponse.json(await requestAudit(user), { status: 202 });
});
