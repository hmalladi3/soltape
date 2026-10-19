import type { PersistenceLifecycle, ServerLifecycle } from './runtime.js';

/** Persistence stand-in until Redis/Postgres are wired (wave 4). */
export const noPersistence: PersistenceLifecycle = {
  startBackground() {},
  restore: () => Promise.resolve(),
  flush: () => Promise.resolve({ unflushed: 0 }),
  close: () => Promise.resolve(),
};

/** Server stand-in until the HTTP/WebSocket gateway is wired (wave 3). */
export const noServer: ServerLifecycle = {
  listen: () => Promise.resolve(),
  stopAccepting: () => Promise.resolve(),
  closeClients: () => Promise.resolve(),
};
