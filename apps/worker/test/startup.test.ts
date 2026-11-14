import { describe, expect, it } from 'vitest';
import {
  EXIT_CONFIG,
  StartupAbortedError,
  StartupConfigError,
  backoffDelayMs,
  classifyStartupError,
  connectionSecrets,
  databaseTarget,
  describeFatalStartupError,
  redact,
  waitForDatabase,
  waitingMessage,
  type Sleep,
} from '../src/lib/startup.js';
import { reportStartupFailure } from '../src/main.js';

/** An error shaped like the ones pg / Node sockets / pg-boss throw. */
function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** Records log calls instead of printing them. */
function fakeLogger() {
  const lines: Array<{ level: string; msg: string; data: unknown }> = [];
  const at = (level: string) => (data: unknown, msg?: string) => {
    lines.push({ level, msg: msg ?? String(data), data });
  };
  return { lines, logger: { warn: at('warn'), info: at('info'), debug: at('debug') } as never };
}

/** A sleep that never waits: it records the requested delays (and can abort after N of them). */
function fakeSleep(abortAfter?: { count: number; controller: AbortController }): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
      if (abortAfter && delays.length >= abortAfter.count) abortAfter.controller.abort();
    },
  };
}

const LOCAL = databaseTarget('postgres://postgres:s3cret-pass@127.0.0.1:5433/studio_assistant');

describe('classifyStartupError', () => {
  it('retries a database that is not reachable yet', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', '57P03', '53300']) {
      expect(classifyStartupError(coded(code)), code).toBe('retry');
    }
    expect(classifyStartupError(new Error('the database system is starting up'))).toBe('retry');
    expect(classifyStartupError(new Error('timeout expired'))).toBe('retry');
    expect(classifyStartupError(new Error('Connection terminated due to connection timeout'))).toBe('retry');
    expect(classifyStartupError(new Error('Connection terminated unexpectedly'))).toBe('retry');
  });

  it('looks inside AggregateError (localhost resolves to ::1 and 127.0.0.1) and error causes', () => {
    expect(classifyStartupError(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')], 'connect failed'))).toBe('retry');
    expect(classifyStartupError(new Error('pg-boss start failed', { cause: coded('ECONNREFUSED') }))).toBe('retry');
  });

  it('fails fast on configuration problems and unknown errors', () => {
    expect(classifyStartupError(coded('28P01', 'password authentication failed for user "postgres"'))).toBe('fatal');
    expect(classifyStartupError(coded('28000'))).toBe('fatal');
    expect(classifyStartupError(coded('3D000', 'database "nope" does not exist'))).toBe('fatal');
    expect(classifyStartupError(coded('ERR_INVALID_URL', 'Invalid URL'))).toBe('fatal');
    expect(classifyStartupError(new StartupConfigError('No handler registered for: x'))).toBe('fatal');
    expect(classifyStartupError(new Error('No handler registered for: maintenance.cleanup'))).toBe('fatal');
    expect(classifyStartupError(new TypeError('cannot read properties of undefined'))).toBe('fatal');
    // A wrong password stays fatal even when wrapped together with a retryable error.
    expect(classifyStartupError(new AggregateError([coded('ECONNREFUSED'), coded('28P01')]))).toBe('fatal');
  });
});

describe('backoffDelayMs', () => {
  it('starts at 1 s, doubles and is capped at 15 s', () => {
    expect([1, 2, 3, 4, 5, 6, 50, 10_000].map((n) => backoffDelayMs(n))).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(3, 100, 250)).toBe(250);
  });
});

