import type { Logger } from '../telemetry/logger.js';
import { PoolValidationError } from '../ingest/rpc-adapter.js';

export type Phase = 'starting' | 'running' | 'stopping';

/** Lifecycle phase, read by /health. */
export class PhaseHolder {
  phase: Phase = 'starting';
}

export interface Startable {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** History and latest-value persistence (wave 4); runs in the background. */
export interface PersistenceLifecycle {
  /** Connects in the background; must not be awaited by startup. */
  startBackground(): void;
  /** Warm restore from Redis; the runtime enforces the deadline. */
  restore(): Promise<void>;
  flush(deadlineMs: number): Promise<{ unflushed: number }>;
  close(): Promise<void>;
}

export interface ServerLifecycle {
  listen(): Promise<void>;
  stopAccepting(): Promise<void>;
  closeClients(code: number): Promise<void>;
}

export interface ReconcilerLifecycle {
  start(): void;
  freeze(): void;
  available(market: number): boolean;
}

export interface RuntimeOptions {
  restoreDeadlineMs: number;
  startupGraceMs: number;
  flushDeadlineMs: number;
  fatalShutdownCapMs: number;
  readyPollMs: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  restoreDeadlineMs: 500,
  startupGraceMs: 15_000,
  flushDeadlineMs: 5_000,
  fatalShutdownCapMs: 1_000,
  readyPollMs: 250,
};

export interface RuntimeDeps {
  logger: Logger;
  phase: PhaseHolder;
  persistence: PersistenceLifecycle;
  reconciler: ReconcilerLifecycle;
  marketCount: number;
  server: ServerLifecycle;
  adapters: Startable[];
  /** Shared clients closed last (e.g. the RPC HTTP pool). */
  closeables?: { close(): Promise<void> }[];
  exit: (code: number) => void;
  options?: Partial<RuntimeOptions>;
}

/**
 * Owns startup order, the startup grace period, shutdown order and the process-level failure
 * policy. See docs/llds/service-runtime.md § Lifecycle.
 */
export class ServiceRuntime {
  private readonly d: RuntimeDeps;
  private readonly o: RuntimeOptions;
  private readonly log: Logger;
  private shuttingDown: Promise<void> | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private exited = false;

  constructor(deps: RuntimeDeps) {
    this.d = deps;
    this.o = { ...DEFAULT_RUNTIME_OPTIONS, ...deps.options };
    this.log = deps.logger.child({ component: 'runtime' });
  }

  /**
   * Startup after config, logger and decoder selection (done by the composition root).
   * @spec RUN-LIFE-001, RUN-LIFE-002, RUN-LIFE-003, RUN-LIFE-004, RUN-LIFE-005, RUN-LIFE-006
   */
  async start(): Promise<void> {
    this.d.phase.phase = 'starting';
    this.d.persistence.startBackground();
    this.log.info({}, 'persistence connecting in background');

    let restoreTimer: NodeJS.Timeout | undefined;
    const restored = await Promise.race([
      this.d.persistence.restore().then(
        () => 'restored' as const,
        (err: unknown) => (this.log.warn({ err }, 'warm restore failed'), 'failed' as const),
      ),
      new Promise<'timeout'>((r) => (restoreTimer = setTimeout(() => r('timeout'), this.o.restoreDeadlineMs))),
    ]);
    clearTimeout(restoreTimer);
    this.log.info({ restored }, 'warm restore');

    this.d.reconciler.start();
    await this.d.server.listen();
    this.log.info({}, 'listening');

    const results = await Promise.allSettled(this.d.adapters.map((a) => a.start()));
    const invalid = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    if (invalid.length) {
      for (const err of invalid) {
        if (err instanceof PoolValidationError) this.log.fatal({ venue: err.venue, problems: err.problems }, err.message);
        else this.log.fatal({ err }, 'source adapter failed to start');
      }
      await this.stopEverything();
      this.exit(2);
      return;
    }
    this.log.info({ adapters: this.d.adapters.map((a) => a.id) }, 'source adapters started');
    this.awaitReady();
  }

  /** Leaves `starting` once every market has a price, or after the grace period. */
  private awaitReady(): void {
    const ready = (reason: 'all markets priced' | 'startup grace elapsed') => {
      if (this.d.phase.phase !== 'starting') return;
      this.d.phase.phase = 'running';
      clearInterval(this.readyTimer);
      clearTimeout(this.graceTimer);
      this.log.info({ reason }, 'running');
    };
    const allAvailable = () => Array.from({ length: this.d.marketCount }, (_, m) => m).every((m) => this.d.reconciler.available(m));
    this.readyTimer = setInterval(() => allAvailable() && ready('all markets priced'), this.o.readyPollMs);
    this.readyTimer.unref();
    this.graceTimer = setTimeout(() => ready('startup grace elapsed'), this.o.startupGraceMs);
    this.graceTimer.unref();
  }

  /**
   * Graceful shutdown. A second call while shutting down exits immediately with code 1.
   * @spec RUN-LIFE-010, RUN-LIFE-011, RUN-LIFE-012
   */
  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) {
      this.log.warn({ signal }, 'second signal during shutdown; exiting now');
      this.exit(1);
      return;
    }
    this.log.info({ signal }, 'shutting down');
    this.shuttingDown = this.stopEverything().then(() => this.exit(0));
    return this.shuttingDown;
  }

  private async stopEverything(): Promise<void> {
    clearInterval(this.readyTimer);
    clearTimeout(this.graceTimer);
    this.d.phase.phase = 'stopping';
    await this.d.server.stopAccepting();
    this.d.reconciler.freeze();
    await Promise.allSettled(this.d.adapters.map((a) => a.stop()));
    await this.d.server.closeClients(1001);
    const { unflushed } = await this.d.persistence.flush(this.o.flushDeadlineMs);
    if (unflushed > 0) this.log.warn({ unflushed }, 'rows left unflushed at shutdown');
    await this.d.persistence.close();
    await Promise.allSettled((this.d.closeables ?? []).map((c) => c.close()));
    this.log.info({}, 'stopped');
  }

  /**
   * Last-resort handler for uncaught exceptions and unhandled rejections: log fatal, attempt
   * shutdown for at most 1 s, exit 1. The container restart policy brings the service back.
   * @spec RUN-ERR-001
   */
  async fatal(err: unknown): Promise<void> {
    this.log.fatal({ err }, 'uncaught error; exiting');
    let cap: NodeJS.Timeout | undefined;
    await Promise.race([
      (this.shuttingDown ??= this.stopEverything()).catch(() => undefined),
      new Promise<void>((r) => (cap = setTimeout(r, this.o.fatalShutdownCapMs))),
    ]);
    clearTimeout(cap);
    this.exit(1);
  }

  /** Wires SIGTERM/SIGINT and the fatal handlers into a process. */
  install(proc: NodeJS.Process): void {
    proc.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    proc.on('SIGINT', () => void this.shutdown('SIGINT'));
    proc.on('uncaughtException', (err) => void this.fatal(err));
    proc.on('unhandledRejection', (err) => void this.fatal(err));
  }

  private exit(code: number): void {
    if (this.exited && code === 0) return;
    this.exited = true;
    this.d.exit(code);
  }
}
