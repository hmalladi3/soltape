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

/**
 * Structured JSON logs to stdout via an asynchronous destination. Components log through
 * `child({ component })`, so every line carries `component`.
 * @spec OBS-LOG-001, OBS-LOG-004
 */
export function createLogger(level: string, destination: pino.DestinationStream = pino.destination({ sync: false })): Logger {
  return pino({ level, base: { service: 'soltape' } }, destination);
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