describe('databaseTarget', () => {
  it('reads host and port without the password', () => {
    expect(LOCAL).toMatchObject({ host: '127.0.0.1', port: 5433, database: 'studio_assistant', display: '127.0.0.1:5433', isLocal: true });
    expect(JSON.stringify(LOCAL)).not.toContain('s3cret');
    expect(databaseTarget('postgresql://u@db.example.com/x')).toMatchObject({ port: 5432, isLocal: false, display: 'db.example.com:5432' });
  });

  it('rejects an address that is not a postgres:// URL as a configuration problem', () => {
    expect(() => databaseTarget('not a url')).toThrow(StartupConfigError);
    expect(() => databaseTarget('mysql://u:p@h/db')).toThrow(/should start with postgres:\/\//);
    try {
      databaseTarget('nonsense:secretpw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secretpw');
    }
  });

  it('gives the local database hint only for a database on this computer', () => {
    expect(waitingMessage(LOCAL)).toBe('Waiting for the database at 127.0.0.1:5433. Start it with: bash scripts/local-postgres.sh start');
    expect(waitingMessage(databaseTarget('postgres://u@db.example.com:6543/x'))).not.toContain('local-postgres');
  });
});

describe('waitForDatabase', () => {
  it('logs one plain waiting line, backs off 1-2-4-8-15-15 s and returns once connected', async () => {
    const { lines, logger } = fakeLogger();
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const failures = await waitForDatabase({
      target: LOCAL,
      logger,
      signal: new AbortController().signal,
      sleep,
      attempt: async () => {
        calls++;
        if (calls <= 6) throw coded(calls === 3 ? '57P03' : 'ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5433');
      },
    });
    expect(failures).toBe(6);
    expect(calls).toBe(7);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    const warnings = lines.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe('Waiting for the database at 127.0.0.1:5433. Start it with: bash scripts/local-postgres.sh start');
    expect(lines.some((l) => l.level === 'info' && /reachable now/.test(l.msg))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('s3cret');
  });

  it('does not log or wait when the first attempt connects', async () => {
    const { lines, logger } = fakeLogger();
    const { sleep, delays } = fakeSleep();
    expect(await waitForDatabase({ target: LOCAL, logger, signal: new AbortController().signal, sleep, attempt: async () => {} })).toBe(0);
    expect(delays).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('rethrows a configuration error at once, without retrying', async () => {
    const { logger } = fakeLogger();
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const auth = coded('28P01', 'password authentication failed for user "postgres"');
    await expect(
      waitForDatabase({
        target: LOCAL,
        logger,
        signal: new AbortController().signal,
        sleep,
        attempt: async () => {
          calls++;
          throw auth;
        },
      }),
    ).rejects.toBe(auth);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('stops waiting when SIGINT/SIGTERM aborts the signal', async () => {
    const { logger } = fakeLogger();
    const controller = new AbortController();
    const { sleep, delays } = fakeSleep({ count: 3, controller });
    await expect(
      waitForDatabase({
        target: LOCAL,
        logger,
        signal: controller.signal,
        sleep,
        attempt: async () => {
          throw coded('ECONNREFUSED');
        },
      }),
    ).rejects.toBeInstanceOf(StartupAbortedError);
    expect(delays).toHaveLength(3);
  });
});

describe('start-up failure messages', () => {
  it('explains configuration problems in plain words', () => {
    expect(describeFatalStartupError(coded('28P01'), LOCAL)).toMatch(/user name or password in DATABASE_URL \(\.env\) was refused/);
    expect(describeFatalStartupError(coded('3D000'), LOCAL)).toMatch(/"studio_assistant" does not exist .*scripts\/local-postgres\.sh start/);
  });

  it('never prints the connection password, and exits 78 for configuration problems', () => {
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://postgres:s3cret-pass@127.0.0.1:5433/studio_assistant';
    try {
      const out: string[] = [];
      const code = reportStartupFailure(new StartupConfigError('bad thing with postgres://postgres:s3cret-pass@127.0.0.1:5433/studio_assistant'), (l) => out.push(l));
      expect(code).toBe(EXIT_CONFIG);
      expect(out.join('\n')).not.toContain('s3cret-pass');
      const other: string[] = [];
      expect(reportStartupFailure(new Error('boom s3cret-pass'), (l) => other.push(l))).toBe(1);
      expect(other.join('\n')).not.toContain('s3cret-pass');
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });

  it('redacts passwords in any URL', () => {
    expect(redact('at postgres://me:hunter2@db:5432/x', [])).toBe('at postgres://me:***@db:5432/x');
    expect(redact('pw is p%40ss', connectionSecrets('postgres://u:p%40ss@h/db'))).not.toContain('p%40ss');
  });
});
