import { OUT_LEN, Out, Status, type FrameDecoder } from '@soltape/decoder';
import type { Clock, MarketsFile, PoolVenue } from '@soltape/shared';
import WebSocket from 'ws';
import { poolAddresses, resolveVenue, type MarketModel } from '../markets/model.js';
import type { SourceSink, SourceStatus } from '../reconcile/types.js';
import { noTelemetry, type TelemetryHooks } from '../telemetry/hooks.js';
import type { Logger } from '../telemetry/logger.js';
import { RateLimitedLog } from '../telemetry/rate-limit.js';
import { fullJitter } from './backoff.js';
import type { RpcFailure, RpcHttp } from './rpc-http.js';
import { validateVenuePools, type PoolProblem } from './validate.js';

export interface RpcAdapterOptions {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  subscribeTimeoutMs: number;
  subscribeRetries: number;
  backgroundResubscribeMs: number;
  revalidateAfterMs: number;
  checkIntervalMs: number;
  staleReconnectMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  backoffResetMs: number;
  maxPayload: number;
}

export const DEFAULT_RPC_OPTIONS: RpcAdapterOptions = {
  pingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  subscribeTimeoutMs: 5_000,
  subscribeRetries: 3,
  backgroundResubscribeMs: 60_000,
  revalidateAfterMs: 20_000,
  checkIntervalMs: 1_000,
  staleReconnectMs: 10_000,
  backoffBaseMs: 250,
  backoffCapMs: 30_000,
  backoffResetMs: 60_000,
  maxPayload: 64 * 1024,
};

/** Liveness judged by the reconciler (the adapter asks; it never judges). */
export interface SourceRegistry {
  sourceStatus(source: PoolVenue): SourceStatus;
}

export class PoolValidationError extends Error {
  constructor(
    readonly venue: PoolVenue,
    readonly problems: PoolProblem[],
  ) {
    super(`${venue}: ${problems.length} pool validation error(s):\n  ${problems.map((p) => p.message).join('\n  ')}`);
  }
}

export interface RpcAdapterDeps {
  venue: PoolVenue;
  model: MarketModel;
  markets: MarketsFile;
  sink: SourceSink;
  registry: SourceRegistry;
  decoder: FrameDecoder;
  rpcHttp: RpcHttp;
  wsUrl: string;
  commitment: string;
  clock: Clock;
  logger: Logger;
  options?: Partial<RpcAdapterOptions>;
  random?: () => number;
  telemetry?: TelemetryHooks;
}

export type ReconnectCause = 'close' | 'ping_timeout' | 'stale' | 'snapshot';

interface Pending {
  kind: 'slot' | 'pool';
  pool: number;
  attempt: number;
  timer: NodeJS.Timeout;
}

/** Counters exported as metrics (telemetry.md). */
export interface RpcAdapterStats {
  /** Account notifications delivered to the reconciler. */
  updates: number;
  decodeErrors: Map<number, number>;
  unknownSubscription: number;
  subscribeFailures: Map<string, number>;
  reconnects: Map<ReconnectCause, number>;
}

/**
 * Source adapter for one on-chain venue (Orca or Raydium). Owns its WebSocket connection:
 * boot validation, subscriptions, liveness pings, snapshots, revalidation of quiet pools and
 * reconnects. Reports facts to the reconciler; never judges eligibility or staleness.
 * See docs/llds/ingest-sources.md.
 * @spec ING-SRC-001, ING-SRC-002, ING-RPC-010
 */
export class RpcVenueAdapter {
  readonly id: PoolVenue;
  readonly stats: RpcAdapterStats = { updates: 0, decodeErrors: new Map(), unknownSubscription: 0, subscribeFailures: new Map(), reconnects: new Map() };

  private readonly d: RpcAdapterDeps;
  private readonly o: RpcAdapterOptions;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly limited: RateLimitedLog;
  private readonly tel: TelemetryHooks;
  private readonly out = new Float64Array(OUT_LEN);
  /** Pool indexes of this venue, and those excluded as misconfigured. */
  private readonly venuePools: number[];
  private readonly misconfigured = new Set<number>();
  private validated = false;
  private booted = false;
  private stopped = false;

  private ws: WebSocket | undefined;
  private reqId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subToPool = new Map<number, number>();
  private slotSub: number | null = null;
  private readonly confirmed = new Set<number>();
  private snapshotState: 'none' | 'inflight' | 'done' = 'none';
  private live = false;
  private liveSince = 0;
  private attempt = 0;
  private readonly lastHeard: Float64Array;
  private revalidating = false;
  private warnedSize = new Set<number>();
  /** Monotonic time before which HTTP calls are held back after a 429 (ING-RPC-044). */
  private httpHoldUntil = 0;

  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private checkTimer: NodeJS.Timeout | undefined;
  private readonly backgroundTimers = new Set<NodeJS.Timeout>();

