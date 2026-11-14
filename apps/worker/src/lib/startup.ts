import type { Logger } from 'pino';

/**
 * Start-up helpers: wait for a database that is not up yet (the owner started the app before the database), but fail
 * fast, with a plain message, on problems waiting cannot fix (a mistyped address, a wrong password, a missing
 * database). Nothing here ever logs the connection string itself, only its host and port.
 */

/** Exit status for a configuration problem (sysexits EX_CONFIG); scripts/dev.sh does not restart the worker for it. */
export const EXIT_CONFIG = 78;

/** First wait after a failed connection attempt; doubles each time up to START_RETRY_MAX_MS. */
export const START_RETRY_INITIAL_MS = 1_000;
export const START_RETRY_MAX_MS = 15_000;

/** A start-up problem that waiting will not fix. `message` is plain, safe to log and never contains a password. */
export class StartupConfigError extends Error {
  readonly exitCode = EXIT_CONFIG;
  constructor(message: string) {
    super(message);
    this.name = 'StartupConfigError';
  }
}

/** The worker was asked to stop (SIGINT/SIGTERM) while it was still waiting for the database. */
export class StartupAbortedError extends Error {
  constructor() {
    super('Stopped before the database was reachable');
    this.name = 'StartupAbortedError';
  }
}

/** Where the worker connects, without credentials. */
export interface DatabaseTarget {
  host: string;
  port: number;
  database: string;
  /** "host:port", for messages. */
  display: string;
  /** True for a database on this computer (the local-postgres.sh hint applies). */
  isLocal: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Parses DATABASE_URL into host and port, or throws StartupConfigError for an address that is not a postgres:// URL. */
export function databaseTarget(connectionString: string, name = 'DATABASE_URL'): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StartupConfigError(`${name} in .env is not a valid database address. It should look like postgres://postgres@127.0.0.1:5433/studio_assistant`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new StartupConfigError(`${name} in .env should start with postgres:// (it starts with ${url.protocol}//).`);
  }
  const host = url.hostname || 'localhost';
  const port = url.port ? Number(url.port) : 5432;
  return { host, port, database: decodeURIComponent(url.pathname.replace(/^\//, '')), display: `${host}:${port}`, isLocal: LOCAL_HOSTS.has(host) };
}

/** Network-level and "server not ready" codes: the database is not reachable yet, so waiting can help. */
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  // PostgreSQL SQLSTATEs: cannot_connect_now ("the database system is starting up"), admin/crash shutdown,
  // too many connections while other processes start.
  '57P03',
  '57P01',
  '57P02',
  '53300',
]);

/** Codes that mean the address or account is wrong; checked before the retryable ones. */
const FATAL_CODES = new Set(['28P01', '28000', '3D000', '42501', 'ERR_INVALID_URL', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

/** Messages pg and pg-boss use for connections that time out or drop while connecting (these have no code). */
const RETRYABLE_MESSAGES = [/timeout expired/i, /connection timeout/i, /Connection terminated unexpectedly/i, /timed out/i, /the database system is (starting up|shutting down|in recovery mode)/i];

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The error and everything it wraps (`cause`, AggregateError members), without looping on cycles. */
function errorChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length && out.length < 20) {
    const e = queue.shift();
    if (e === null || e === undefined || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (typeof e === 'object') {
      const { cause, errors } = e as { cause?: unknown; errors?: unknown };
      if (cause !== undefined) queue.push(cause);
      if (Array.isArray(errors)) queue.push(...errors);
    }
  }
  return out;
}

/**
 * Whether a failed first connection is worth retrying: "the database is not up (yet)" errors are, configuration
 * problems (bad address, refused password, missing database, a broken handler set-up) and anything unknown are not.
 */
export function classifyStartupError(err: unknown): 'retry' | 'fatal' {
  if (err instanceof StartupConfigError) return 'fatal';
  const chain = errorChain(err);
  // Any configuration-shaped error anywhere in the chain wins: retrying it would wait for ever.
  if (chain.some((e) => FATAL_CODES.has(codeOf(e) ?? ''))) return 'fatal';
  for (const e of chain) {
    const code = codeOf(e);
    if (code && RETRYABLE_CODES.has(code)) return 'retry';
    const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    if (RETRYABLE_MESSAGES.some((re) => re.test(message))) return 'retry';
  }
  return 'fatal';
}

/** Waits before the next attempt: 1 s, 2 s, 4 s, 8 s, then 15 s each time. `failures` counts from 1. */
export function backoffDelayMs(failures: number, initialMs = START_RETRY_INITIAL_MS, maxMs = START_RETRY_MAX_MS): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(maxMs, initialMs * 2 ** Math.min(n - 1, 30));
}

/** The one line the owner sees while the worker waits. */
export function waitingMessage(target: DatabaseTarget): string {
  return target.isLocal
    ? `Waiting for the database at ${target.display}. Start it with: bash scripts/local-postgres.sh start`
    : `Waiting for the database at ${target.display}. Check that the database server is running and reachable from this computer.`;
}

/** Removes every occurrence of the given secrets (passwords, whole connection strings) from a message. */
export function redact(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  // Any URL with credentials that slipped through: keep the user, hide the password.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi, '$1***@');
}

/** Secrets of a connection string that must never reach a log line: the whole string and its password. */
export function connectionSecrets(connectionString: string | undefined): string[] {
  if (!connectionString) return [];
  const out = [connectionString];
  try {
    const url = new URL(connectionString);
    if (url.password) {
      out.push(url.password);
      out.push(decodeURIComponent(url.password));
    }
  } catch {
    // Not a URL; the whole string is already listed.
  }
  return out;
}

/** Plain explanation of a start-up error that will not be retried (for the owner's terminal). */
export function describeFatalStartupError(err: unknown, target: DatabaseTarget | null): string {
  if (err instanceof StartupConfigError) return err.message;
  const where = target ? `the database at ${target.display}` : 'the database';
  const codes = errorChain(err).map(codeOf);
  if (codes.includes('28P01') || codes.includes('28000')) return `The worker could not sign in to ${where}: the user name or password in DATABASE_URL (.env) was refused.`;
  if (codes.includes('3D000')) {
    const name = target?.database ? `"${target.database}" ` : '';
    return `The database ${name}does not exist at ${target?.display ?? 'that address'}. ${target?.isLocal ? 'Run: bash scripts/local-postgres.sh start (it creates it), then bash scripts/dev.sh migrate.' : 'Create it, or fix the name in DATABASE_URL (.env).'}`;
  }
  if (codes.includes('42501')) return `The database user in DATABASE_URL (.env) is not allowed to set up ${where}.`;
  const message = err instanceof Error ? err.message : String(err);
  return `The worker could not start: ${message}`;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** setTimeout as a promise that resolves early when the signal aborts. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export interface WaitForDatabaseOptions {
  /** One connection attempt (probe the database, start the queue). Resolves when connected. */
  attempt: () => Promise<void>;
  target: DatabaseTarget;
  logger: Pick<Logger, 'warn' | 'info' | 'debug'>;
  /** Aborted by SIGINT/SIGTERM: stop waiting and throw StartupAbortedError. */
  signal: AbortSignal;
  sleep?: Sleep;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Runs `attempt` until it succeeds. A connection error logs ONE plain waiting line (the first time only) and is
 * retried with capped backoff; any other error is rethrown at once. Returns how many attempts failed first.
 */
export async function waitForDatabase(options: WaitForDatabaseOptions): Promise<number> {
  const sleep = options.sleep ?? realSleep;
  let failures = 0;
  for (;;) {
    if (options.signal.aborted) throw new StartupAbortedError();
    try {
      await options.attempt();
      if (failures > 0) options.logger.info({ database: options.target.display, failedAttempts: failures }, 'The database is reachable now; starting the worker.');
      return failures;
    } catch (err) {
      if (options.signal.aborted) throw new StartupAbortedError();
      if (classifyStartupError(err) === 'fatal') throw err;
      failures++;
      if (failures === 1) options.logger.warn({ database: options.target.display }, waitingMessage(options.target));
      else options.logger.debug({ database: options.target.display, failures, code: codeOf(err) }, 'database still not reachable');
      await sleep(backoffDelayMs(failures, options.initialDelayMs, options.maxDelayMs), options.signal);
    }
  }
}
