import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PoolVenue } from '@soltape/shared';
import type { Logger } from '@soltape/service/telemetry/logger.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Fixture } from './fixture.js';
import { accountFrame, accountFrameParts, garbageVariants, rpcError, rpcResult, slotFrame, type AccountValue } from './frames.js';
import { buildBenchSet, perturbSqrt, type BenchSet } from './synthetic.js';

export type ReplayMode = 'realtime' | 'rate';

export interface ReplayOptions {
  fixture: Fixture;
  mode: ReplayMode;
  port: number;
  host?: string;
  /** Realtime playback speed multiplier. */
  speed?: number;
  /** Rate mode: number of synthetic markets (two pools each). */
  benchMarkets?: number;
  logger: Logger;
  random?: () => number;
}

interface Conn {
  ws: WebSocket;
  venue: PoolVenue | null;
  /** address → subscription id */
  subs: Map<string, number>;
  slotSub: number | null;
}

export interface Faults {
  dropped: Set<PoolVenue>;
  stalled: Set<PoolVenue>;
  stalledAccounts: Set<string>;
  garbage: Map<PoolVenue, number>;
  jupiter: { status?: number; delayMs?: number };
}

export interface RateRun {
  rate: number;
  durationMs: number;
  warmupMs: number;
  /** process.hrtime.bigint() at the schedule's origin. */
  t0: bigint;
  sent: number;
  slots: Float64Array;
  /** Intended send time of each frame, in ns relative to t0. */
  intendedNs: Float64Array;
  done: Promise<void>;
  running: boolean;
}

const SLOT_SUB = 1;
const SUB_BASE = 1000;
const VARIANTS = 64;

/**
 * Stands in for a Solana RPC node and Jupiter: JSON-RPC over WebSocket and HTTP, the Price API
 * v3 endpoint, and a control API for fault injection and benchmark runs. The service cannot
 * tell it from mainnet. See docs/llds/replay-and-benchmark.md.
 * @spec RPL-SRV-001, RPL-SRV-002
 */
export class ReplayServer {
  readonly faults: Faults = { dropped: new Set(), stalled: new Set(), stalledAccounts: new Set(), garbage: new Map(), jupiter: {} };
  readonly stats = { loops: 0, framesSent: 0, connections: 0, unknownAccounts: 0 };
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly venueOf = new Map<string, PoolVenue>();
  private readonly subIdOf = new Map<string, number>();
  /** Latest replayed state per account, served by getMultipleAccounts. */
  private readonly state = new Map<string, AccountValue>();
  private currentSlot: number;
  private jupiterBody = '{}';
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly random: () => number;
  readonly bench: BenchSet | null;
  private rateRun: RateRun | null = null;

