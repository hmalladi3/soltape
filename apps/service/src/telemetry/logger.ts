import { pino } from 'pino';

/** The logging surface components depend on (pino-compatible). */
export interface Logger {
  fatal(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Structured JSON logs to stdout via an asynchronous destination (OBS-LOG-001). */
export function createLogger(level: string): Logger {
  return pino({ level, base: { service: 'soltape' } }, pino.destination({ sync: false }));
}

/** Discards everything; for tests and tools. */
export const silentLogger: Logger = {
  fatal() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silentLogger,
};
