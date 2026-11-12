export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAUTHORISED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'PROCESSING_FAILED'
  | 'CANCELLED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: AppErrorCode, message: string, options: { status?: number; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
  }
}

function defaultStatus(code: AppErrorCode): number {
  switch (code) {
    case 'VALIDATION':
      return 400;
    case 'UNAUTHORISED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'UNSUPPORTED':
    case 'INTEGRATION_NOT_CONFIGURED':
      return 422;
    case 'CANCELLED':
      return 409;
    default:
      return 500;
  }
}

export class CancelledError extends AppError {
  constructor(message = 'Job cancelled') {
    super('CANCELLED', message);
    this.name = 'CancelledError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
