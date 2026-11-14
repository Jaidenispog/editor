import { AppError } from '@studio/core';
import { handleApi } from '@/lib/api';
import { UPLOAD_PART_SIZE } from '@/lib/shared/upload-math';
import { putUploadPart } from '@/lib/uploads';

/** PUT /api/uploads/[id]/parts/[n] — raw bytes of part n (1-based). Sending a part again replaces it. */
export const PUT = handleApi<{ id: string; n: string }>(async ({ req, params, user }) => {
  const n = Number(params.n);
  if (!/^\d{1,5}$/.test(params.n) || !Number.isInteger(n) || n < 1) throw new AppError('VALIDATION', 'The part number is not valid.');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > UPLOAD_PART_SIZE) throw new AppError('VALIDATION', 'This part is larger than expected. Please refresh the page and try again.');
  const body = Buffer.from(await req.arrayBuffer());
  return putUploadPart(params.id, user, n, body);
});
