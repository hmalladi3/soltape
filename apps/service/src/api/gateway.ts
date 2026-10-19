import type { Clock } from '@soltape/shared';
import type { RawData, WebSocket } from 'ws';
import type { MarketModel } from '../markets/model.js';
import type { Consolidated, ConsolidatedListener, EmitStamps } from '../reconcile/types.js';
import { noTelemetry, type TelemetryHooks } from '../telemetry/hooks.js';
import type { LatencyWindow } from '../telemetry/latency.js';
import type { Logger } from '../telemetry/logger.js';
import { lookupMint } from './mint.js';
import { restConsolidated } from './views.js';

export interface GatewayOptions {
  highWater: number;
  lowWater: number;
  drainMs: number;
  slowClientMs: number;
  maxSubscriptions: number;
  maxStrikes: number;
  heartbeatMs: number;
}

export const DEFAULT_GATEWAY_OPTIONS: GatewayOptions = {
  highWater: 256 * 1024,
  lowWater: 64 * 1024,
  drainMs: 10,
  slowClientMs: 10_000,
  maxSubscriptions: 100,
  maxStrikes: 10,
  heartbeatMs: 30_000,
};

/** Market data source for snapshots on subscribe. */
export interface SnapshotSource {
  consolidated(market: number): Consolidated | null;
  available(market: number): boolean;
}

export interface GatewayStats {
  clients: number;
  messagesSent: number;
  conflated: number;
  slowDisconnects: number;
}

class Client {
  readonly subs = new Set<number>();
  /** Latest undelivered frame per market while congested (index = market). */
  readonly pending: (Buffer | undefined)[];
  pendingCount = 0;
  congestedSince: number | null = null;
  strikes = 0;
  alive = true;
  constructor(
    readonly ws: WebSocket,
    markets: number,
  ) {
    this.pending = new Array<Buffer | undefined>(markets);
  }
}

const SEND_TEXT = { binary: false } as const;

/**
 * WebSocket fan-out: subscriptions per market, one serialization per update shared by every
 * subscriber, and conflation instead of queueing for slow consumers. See
 * docs/llds/api-gateway.md § WebSocket Protocol and § Fan-out and Backpressure.
 */
export class WsGateway implements ConsolidatedListener {
  readonly stats: GatewayStats = { clients: 0, messagesSent: 0, conflated: 0, slowDisconnects: 0 };
  private readonly o: GatewayOptions;
  private readonly clients = new Set<Client>();
  /** Subscribers per market (index = market). */
  private readonly subscribers: Client[][];
  private readonly congested = new Set<Client>();
  private drainTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly log: Logger;

  constructor(
    private readonly d: {
      model: MarketModel;
      source: SnapshotSource;
      clock: Clock;
      logger: Logger;
      latency?: LatencyWindow;
      telemetry?: TelemetryHooks;
      options?: Partial<GatewayOptions>;
    },
  ) {
    this.o = { ...DEFAULT_GATEWAY_OPTIONS, ...d.options };
    this.subscribers = d.model.markets.map(() => []);
    this.log = d.logger.child({ component: 'gateway' });
  }

  start(): void {
    this.drainTimer = setInterval(() => this.drain(), this.o.drainMs);
    this.drainTimer.unref();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.o.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    clearInterval(this.drainTimer);
    clearInterval(this.heartbeatTimer);
  }

  /** Closes every client with `code` and waits for the sockets to close. */
  async closeAll(code: number, reason = 'server shutting down'): Promise<void> {
    const closing = [...this.clients].map(
      (c) =>
        new Promise<void>((resolve) => {
          c.ws.once('close', () => resolve());
          c.ws.close(code, reason);
          setTimeout(() => {
            c.ws.terminate();
            resolve();
          }, 1000).unref();
        }),
    );
    await Promise.all(closing);
  }

  // -------------------------------------------------------------------------------------
  // Connections and protocol