  constructor(deps: RpcAdapterDeps) {
    this.d = deps;
    this.id = deps.venue;
    this.o = { ...DEFAULT_RPC_OPTIONS, ...deps.options };
    this.random = deps.random ?? Math.random;
    this.log = deps.logger.child({ component: 'ingest', source: deps.venue });
    this.limited = new RateLimitedLog(this.log, deps.clock);
    this.tel = deps.telemetry ?? noTelemetry;
    this.venuePools = deps.model.pools.filter((p) => p.venue === deps.venue).map((p) => p.index);
    this.lastHeard = new Float64Array(deps.model.pools.length);
  }

  /**
   * Validates the venue's pools, then connects. Resolves once the first validation attempt
   * has finished; rejects with `PoolValidationError` if pools fail validation at boot.
   * If the RPC is unreachable, keeps retrying in the background (RUN-LIFE-005).
   */
  async start(): Promise<void> {
    this.d.sink.onSourceState(this.id, 'connecting');
    const ok = await this.validate();
    this.booted = true;
    if (ok) this.connect();
    else this.scheduleRevalidateBoot();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.limited.stop();
    this.clearConnectionTimers();
    clearTimeout(this.reconnectTimer);
    for (const t of this.backgroundTimers) clearTimeout(t);
    this.backgroundTimers.clear();
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.terminate();
      });
    }
  }

  // -------------------------------------------------------------------------------------
  // Validation

  /** @returns true once the venue is validated; false if the RPC was unreachable. */
  // @spec ING-RPC-001, ING-RPC-005
  private async validate(): Promise<boolean> {
    const addresses = poolAddresses(this.d.markets, this.id);
    const v = await validateVenuePools(this.id, addresses, this.d.rpcHttp, this.d.decoder);
    if (this.stopped) return false;
    if (v.kind === 'unreachable') {
      this.noteFailure(v.failure);
      this.log.warn({ failure: v.failure }, 'pool validation: RPC unreachable, will retry');
      return false;
    }
    const resolveErrors = resolveVenue(this.d.model, this.id, v.facts);
    const problems: PoolProblem[] = [...v.problems];
    const bad = new Set<number>();
    for (const p of v.problems) {
      const i = this.d.model.poolIndexByAddress.get(p.address);
      if (i !== undefined) bad.add(i);
    }
    for (const e of resolveErrors) {
      for (const i of e.pools) bad.add(i);
      if (!v.problems.some((p) => e.message.includes(p.address))) problems.push({ address: this.d.model.pools[e.pools[0]!]!.address, message: e.message });
    }
    if (problems.length && !this.booted) throw new PoolValidationError(this.id, problems);
    for (const i of bad) {
      if (this.misconfigured.has(i)) continue;
      this.misconfigured.add(i);
      const addr = this.d.model.pools[i]!.address;
      this.d.sink.onPoolMisconfigured(i, problems.find((p) => p.message.includes(addr))?.message ?? 'failed validation');
    }
    if (problems.length) this.log.error({ problems }, 'pools misconfigured; excluded from subscription');
    this.validated = true;
    return true;
  }

  private scheduleRevalidateBoot(): void {
    if (this.stopped) return;
    const delay = this.nextDelay();
    this.reconnectTimer = setTimeout(() => {
      void this.validate().then((ok) => (ok ? this.connect() : this.scheduleRevalidateBoot()));
    }, delay);
  }

  private get subscribablePools(): number[] {
    return this.venuePools.filter((p) => !this.misconfigured.has(p));
  }

  // -------------------------------------------------------------------------------------
  // Connection

  private connect(): void {
    if (this.stopped || !this.validated) return;
    const ws = new WebSocket(this.d.wsUrl, { maxPayload: this.o.maxPayload, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data: Buffer) => this.onMessage(data));
    ws.on('pong', () => {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    ws.on('error', (err) => this.log.debug({ err }, 'websocket error'));
    ws.on('close', (code) => this.onDisconnect(ws, 'close', code));
  }

  // @spec ING-RPC-011, ING-RPC-017
  private onOpen(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.sendSubscribe('slot', -1, 0);
    for (const p of this.subscribablePools) this.sendSubscribe('pool', p, 0);
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      // Arm the deadline only if no pong is outstanding; re-arming on every ping would let a
      // dead peer go undetected whenever the ping interval is shorter than the timeout.
      this.pongTimer ??= setTimeout(() => this.reconnect('ping_timeout'), this.o.pongTimeoutMs);
    }, this.o.pingIntervalMs);
    this.checkTimer = setInterval(() => this.periodic(), this.o.checkIntervalMs);
  }

  private sendSubscribe(kind: 'slot' | 'pool', pool: number, attempt: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = this.reqId++;
    const msg =
      kind === 'slot'
        ? { jsonrpc: '2.0', id, method: 'slotSubscribe' }
        : {
            jsonrpc: '2.0',
            id,
            method: 'accountSubscribe',
            params: [this.d.model.pools[pool]!.address, { encoding: 'base64', commitment: this.d.commitment }],
          };
    const timer = setTimeout(() => this.subscribeFailed(id, 'timeout'), this.o.subscribeTimeoutMs);
    this.pending.set(id, { kind, pool, attempt, timer });
    ws.send(JSON.stringify(msg));
  }

  // @spec ING-RPC-013, ING-RPC-014
  private subscribeFailed(id: number, code: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.stats.subscribeFailures.set(code, (this.stats.subscribeFailures.get(code) ?? 0) + 1);
    this.limited.warn('subscribe_failed', code, { code }, 'subscription request failed');
    const ws = this.ws;
    if (p.attempt < this.o.subscribeRetries) {
      const delay = fullJitter(p.attempt, this.o.backoffBaseMs, this.o.backoffCapMs, this.random);
      this.later(delay, ws, () => this.sendSubscribe(p.kind, p.pool, p.attempt + 1));
    } else {
      this.log.warn({ pool: p.kind === 'pool' ? this.d.model.pools[p.pool]!.address : 'slot', code }, 'subscription failed after retries; retrying in background');
      this.later(this.o.backgroundResubscribeMs, ws, () => this.sendSubscribe(p.kind, p.pool, 0));
    }
  }

  /** Runs `fn` after `ms` if the same socket is still current. */
  private later(ms: number, ws: WebSocket | undefined, fn: () => void): void {
    const t = setTimeout(() => {
      this.backgroundTimers.delete(t);
      if (!this.stopped && ws === this.ws) fn();
    }, ms);
    this.backgroundTimers.add(t);
  }

  // -------------------------------------------------------------------------------------
  // Hot path

  // @spec ING-SRC-003, ING-RPC-016, ING-RPC-020, ING-RPC-021, ING-RPC-022, ING-RPC-023, ING-RPC-024, ING-RPC-025, ING-RPC-026
  private onMessage(buf: Buffer): void {
    const recvTs = this.d.clock.mono();
    const recvWall = this.d.clock.wall();
    const out = this.out;
    const status = this.d.decoder.decodeNotification(buf, out);
    if (status === Status.ACCOUNT) {
      const decodedTs = this.d.clock.mono();
      this.tel.decode(this.id, decodedTs - recvTs);
      const pool = this.subToPool.get(out[Out.SUB]!);
      if (pool === undefined) {
        this.stats.unknownSubscription++;
        return;
      }
      this.lastHeard[pool] = recvTs;
      this.stats.updates++;
      if (out[Out.SIZE_UNEXPECTED] === 1 && !this.warnedSize.has(out[Out.LAYOUT]!)) {
        this.warnedSize.add(out[Out.LAYOUT]!);
        this.log.warn({ layout: out[Out.LAYOUT], pool: this.d.model.pools[pool]!.address }, 'account size differs from documented layout size');
      }
      this.d.sink.onPoolUpdate(pool, out[Out.SQRT]!, out[Out.LIQ]!, out[Out.TICK]!, out[Out.SLOT]!, recvTs, recvWall, decodedTs, 'notification');
    } else if (status === Status.SLOT) {
      if (out[Out.SUB] === this.slotSub) this.d.sink.onSlot(this.id, out[Out.SLOT]!, recvTs);
    } else if (status === Status.OTHER) {
      this.onControl(buf);
    } else {
      this.stats.decodeErrors.set(status, (this.stats.decodeErrors.get(status) ?? 0) + 1);
      this.limited.warn('decode_error', String(status), { code: status }, 'frame rejected by decoder');
      const pool = out[Out.SUB]! >= 0 ? this.subToPool.get(out[Out.SUB]!) : undefined;
      if (pool !== undefined) this.d.sink.onPoolSuspect(pool);
    }
  }

  /** Cold path: subscription confirmations and JSON-RPC errors. */
  // @spec ING-RPC-012
  private onControl(buf: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as { id?: unknown; result?: unknown; error?: { code?: unknown } };
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.error !== undefined || typeof msg.result !== 'number') {
      this.subscribeFailed(msg.id, `rpc_${typeof msg.error?.code === 'number' ? msg.error.code : 'error'}`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (p.kind === 'slot') this.slotSub = msg.result;
    else {
      this.subToPool.set(msg.result, p.pool);
      this.confirmed.add(p.pool);
    }
    this.maybeSnapshot();
  }

  // -------------------------------------------------------------------------------------
  // Snapshot and liveness

  // @spec ING-RPC-006, ING-RPC-015, ING-RPC-043
  private maybeSnapshot(): void {
    if (this.snapshotState !== 'none' || this.slotSub === null || this.confirmed.size === 0) return;
    this.snapshotState = 'inflight';
    const ws = this.ws;
    void this.readPools(this.subscribablePools, 'snapshot').then((ok) => {
      if (ws !== this.ws || this.stopped) return;
      if (!ok) return this.reconnect('snapshot');
      this.snapshotState = 'done';
      this.live = true;
      this.liveSince = this.d.clock.mono();
      this.d.sink.onSourceState(this.id, 'live');
    });
  }

  /** Reads pools over HTTP and reports them as updates of the given kind. */
  private async readPools(pools: number[], kind: 'snapshot' | 'revalidation'): Promise<boolean> {
    if (pools.length === 0) return true;
    const addresses = pools.map((p) => this.d.model.pools[p]!.address);
    const t0 = this.d.clock.mono();
    const r = await this.d.rpcHttp.getMultipleAccounts(addresses);
    this.tel.request(this.id, kind === 'snapshot' ? 'snapshot' : 'revalidate', this.d.clock.mono() - t0);
    if (!r.ok) {
      this.noteFailure(r.failure);
      this.log.warn({ failure: r.failure, kind }, 'pool read failed');
      return false;
    }
    if (this.stopped) return false;
    const recvTs = this.d.clock.mono();
    const recvWall = this.d.clock.wall();
    r.value.accounts.forEach((acc, i) => {
      const pool = pools[i]!;
      if (!acc) return;
      const d = this.d.decoder.decodeAccount(acc.data, this.id);
      if (d.status !== Status.ACCOUNT || !d.info) return this.d.sink.onPoolSuspect(pool);
      this.lastHeard[pool] = recvTs;
      this.d.sink.onPoolUpdate(pool, d.info.sqrtRatio, d.info.liquidity, d.info.tick, r.value.slot, recvTs, recvWall, this.d.clock.mono(), kind);
    });
    return true;
  }

  // @spec ING-RPC-031, ING-RPC-041
  private periodic(): void {
    if (this.stopped) return;
    const now = this.d.clock.mono();
    const st = this.d.registry.sourceStatus(this.id);
    if (st.state === 'stale' && st.staleSince !== null && now - st.staleSince >= this.o.staleReconnectMs) {
      this.reconnect('stale');
      return;
    }
    if (!this.live || this.revalidating || now < this.httpHoldUntil) return;
    const quiet = [...this.confirmed].filter((p) => now - this.lastHeard[p]! >= this.o.revalidateAfterMs);
    if (quiet.length === 0) return;
    this.revalidating = true;
    void this.readPools(quiet, 'revalidation').finally(() => (this.revalidating = false));
  }

  // -------------------------------------------------------------------------------------
  // Reconnect

  private reconnect(cause: ReconnectCause): void {
    const ws = this.ws;
    if (!ws) return;
    this.onDisconnect(ws, cause, 0);
    ws.terminate();
  }

  // @spec ING-RPC-040, ING-RPC-042, ING-RPC-043
  private onDisconnect(ws: WebSocket, cause: ReconnectCause, code: number): void {
    if (ws !== this.ws) return;
    this.ws = undefined;
    this.clearConnectionTimers();
    if (this.stopped) return;
    this.stats.reconnects.set(cause, (this.stats.reconnects.get(cause) ?? 0) + 1);
    const now = this.d.clock.mono();
    if (this.live && now - this.liveSince >= this.o.backoffResetMs) this.attempt = 0;
    this.live = false;
    this.d.sink.onSourceState(this.id, 'down');
    const delay = this.nextDelay();
    this.log.info({ cause, code, attempt: this.attempt, delayMs: Math.round(delay) }, 'reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Backoff delay for the next attempt, never shorter than an outstanding Retry-After. */
  // @spec ING-RPC-044
  private nextDelay(): number {
    const backoff = fullJitter(this.attempt++, this.o.backoffBaseMs, this.o.backoffCapMs, this.random);
    return Math.max(backoff, this.httpHoldUntil - this.d.clock.mono());
  }

  private noteFailure(f: RpcFailure): void {
    if (f.kind !== 'rate_limited') return;
    const wait = f.retryAfterMs ?? fullJitter(this.attempt, this.o.backoffBaseMs, this.o.backoffCapMs, this.random);
    this.httpHoldUntil = Math.max(this.httpHoldUntil, this.d.clock.mono() + wait);
  }

  private clearConnectionTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    clearInterval(this.checkTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const t of this.backgroundTimers) clearTimeout(t);
    this.backgroundTimers.clear();
    this.subToPool.clear();
    this.confirmed.clear();
    this.slotSub = null;
    this.snapshotState = 'none';
    this.revalidating = false;
  }
}
