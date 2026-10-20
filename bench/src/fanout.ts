import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsGateway, type GatewayOptions } from '@soltape/service/api/gateway.js';
import { buildSkeleton } from '@soltape/service/markets/model.js';
import type { Consolidated } from '@soltape/service/reconcile/types.js';
import { silentLogger } from '@soltape/service/telemetry/logger.js';
import { systemClock, type MarketsFile } from '@soltape/shared';
import { WebSocketServer } from 'ws';
import { appendSummary } from './report.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fan-out microbenchmark for the optimization loop. Each variant is a separate gateway with
 * `subs` real subscriber sockets in its own client process. Variants run in interleaved
 * blocks so they share machine conditions; each block publishes `burst` updates in one
 * event-loop turn, then lets deferred work (uncork) run. Cost = this process's CPU time per
 * update, which includes deferred writes; delivery is verified from the clients' counts.
 * Usage: node bench/dist/fanout.js [subs=100] [blocks=400] [burst=1]
 */
async function main(): Promise<void> {
  const subs = Number(process.argv[2] ?? 100);
  const blocks = Number(process.argv[3] ?? 400);
  const burst = Number(process.argv[4] ?? 1);
  const sk = buildSkeleton(JSON.parse(readFileSync(join(root, 'config/markets.json'), 'utf8')) as MarketsFile);
  if (!sk.ok) throw new Error(sk.errors.join());
  const model = sk.value;
  const c: Consolidated = {
    mint: model.markets[0]!.mint,
    symbol: 'SOL',
    quote: 'USDC',
    price: 104.123456,
    sources: ['orca:x', 'raydium:y'],
    excluded: [{ source: 'jupiter', reason: 'source_disabled' }],
    spreadBps: 0.7,
    degraded: false,
    disagreement: false,
    slot: 458_000_000,
    updatedAt: new Date().toISOString(),
    seq: 1,
    trigger: { source: 'orca:x', slot: 458_000_000 },
  };
  const variants: { name: string; options: Partial<GatewayOptions> }[] = [
    { name: 'A ws.send per client', options: { preframe: false, corkPerTick: false } },
    { name: "A' (A/A noise floor)", options: { preframe: false, corkPerTick: false } },
    { name: 'B frame once', options: { preframe: true, corkPerTick: false } },
    { name: 'C frame once + cork/turn', options: { preframe: true, corkPerTick: true } },
  ];
  const setups = await Promise.all(
    variants.map(async (v) => {
      const g = new WsGateway({ model, source: { consolidated: () => c, available: () => true }, clock: systemClock, logger: silentLogger, options: v.options });
      const http = createServer();
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      http.on('upgrade', (req, s, h) => wss.handleUpgrade(req, s, h, (ws) => g.accept(ws)));
      await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
      const child = fork(join(root, 'bench/dist/client.js'), [`ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`, String(subs), '0'], { serialization: 'advanced' });
      await new Promise<void>((r) => child.on('message', (m: { type: string }) => m.type === 'ready' && r()));
      return { v, g, http, child, cpuUs: 0, updates: 0 };
    }),
  );
  await sleep(300);
  for (let b = 0; b < blocks; b++) {
    for (const s of b % 2 === 0 ? setups : [...setups].reverse()) {
      const t = process.cpuUsage();
      for (let k = 0; k < burst; k++) {
        c.seq++;
        s.g.onConsolidated(0, c, { recvTs: null, decodedTs: null, reconciledTs: 0 });
      }
      await tick(); // deferred uncork runs inside the measured window
      const d = process.cpuUsage(t);
      s.cpuUs += d.user + d.system;
      s.updates += burst;
      await sleep(burst); // drain, outside the measured window
    }
  }
  console.log(`fan-out to ${subs} subscribers, ${blocks} blocks of ${burst} update(s) per variant (CPU time of the publishing process)`);
  const lines: string[] = [];
  for (const s of setups) {
    s.child.send({ type: 'stop' });
    const got = await new Promise<number>((r) => s.child.on('message', (m: { type: string; consumed?: number }) => m.type === 'result' && r(m.consumed ?? -1)));
    const perUpdate = s.cpuUs / s.updates;
    lines.push(`| ${s.v.name} | ${perUpdate.toFixed(0)} | ${(perUpdate / subs).toFixed(2)} | ${got - subs - 5 * subs}/${s.updates * subs} |`);
    s.child.kill();
    s.http.close();
  }
  const md = `### Fan-out CPU, ${subs} subscribers, ${burst} update(s) per event-loop turn\n\n| Variant | µs CPU / update | µs / send | delivered |\n|---|---:|---:|---:|\n${lines.join('\n')}\n`;
  console.log(md);
  if (process.argv.includes('--summary')) appendSummary(md);
  process.exit(0);
}

void main();
