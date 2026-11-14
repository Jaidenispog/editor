/** Methods that never change state and therefore skip the same-origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Inputs for the CSRF decision, kept separate from Request so the rule can be unit tested. */
export interface OriginCheckInput {
  method: string;
  /** Value of the Origin header, if sent. */
  origin: string | null;
  /** Value of the Sec-Fetch-Site header, if sent. */
  secFetchSite: string | null;
  /** Origins considered "ours": APP_URL plus the origin the request actually arrived on. */
  allowedOrigins: string[];
}

function normaliseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for state-changing requests. Accepts the request when the browser says it is same-origin
 * (Sec-Fetch-Site) or when the Origin header matches one of our origins. Requests carrying neither header
 * are refused, so a script on another site can never trigger changes with the owner's cookie.
 */
export function isSameOriginRequest(input: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;
  const allowed = new Set(input.allowedOrigins.map(normaliseOrigin).filter((o): o is string => o !== null));
  if (input.origin && input.origin !== 'null') {
    const o = normaliseOrigin(input.origin);
    return o !== null && allowed.has(o);
  }
  if (input.secFetchSite) return input.secFetchSite === 'same-origin';
  return false;
}
