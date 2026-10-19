import { systemClock } from '@soltape/shared';
import WebSocket from 'ws';
import { WsGateway, type GatewayOptions } from '../../src/api/gateway.js';
import type { DependencyState } from '../../src/api/health.js';
import type { HistoryReader } from '../../src/api/history.js';
import { ApiServer } from '../../src/api/server.js';
import { Reconciler } from '../../src/reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS } from '../../src/reconcile/types.js';
import { PhaseHolder } from '../../src/runtime/runtime.js';
import { LatencyWindow } from '../../src/telemetry/latency.js';
import { recordingLogger } from './ingest.js';
import { sqrtForPoolPrice, testModel } from './model.js';
import { waitFor } from './fake-rpc.js';

export async function startApi(opts: { gateway?: Partial<GatewayOptions>; history?: HistoryReader; maxPayload?: number } = {}) {
  const model = testModel();
  const clock = systemClock;
  const reconciler = new Reconciler({ model, clock, thresholds: DEFAULT_THRESHOLDS });
  const logs: { level: string; obj: object; msg?: string }[] = [];
  const logger = recordingLogger(logs);
  const latency = new LatencyWindow(clock);
  const gateway = new WsGateway({ model, source: reconciler, clock, logger, latency, options: opts.gateway ?? {} });
  reconciler.setListeners({ gateway });
  const phase = new PhaseHolder();
  phase.phase = 'running';
  const deps = { redis: 'up' as DependencyState, postgres: 'up' as DependencyState };
  const server = new ApiServer({
    port: 0,
    host: '127.0.0.1',
    model,
    reconciler,
    gateway,
    phase,
    clock,
    logger,
    decoderImpl: 'native',
    dependencies: { redis: () => deps.redis, postgres: () => deps.postgres },
    latency,
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.maxPayload ? { maxPayload: opts.maxPayload } : {}),
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  let slot = 1000;
  const feed = {
    live(...sources: ('orca' | 'raydium' | 'jupiter')[]) {
      for (const s of sources) {
        reconciler.onSourceState(s, 'live');
        reconciler.onSlot(s, slot, clock.mono());
      }
    },
    pool(index: number, price: number) {
      const p = model.pools[index]!;
      const t = clock.mono();
      reconciler.onPoolUpdate(index, sqrtForPoolPrice(p, price), 1e12, 0, ++slot, t, clock.wall(), t, 'notification');
    },
    quote(market: number, price: number) {
      reconciler.onQuote(market, price, slot, clock.mono(), clock.wall());
    },
    /** SOL priced by all three sources; JUP and JTO never priced. */
    solThree() {
      feed.live('orca', 'raydium', 'jupiter');
      feed.pool(0, 100);
      feed.pool(1, 100.2);
      feed.quote(0, 100.1);
    },
  };
  const get = async (path: string) => {
    const r = await fetch(base + path);
    const text = await r.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: r.status, body, headers: r.headers };
  };
  const clients: WebSocket[] = [];
  const ws = async (path = '/ws', options: WebSocket.ClientOptions = {}) => {
    const c = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, options);
    clients.push(c);
    const msgs: any[] = [];
    c.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => {
      c.once('open', () => resolve());
      c.once('error', reject);
    });
    const next = (pred: (m: any) => boolean, ms = 2000) => waitFor(() => msgs.find(pred), ms, 'ws message');
    return { c, msgs, next, send: (v: unknown) => c.send(typeof v === 'string' ? v : JSON.stringify(v)) };
  };
  const stop = async () => {
    for (const c of clients) c.terminate();
    await server.stopAccepting();
    await server.closeClients(1001);
    reconciler.freeze();
  };
  return { model, reconciler, gateway, server, phase, deps, logs, base, feed, get, ws, stop, latency };
}
export type Api = Awaited<ReturnType<typeof startApi>>;
