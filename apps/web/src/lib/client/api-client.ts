'use client';

/** Error thrown by apiRequest with the server's plain-language message and code. */
export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(message: string, code: string, status: number, details: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Calls one of the app's JSON API routes from a client component. Sends cookies (same origin), encodes the
 * body as JSON (or passes FormData through), and throws ApiClientError with the server's message on failure.
 * A 401 sends the browser to the sign-in page.
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: isForm || options.body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: isForm ? (options.body as FormData) : JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiClientError('We could not reach the server. Check your connection and try again.', 'NETWORK', 0, null);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    throw new ApiClientError(err?.message ?? 'Something went wrong. Please try again.', err?.code ?? 'INTERNAL', res.status, err?.details ?? null);
  }
  return data as T;
}

/** Field-level messages from a VALIDATION error, keyed by dotted path. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiClientError) || !Array.isArray(err.details)) return {};
  const out: Record<string, string> = {};
  for (const d of err.details as Array<{ path?: string; message?: string }>) {
    if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
  }
  return out;
}