  constructor(private readonly o: ReplayOptions) {
    this.random = o.random ?? Math.random;
    const fx = o.fixture;
    for (const m of fx.header.markets.markets) {
      for (const venue of ['orca', 'raydium'] as const) {
        const v = m.venues[venue];
        if (v) for (const a of 'pool' in v ? [v.pool] : v.route) this.venueOf.set(a, venue);
      }
    }
    for (const a of fx.accounts.values()) this.state.set(a.address, { data: a.data, lamports: 1, owner: a.owner, space: Buffer.from(a.data, 'base64').length });
    this.bench = o.mode === 'rate' ? buildBenchSet(fx, o.benchMarkets ?? 10) : null;
    if (this.bench) {
      for (const p of this.bench.pools) this.venueOf.set(p.address, p.venue);
      for (const [addr, a] of this.bench.accounts) this.state.set(addr, { data: a.data.toString('base64'), lamports: 1, owner: a.owner, space: a.data.length });
    }
    [...this.state.keys()].forEach((a, i) => this.subIdOf.set(a, SUB_BASE + i));
    const slots = [...fx.frames.map((f) => f.slot), ...fx.slots.map((s) => s.slot), ...[...fx.accounts.values()].map((a) => a.slot)];
    this.currentSlot = slots.length ? Math.min(...slots) : 1;
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws)));
  }

  get port(): number {
    return (this.http.address() as AddressInfo).port;
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.http.listen(this.o.port, this.o.host ?? '0.0.0.0', r));
    if (this.o.mode === 'realtime') this.playRealtime();
    this.o.logger.info({ mode: this.o.mode, port: this.port, frames: this.o.fixture.frames.length, benchMarkets: this.bench?.markets.markets.length }, 'replay server listening');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  // ---- WebSocket JSON-RPC ------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const c: Conn = { ws, venue: null, subs: new Map(), slotSub: null };
    this.conns.add(c);
    this.stats.connections++;
    ws.on('close', () => this.conns.delete(c));
    ws.on('error', () => undefined);
    ws.on('message', (raw) => {
      let msg: { id?: unknown; method?: string; params?: unknown[] };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return void ws.send(rpcError(null, -32700, 'Parse error'));
      }
      const { id, method, params = [] } = msg;
      if (method === 'slotSubscribe') {
        c.slotSub = SLOT_SUB;
        ws.send(rpcResult(id, SLOT_SUB));
      } else if (method === 'accountSubscribe') {
        const address = String(params[0]);
        const venue = this.venueOf.get(address) ?? null;
        if (venue && this.faults.dropped.has(venue)) return void ws.terminate();
        c.venue ??= venue;
        const sub = this.subIdOf.get(address) ?? SUB_BASE + 1_000_000 + c.subs.size;
        c.subs.set(address, sub);
        ws.send(rpcResult(id, sub));
      } else if (method === 'accountUnsubscribe' || method === 'slotUnsubscribe') {
        const sub = Number(params[0]);
        if (method === 'slotUnsubscribe') c.slotSub = null;
        else for (const [a, s] of c.subs) if (s === sub) c.subs.delete(a);
        ws.send(rpcResult(id, true));
      } else {
        ws.send(rpcError(id, -32601, `Method not found: ${String(method)}`));
      }
    });
  }

  private sendAccount(address: string, v: AccountValue, slot: number): void {
    const venue = this.venueOf.get(address);
    for (const c of this.conns) {
      const sub = c.subs.get(address);
      if (sub === undefined || (venue && this.faults.stalled.has(venue)) || this.faults.stalledAccounts.has(address)) continue;
      let frame = accountFrame(v, sub, slot);
      const g = venue ? this.faults.garbage.get(venue) : undefined;
      if (g && this.random() < g) {
        const variants = garbageVariants(frame);
        frame = variants[Math.floor(this.random() * variants.length)]!;
      }
      c.ws.send(frame);
      this.stats.framesSent++;
    }
  }

  private sendSlot(slot: number): void {
    for (const c of this.conns) {
      if (c.slotSub === null || (c.venue && this.faults.stalled.has(c.venue))) continue;
      c.ws.send(slotFrame(c.slotSub, slot));
    }
  }

  // ---- realtime playback --------------------------------------------------------------------

  /**
   * Plays frames, slot notifications and Jupiter responses at their recorded timing (scaled by
   * `speed`), looping forever with slots rebased so they keep increasing.
   * @spec RPL-SRV-005
   */
  private playRealtime(): void {
    const fx = this.o.fixture;
    const speed = this.o.speed ?? 1;
    const slotVenue = fx.slots.find((s) => s.venue === 'orca') ? 'orca' : fx.slots[0]?.venue;
    type Ev = { t: number; run: (offset: number) => void };
    const events: Ev[] = [
      ...fx.frames.map((f): Ev => ({
        t: f.t,
        run: (off) => {
          const v = { data: f.data, lamports: f.lamports, owner: f.owner, space: f.space };
          this.state.set(f.address, v);
          this.currentSlot = Math.max(this.currentSlot, f.slot + off);
          this.sendAccount(f.address, v, f.slot + off);
        },
      })),
      ...fx.slots.filter((s) => s.venue === slotVenue).map((s): Ev => ({
        t: s.t,
        run: (off) => {
          this.currentSlot = Math.max(this.currentSlot, s.slot + off);
          this.sendSlot(s.slot + off);
        },
      })),
      ...fx.jupiter.map((j): Ev => ({ t: j.t, run: () => (this.jupiterBody = rebaseJupiter(j.body, this.currentSlot)) })),
    ].sort((a, b) => a.t - b.t);
    if (events.length === 0) return;
    const all = [...fx.frames.map((f) => f.slot), ...fx.slots.map((s) => s.slot)];
    const span = all.length ? Math.max(...all) - Math.min(...all) + 1 : 1;
    const durationUs = Math.max(events.at(-1)!.t + 1, fx.header.durationMs * 1000);
    let offset = 0;
    let i = 0;
    let loopStart = performance.now();
    const tick = () => {
      if (this.stopped) return;
      const elapsedUs = (performance.now() - loopStart) * 1000 * speed;
      while (i < events.length && events[i]!.t <= elapsedUs) events[i++]!.run(offset);
      if (i >= events.length && elapsedUs >= durationUs) {
        this.stats.loops++;
        offset += span;
        i = 0;
        loopStart = performance.now();
      }
      const nextUs = i < events.length ? events[i]!.t : durationUs;
      this.timer = setTimeout(tick, Math.max(0, (nextUs - elapsedUs) / 1000 / speed));
    };
    tick();
  }

  // ---- rate mode (benchmark) -----------------------------------------------------------------

  /**
   * Measures this process's maximum frame-emit rate to a null sink; a benchmark must not be
   * limited by its own generator.
   * @spec RPL-SRV-008
   */
  measureEmitCapacity(ms = 300): number {
    const parts = this.precompute();
    let n = 0;
    let slot = this.currentSlot;
    let sink = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      for (let k = 0; k < 1000; k++) {
        const p = parts[n % parts.length]![0]!;
        sink += (p.prefix + ++slot + p.suffix).length;
        n++;
      }
    }
    if (sink < 0) throw new Error('unreachable');
    return (n / ms) * 1000;
  }

  /** Frame parts per pool and price variant (sub id fixed per pool). */
  private precompute(): { prefix: string; suffix: string }[][] {
    const b = this.bench!;
    return b.pools.map((p) =>
      Array.from({ length: VARIANTS }, (_, v) => {
        const data = perturbSqrt(p.data, p.venue, (v - VARIANTS / 2) * 1e-6).toString('base64');
        return accountFrameParts({ data, lamports: 1, owner: p.owner, space: p.data.length }, this.subIdOf.get(p.address)!);
      }),
    );
  }

  /**
   * Emits account notifications at a fixed rate over the synthetic pools on an open-loop
   * schedule: frame i is due at t0 + i/rate whatever the service does, and its *intended*
   * time is logged (no coordinated omission). Slots come from one global counter.
   * @spec RPL-SRV-006, RPL-SRV-008, RPL-SRV-009, RPL-SRV-010
   */
  startRate(rate: number, durationMs: number, warmupMs = 0): RateRun {
    if (!this.bench) throw new Error('rate mode requires --mode rate');
    if (this.rateRun?.running) throw new Error('a rate run is already in progress');
    const capacity = this.measureEmitCapacity();
    if (capacity < 3 * rate) throw new Error(`generator capacity ${Math.round(capacity)}/s is below 3x the target rate ${rate}/s; refusing to run`);
    const parts = this.precompute();
    const pools = this.bench.pools;
    const total = Math.floor((rate * (warmupMs + durationMs)) / 1000);
    const periodNs = 1e9 / rate;
    const run: RateRun = { rate, durationMs, warmupMs, t0: process.hrtime.bigint(), sent: 0, slots: new Float64Array(total), intendedNs: new Float64Array(total), done: Promise.resolve(), running: true };
    const byPool = pools.map((p) => [...this.conns].find((c) => c.subs.has(p.address)) ?? null);
    let lastSlotNotif = 0;
    run.done = new Promise<void>((resolve) => {
      const tick = () => {
        if (this.stopped) return resolve();
        // Refresh subscriber lookups occasionally (reconnects during a run).
        if (run.sent % 4096 === 0) pools.forEach((p, i) => (byPool[i] = [...this.conns].find((c) => c.subs.has(p.address)) ?? null));
        const nowNs = Number(process.hrtime.bigint() - run.t0);
        while (run.sent < total && run.sent * periodNs <= nowNs) {
          const i = run.sent;
          const pi = i % pools.length;
          const variant = Math.floor(i / pools.length) % VARIANTS;
          const slot = ++this.currentSlot;
          run.slots[i] = slot;
          run.intendedNs[i] = i * periodNs;
          const conn = byPool[pi];
          if (conn && !this.faults.stalled.has(pools[pi]!.venue)) {
            const p = parts[pi]![variant]!;
            conn.ws.send(p.prefix + slot + p.suffix);
          }
          run.sent++;
        }
        if (nowNs - lastSlotNotif >= 100e6) {
          lastSlotNotif = nowNs;
          this.sendSlot(this.currentSlot);
        }
        if (run.sent >= total) {
          run.running = false;
          return resolve();
        }
        setImmediate(tick);
      };
      tick();
    });
    this.rateRun = run;
    return run;
  }

  // ---- HTTP: JSON-RPC, Jupiter, control -------------------------------------------------------

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://replay');
    const body = req.method === 'POST' ? await readBody(req) : '';
    if (url.pathname === '/' && req.method === 'POST') return this.onRpcHttp(body, res);
    if (url.pathname === '/price/v3' && req.method === 'GET') return this.onJupiter(req, res);
    if (url.pathname === '/control' && req.method === 'POST') return this.onControl(body, res);
    if (url.pathname === '/control/status') return json(res, 200, this.status());
    if (url.pathname === '/control/sendlog') return this.onSendLog(res);
    json(res, 404, { error: 'not found' });
  }

  /** @spec RPL-SRV-003, RPL-SRV-004 */
  private onRpcHttp(body: string, res: ServerResponse): void {
    let msg: { id?: unknown; method?: string; params?: unknown[] };
    try {
      msg = JSON.parse(body) as typeof msg;
    } catch {
      return json(res, 200, JSON.parse(rpcError(null, -32700, 'Parse error')));
    }
    if (msg.method === 'getSlot') return json(res, 200, JSON.parse(rpcResult(msg.id, this.currentSlot)));
    if (msg.method !== 'getMultipleAccounts') return json(res, 200, JSON.parse(rpcError(msg.id, -32601, 'Method not found')));
    const keys = (msg.params?.[0] ?? []) as string[];
    const value = keys.map((k) => {
      const a = this.state.get(k);
      if (!a) {
        this.stats.unknownAccounts++;
        this.o.logger.error({ address: k }, `fixture does not cover ${k}; run pnpm record`);
        return null;
      }
      return { data: [a.data, 'base64'], executable: false, lamports: a.lamports, owner: a.owner, rentEpoch: 18446744073709551615, space: a.space };
    });
    json(res, 200, { jsonrpc: '2.0', result: { context: { slot: this.currentSlot }, value }, id: msg.id });
  }

  /** @spec RPL-SRV-002, RPL-FLT-005 */
  private async onJupiter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.headers['x-api-key']) return json(res, 401, { error: 'missing x-api-key' });
    const f = this.faults.jupiter;
    if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    if (f.status) return json(res, f.status, { error: 'injected fault' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(this.jupiterBody);
  }

  /** @spec RPL-FLT-001, RPL-FLT-002, RPL-FLT-003, RPL-FLT-004, RPL-FLT-005, RPL-FLT-006 */
  private onControl(body: string, res: ServerResponse): void {
    let cmd: { op?: string; venue?: string; address?: string; rate?: number; status?: number; delayMs?: number; durationMs?: number; warmupMs?: number };
    try {
      cmd = JSON.parse(body) as typeof cmd;
    } catch {
      return json(res, 400, { error: 'body must be JSON' });
    }
    const venues = (v: string | undefined): PoolVenue[] => (v === '*' ? ['orca', 'raydium'] : v === 'orca' || v === 'raydium' ? [v] : []);
    switch (cmd.op) {
      case 'drop':
        for (const v of venues(cmd.venue)) {
          this.faults.dropped.add(v);
          for (const c of this.conns) if (c.venue === v) c.ws.terminate();
        }
        break;
      case 'stall':
        for (const v of venues(cmd.venue)) this.faults.stalled.add(v);
        break;
      case 'stall_accounts':
        if (cmd.address) this.faults.stalledAccounts.add(cmd.address);
        break;
      case 'garbage':
        for (const v of venues(cmd.venue)) this.faults.garbage.set(v, Math.max(0, Math.min(1, cmd.rate ?? 0.1)));
        break;
      case 'jupiter':
        this.faults.jupiter = { ...(cmd.status ? { status: cmd.status } : {}), ...(cmd.delayMs ? { delayMs: cmd.delayMs } : {}) };
        break;
      case 'restore':
        for (const v of cmd.venue === '*' || cmd.venue === undefined ? (['orca', 'raydium'] as const) : venues(cmd.venue)) {
          this.faults.dropped.delete(v);
          this.faults.stalled.delete(v);
          this.faults.garbage.delete(v);
        }
        if (cmd.venue === '*' || cmd.venue === undefined) {
          this.faults.stalledAccounts.clear();
          this.faults.jupiter = {};
        }
        break;
      case 'rate':
        try {
          const r = this.startRate(cmd.rate ?? 1000, cmd.durationMs ?? 10_000, cmd.warmupMs ?? 0);
          return json(res, 202, { started: true, rate: r.rate, durationMs: r.durationMs, warmupMs: r.warmupMs });
        } catch (err) {
          return json(res, 409, { error: (err as Error).message });
        }
      default:
        return json(res, 400, { error: `unknown op ${String(cmd.op)}` });
    }
    json(res, 200, { ok: true, faults: this.status().faults });
  }

  status() {
    return {
      mode: this.o.mode,
      slot: this.currentSlot,
      loops: this.stats.loops,
      connections: this.conns.size,
      framesSent: this.stats.framesSent,
      subscriptions: [...this.conns].reduce((n, c) => n + c.subs.size, 0),
      faults: {
        dropped: [...this.faults.dropped],
        stalled: [...this.faults.stalled],
        stalledAccounts: [...this.faults.stalledAccounts],
        garbage: Object.fromEntries(this.faults.garbage),
        jupiter: this.faults.jupiter,
      },
      rate: this.rateRun ? { running: this.rateRun.running, sent: this.rateRun.sent, rate: this.rateRun.rate } : null,
      benchMarkets: this.bench?.markets.markets.length ?? 0,
    };
  }

  /** Binary send log: t0 (decimal ns) in a header, then (slot, intendedNs) f64 pairs. */
  private onSendLog(res: ServerResponse): void {
    const r = this.rateRun;
    if (!r) return json(res, 404, { error: 'no rate run' });
    const n = r.sent;
    const buf = Buffer.alloc(n * 16);
    for (let i = 0; i < n; i++) {
      buf.writeDoubleLE(r.slots[i]!, i * 16);
      buf.writeDoubleLE(r.intendedNs[i]!, i * 16 + 8);
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-t0-ns': r.t0.toString(), 'x-count': String(n), 'x-warmup-ms': String(r.warmupMs), 'x-rate': String(r.rate) });
    res.end(buf);
  }
}

/** Rewrites Jupiter blockIds to the current replay slot so the lag check sees fresh data. */
function rebaseJupiter(body: string, slot: number): string {
  try {
    const o = JSON.parse(body) as Record<string, { blockId?: number }>;
    for (const v of Object.values(o)) if (v && typeof v === 'object' && 'blockId' in v) v.blockId = slot;
    return JSON.stringify(o);
  } catch {
    return body;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