  // @spec API-WS-001, API-WS-002, API-WS-003, API-WS-004, API-WS-005, API-WS-006, API-WS-020, API-WS-022, API-WS-023
  accept(ws: WebSocket): void {
    const c = new Client(ws, this.subscribers.length);
    this.clients.add(c);
    this.stats.clients = this.clients.size;
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(c, data, isBinary));
    ws.on('close', () => this.drop(c));
    ws.on('error', (err) => this.log.debug({ err }, 'client socket error'));
  }

  private onMessage(c: Client, data: RawData, isBinary: boolean): void {
    let msg: unknown;
    try {
      msg = isBinary ? undefined : JSON.parse((data as Buffer).toString('utf8'));
    } catch {
      msg = undefined;
    }
    const op = typeof msg === 'object' && msg !== null && !Array.isArray(msg) ? (msg as { op?: unknown }).op : undefined;
    const mints = (msg as { mints?: unknown } | undefined)?.mints;
    if (op === 'ping') {
      this.sendNow(c, Buffer.from('{"type":"pong"}'));
      return;
    }
    if ((op === 'subscribe' || op === 'unsubscribe') && Array.isArray(mints) && mints.every((m) => typeof m === 'string')) {
      return op === 'subscribe' ? this.subscribe(c, mints) : this.unsubscribe(c, mints);
    }
    this.strike(c, 'BAD_MESSAGE', 'expected {"op":"subscribe"|"unsubscribe","mints":[...]} or {"op":"ping"}');
  }

  // @spec API-WS-021
  private subscribe(c: Client, entries: string[]): void {
    const markets: number[] = [];
    const rejected: { mint: string; reason: string }[] = [];
    for (const e of entries) {
      if (e === '*') {
        for (const m of this.d.model.markets) markets.push(m.index);
        continue;
      }
      const r = lookupMint(this.d.model, e);
      if (r.ok) markets.push(r.market);
      else rejected.push({ mint: e, reason: r.code });
    }
    const added: number[] = [];
    let overLimit = false;
    for (const m of new Set(markets)) {
      if (c.subs.has(m)) continue;
      if (c.subs.size >= this.o.maxSubscriptions) {
        overLimit = true;
        continue;
      }
      c.subs.add(m);
      this.subscribers[m]!.push(c);
      added.push(m);
    }
    this.sendNow(c, json({ type: 'subscribed', mints: [...new Set(markets)].filter((m) => c.subs.has(m)).map((m) => this.d.model.markets[m]!.mint) }));
    if (rejected.length) this.strike(c, 'INVALID_MINTS', 'some entries were rejected', { rejected });
    if (overLimit) this.sendNow(c, json({ type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS', message: `at most ${this.o.maxSubscriptions} mints per connection` }));
    for (const m of added) {
      const snap = this.d.source.consolidated(m);
      if (this.d.source.available(m) && snap) this.enqueue(c, m, json({ type: 'snapshot', data: restConsolidated(snap), trigger: snap.trigger }));
      else this.enqueue(c, m, json({ type: 'unavailable', mint: this.d.model.markets[m]!.mint, lastKnown: snap ? restConsolidated(snap) : null }));
    }
  }

  private unsubscribe(c: Client, entries: string[]): void {
    const removed: string[] = [];
    for (const e of entries) {
      const markets = e === '*' ? this.d.model.markets.map((m) => m.index) : [lookupMint(this.d.model, e)].flatMap((r) => (r.ok ? [r.market] : []));
      for (const m of markets) {
        if (!c.subs.delete(m)) continue;
        this.removeSubscriber(m, c);
        if (c.pending[m]) {
          c.pending[m] = undefined;
          c.pendingCount--;
        }
        removed.push(this.d.model.markets[m]!.mint);
      }
    }
    this.sendNow(c, json({ type: 'unsubscribed', mints: removed }));
  }

  private strike(c: Client, code: string, message: string, extra: Record<string, unknown> = {}): void {
    c.strikes++;
    this.sendNow(c, json({ type: 'error', code, message, ...extra }));
    if (c.strikes >= this.o.maxStrikes) c.ws.close(1008, 'too many bad messages');
  }

  // @spec API-WS-024
  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private drop(c: Client): void {
    if (!this.clients.delete(c)) return;
    for (const m of c.subs) this.removeSubscriber(m, c);
    this.congested.delete(c);
    this.stats.clients = this.clients.size;
  }

  private removeSubscriber(m: number, c: Client): void {
    const arr = this.subscribers[m]!;
    const i = arr.indexOf(c);
    if (i >= 0) {
      arr[i] = arr[arr.length - 1]!;
      arr.pop();
    }
  }

  // -------------------------------------------------------------------------------------
  // Fan-out (hot path)

  /** Serializes once and fans out; records internal latency once the last send is done. */
  // @spec API-WS-007, API-FAN-001
  onConsolidated(market: number, c: Consolidated, stamps: EmitStamps): void {
    const subs = this.subscribers[market]!;
    if (subs.length > 0) {
      const frame = Buffer.from(JSON.stringify({ type: 'price', data: restConsolidated(c), trigger: c.trigger }));
      for (let i = 0; i < subs.length; i++) this.enqueue(subs[i]!, market, frame);
    }
    const t3 = this.d.clock.mono();
    const internal = stamps.recvTs === null ? null : t3 - stamps.recvTs;
    if (internal !== null) this.d.latency?.record(internal);
    const t = this.d.telemetry ?? noTelemetry;
    const src = c.trigger.source;
    const venue = src.startsWith('orca') ? 'orca' : src.startsWith('raydium') ? 'raydium' : src === 'jupiter' ? 'jupiter' : 'sweep';
    const decoded = stamps.decodedTs ?? stamps.recvTs ?? stamps.reconciledTs;
    t.emitted(
      venue,
      stamps.decodedTs !== null && stamps.recvTs !== null ? stamps.decodedTs - stamps.recvTs : null,
      stamps.reconciledTs - decoded,
      t3 - stamps.reconciledTs,
      internal,
    );
  }

  // @spec API-WS-008
  onUnavailable(market: number, lastKnown: Consolidated | null): void {
    const subs = this.subscribers[market]!;
    if (subs.length === 0) return;
    const frame = json({ type: 'unavailable', mint: this.d.model.markets[market]!.mint, lastKnown: lastKnown ? restConsolidated(lastKnown) : null });
    for (let i = 0; i < subs.length; i++) this.enqueue(subs[i]!, market, frame);
  }

  /** Sends now, or keeps only the newest frame for this market while the client is congested. */
  // @spec API-FAN-002
  private enqueue(c: Client, market: number, frame: Buffer): void {
    if (c.congestedSince === null && c.ws.bufferedAmount <= this.o.highWater) {
      c.ws.send(frame, SEND_TEXT);
      this.stats.messagesSent++;
      return;
    }
    if (c.congestedSince === null) {
      c.congestedSince = this.d.clock.mono();
      this.congested.add(c);
    }
    if (c.pending[market] === undefined) c.pendingCount++;
    c.pending[market] = frame;
    this.stats.conflated++;
  }

  /** Control replies bypass conflation but still go out in order. */
  private sendNow(c: Client, frame: Buffer): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(frame, SEND_TEXT);
  }

  // @spec API-FAN-003, API-FAN-004
  private drain(): void {
    if (this.congested.size === 0) return;
    const now = this.d.clock.mono();
    for (const c of this.congested) {
      if (c.ws.bufferedAmount <= this.o.lowWater) {
        for (let m = 0; m < c.pending.length && c.pendingCount > 0; m++) {
          const f = c.pending[m];
          if (f === undefined) continue;
          c.pending[m] = undefined;
          c.pendingCount--;
          c.ws.send(f, SEND_TEXT);
          this.stats.messagesSent++;
        }
        c.congestedSince = null;
        this.congested.delete(c);
      } else if (now - c.congestedSince! >= this.o.slowClientMs) {
        this.stats.slowDisconnects++;
        this.congested.delete(c);
        this.log.info({ bufferedAmount: c.ws.bufferedAmount }, 'disconnecting slow client');
        c.ws.close(1013, 'client too slow');
        setTimeout(() => c.ws.terminate(), 1000).unref();
      }
    }
  }
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
