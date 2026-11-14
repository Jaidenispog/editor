import { isAppError, type AppErrorCode } from '@studio/core';
import { ZodError } from 'zod';

/** JSON error envelope returned by every API route. */
export interface ApiErrorBody {
  error: { code: AppErrorCode; message: string; details?: unknown; requestId?: string };
}

/** Result of mapping a thrown value to an HTTP response. `log` is true for unexpected (500-class) errors. */
export interface MappedError {
  status: number;
  body: ApiErrorBody;
  log: boolean;
}

interface ZodLikeIssue {
  path: PropertyKey[];
  message: string;
}

function isZodLike(err: unknown): err is { issues: ZodLikeIssue[] } {
  return (
    err instanceof ZodError ||
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ZodError' && Array.isArray((err as { issues?: unknown }).issues))
  );
}

/** Turns zod issues into `{ path: "brand.accentColour", message }` pairs the UI can show next to fields. */
export function zodIssuesToDetails(issues: ZodLikeIssue[]): Array<{ path: string; message: string }> {
  return issues.map((i) => ({ path: i.path.map((p) => String(p)).join('.'), message: i.message }));
}

/**
 * Maps anything thrown inside a route handler to a status and JSON body:
 * AppError → its own code/status; zod validation errors → 400 VALIDATION with per-field details;
 * everything else → 500 INTERNAL with a plain message (the real error is only logged on the server).
 */
export function mapErrorToResponse(err: unknown, requestId?: string): MappedError {
  const withId = requestId ? { requestId } : {};
  if (isAppError(err)) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, ...withId } };
    if (err.details !== undefined) body.error.details = err.details;
    return { status: err.status, body, log: err.status >= 500 };
  }
  if (isZodLike(err)) {
    const details = zodIssuesToDetails(err.issues);
    const first = details[0];
    const message = first ? `Please check ${first.path ? `"${first.path}"` : 'the form'}: ${first.message}` : 'Some details are not valid.';
    return { status: 400, body: { error: { code: 'VALIDATION', message, details, ...withId } }, log: false };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again in a moment.', ...withId } },
    log: true,
  };
}
