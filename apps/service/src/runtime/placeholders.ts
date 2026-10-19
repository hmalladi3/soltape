import type { PersistenceLifecycle, ServerLifecycle } from './runtime.js';

/** Persistence stand-in until Redis/Postgres are wired (wave 4). */
export const noPersistence: PersistenceLifecycle = {
  startBackground() {},
  restore: async () => {},
  flush: async () => ({ unflushed: 0 }),
  close: async () => {},
};

/** Server stand-in until the HTTP/WebSocket gateway is wired (wave 3). */
export const noServer: ServerLifecycle = {
  listen: async () => {},
  stopAccepting: async () => {},
  closeClients: async () => {},
};
