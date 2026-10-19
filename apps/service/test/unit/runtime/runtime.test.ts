import { describe, expect, it } from 'vitest';
import { PoolValidationError } from '../../../src/ingest/rpc-adapter.js';
import { PhaseHolder, ServiceRuntime, type PersistenceLifecycle, type ServerLifecycle, type Startable } from '../../../src/runtime/runtime.js';
import { sleep, waitFor } from '../../support/fake-rpc.js';
import { recordingLogger } from '../../support/ingest.js';

function setup(over: { restore?: () => Promise<void>; adapterStart?: (id: string) => Promise<void>; adapterStop?: () => Promise<void>; available?: () => boolean; graceMs?: number } = {}) {
  const log: string[] = [];
  const logs: { level: string; obj: object; msg?: string }[] = [];
  const exits: number[] = [];
  const phase = new PhaseHolder();
  const persistence: PersistenceLifecycle = {
    startBackground: () => void log.push('persistence.startBackground'),
    restore: async () => {
      log.push('persistence.restore');
      await (over.restore?.() ?? Promise.resolve());
    },
    flush: async (deadline) => (log.push(`persistence.flush:${deadline}`), { unflushed: 0 }),
    close: async () => void log.push('persistence.close'),
  };
  const server: ServerLifecycle = {
    listen: async () => void log.push(`server.listen:${phase.phase}`),
    stopAccepting: async () => void log.push(`server.stopAccepting:${phase.phase}`),
    closeClients: async (code) => void log.push(`server.closeClients:${code}`),
  };
  const adapter = (id: string): Startable => ({
    id,
    start: async () => {
      log.push(`${id}.start`);
      await (over.adapterStart?.(id) ?? Promise.resolve());
    },
    stop: async () => {
      log.push(`${id}.stop`);
      await (over.adapterStop?.() ?? Promise.resolve());
    },
  });
  const reconciler = {
    start: () => void log.push('reconciler.start'),
    freeze: () => void log.push('reconciler.freeze'),
    available: over.available ?? (() => false),
  };
  const rt = new ServiceRuntime({
    logger: recordingLogger(logs),
    phase,
    persistence,
    reconciler,
    marketCount: 2,
    server,
    adapters: [adapter('orca'), adapter('jupiter')],
    exit: (c) => void exits.push(c),
    options: { restoreDeadlineMs: 50, startupGraceMs: over.graceMs ?? 10_000, readyPollMs: 5, fatalShutdownCapMs: 100 },
  });
  return { rt, log, logs, exits, phase };
}

describe('startup', () => {
  // @spec RUN-LIFE-001, RUN-LIFE-002, RUN-LIFE-003
  it('starts persistence in the background, restores, listens while starting, then starts adapters', async () => {
    const { rt, log, phase } = setup();
    await rt.start();
    expect(log).toEqual(['persistence.startBackground', 'persistence.restore', 'reconciler.start', 'server.listen:starting', 'orca.start', 'jupiter.start']);
    expect(phase.phase).toBe('starting');
  });

  // @spec RUN-LIFE-002
  it('caps the warm restore at its deadline', async () => {
    const { rt, log } = setup({ restore: () => new Promise(() => {}) });
    const t0 = performance.now();
    await rt.start();
    expect(performance.now() - t0).toBeLessThan(200);
    expect(log).toContain('orca.start');
  });

  // @spec RUN-LIFE-004
  it('exits 2 when an adapter reports pool validation errors at boot', async () => {
    const { rt, exits, logs } = setup({
      adapterStart: async (id) => {
        if (id === 'orca') throw new PoolValidationError('orca', [{ address: 'HJPj', message: 'pool HJPj is owned by X' }]);
      },
    });
    await rt.start();
    expect(exits).toEqual([2]);
    expect(logs.some((l) => l.level === 'fatal' && /HJPj/.test(l.msg ?? ''))).toBe(true);
  });

  // @spec RUN-LIFE-005
  it('starts adapters concurrently so one slow source does not hold up the others', async () => {
    let release!: () => void;
    const { rt, log } = setup({ adapterStart: (id) => (id === 'orca' ? new Promise<void>((r) => (release = r)) : Promise.resolve()) });
    const started = rt.start();
    await waitFor(() => log.includes('jupiter.start'));
    release();
    await started;
  });

  // @spec RUN-LIFE-006
  it('leaves starting once every market is available', async () => {
    let ok = false;
    const { rt, phase } = setup({ available: () => ok });
    await rt.start();
    await sleep(20);
    expect(phase.phase).toBe('starting');
    ok = true;
    await waitFor(() => phase.phase === 'running');
  });

  // @spec RUN-LIFE-006
  it('leaves starting after the grace period even if a market never becomes available', async () => {
    const { rt, phase } = setup({ graceMs: 40 });
    await rt.start();
    await waitFor(() => phase.phase === 'running', 500);
  });
});

describe('shutdown', () => {
  // @spec RUN-LIFE-010
  it('stops in order and exits 0', async () => {
    const { rt, log, exits, phase } = setup();
    await rt.start();
    log.length = 0;
    await rt.shutdown('SIGTERM');
    expect(log).toEqual(['server.stopAccepting:stopping', 'reconciler.freeze', 'orca.stop', 'jupiter.stop', 'server.closeClients:1001', 'persistence.flush:5000', 'persistence.close']);
    expect(phase.phase).toBe('stopping');
    expect(exits).toEqual([0]);
  });

  // @spec RUN-LIFE-011
  it('exits 1 immediately on a second signal during shutdown', async () => {
    const releases: (() => void)[] = [];
    const { rt, exits } = setup({ adapterStop: () => new Promise<void>((r) => releases.push(r)) });
    await rt.start();
    const first = rt.shutdown('SIGTERM');
    await sleep(5);
    await rt.shutdown('SIGINT');
    expect(exits).toEqual([1]);
    for (const r of releases) r();
    await first;
    expect(exits).toEqual([1]);
  });
});

describe('fatal errors', () => {
  // @spec RUN-ERR-001
  it('logs fatal, attempts shutdown for at most the cap, and exits 1', async () => {
    const { rt, exits, logs } = setup({ adapterStop: () => new Promise(() => {}) });
    await rt.start();
    const t0 = performance.now();
    await rt.fatal(new Error('boom'));
    expect(performance.now() - t0).toBeLessThan(400);
    expect(exits).toEqual([1]);
    expect(logs.some((l) => l.level === 'fatal')).toBe(true);
  });
});
