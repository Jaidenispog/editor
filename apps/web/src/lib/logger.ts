import 'server-only';
import pino, { type Logger } from 'pino';

const globalForLogger = globalThis as unknown as { __studioWebLogger?: Logger };

/** Process-wide structured logger (JSON lines). The level comes from LOG_LEVEL, read lazily. */
export function getLogger(): Logger {
  if (!globalForLogger.__studioWebLogger) {
    const level = process.env.LOG_LEVEL ?? 'info';
    globalForLogger.__studioWebLogger = pino({
      level: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(level) ? level : 'info',
      base: { service: 'studio-web' },
      redact: { paths: ['password', '*.password', 'newPassword', 'currentPassword', 'token', 'cookie', '*.cookie'], remove: true },
    });
  }
  return globalForLogger.__studioWebLogger;
}
