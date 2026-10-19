import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFixture } from '@soltape/replay/fixture.js';
import { defaultFixture } from '@soltape/replay/main.js';
import { buildBenchSet } from '@soltape/replay/synthetic.js';
import { joinLatencies, parseSendLog, promValue, type CellResult, type SocketReceipts } from './analysis.js';
import { appendSummary, machineSpec, renderMarkdown } from './report.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BenchOptions {
  rates: number[];
  subscribers: number[];
  warmupS: number;
  durationS: number;
  clients: number;
  benchMarkets: number;
  summary: boolean;
  outDir: string;
  replayPort: number;
  servicePort: number;
}

/**
 * Runs the benchmark matrix: replay server (rate mode), the service (production build) and
 * multiple load-client processes, all as separate processes on one host.
 * @spec RPL-BEN-001, RPL-BEN-005, RPL-BEN-006, RPL-BEN-008, RPL-BEN-009, RPL-BEN-010
 */
export async function runBench(o: BenchOptions): Promise<{ cells: CellResult[]; markdown: string; jsonPath: string; mdPath: string }> {
  const spec = machineSpec();
  if (process.platform !== 'linux') console.warn(`warning: ${spec.label}`);
  const fixturePath = defaultFixture(join(root, 'fixtures'));
  const set = buildBenchSet(readFixture(fixturePath), o.benchMarkets);
  const tmp = mkdtempSync(join(tmpdir(), 'soltape-bench-'));
  const marketsFile = join(tmp, 'markets.bench.json');
  writeFileSync(marketsFile, JSON.stringify(set.markets));
  const replayUrl = `http://127.0.0.1:${o.replayPort}`;
  const serviceUrl = `http://127.0.0.1:${o.servicePort}`;
  const children: ChildProcess[] = [];
  const kill = () => children.forEach((c) => c.kill('SIGTERM'));
  process.once('exit', kill);

  const replay = spawn(
    process.execPath,
    [join(root, 'apps/replay/dist/main.js'), 'serve', '--mode', 'rate', '--port', String(o.replayPort), '--bench-markets', String(o.benchMarkets), '--fixture', fixturePath],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, LOG_LEVEL: 'warn' },
    },
  );
  children.push(replay);
  await waitHttp(`${replayUrl}/control/status`);
  const service = spawn(process.execPath, [join(root, 'apps/service/dist/main.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: String(o.servicePort),
      MARKETS_FILE: marketsFile,
      RPC_HTTP_URL: replayUrl,
      RPC_WS_URL: `ws://127.0.0.1:${o.replayPort}`,
      JUPITER_API_KEY: '',
    },
  });
  children.push(service);
  await waitFor(async () => {
    const h = (await (await fetch(`${serviceUrl}/health`)).json()) as { markets: { available: number } };
    return h.markets.available === o.benchMarkets;
  }, 60_000);
  const health = (await (await fetch(`${serviceUrl}/health`)).json()) as { dependencies: { redis: string; postgres: string } };
  const persistence = `redis ${health.dependencies.redis}, postgres ${health.dependencies.postgres}`;

  const cells: CellResult[] = [];
  try {
    for (const subscribers of o.subscribers) {
      for (const rate of o.rates) {
        const cell = await runCell(rate, subscribers);
        cells.push(cell);
        console.log(
          `rate ${rate}/s subs ${subscribers}: e2e p50 ${cell.e2e.p50}µs p99 ${cell.e2e.p99}µs p99.9 ${cell.e2e.p999}µs | internal p99 ${cell.internal.p99}µs | loop p99 ${cell.eventLoopP99Ms.toFixed(2)}ms | conflated ${(cell.e2e.conflationRatio * 100).toFixed(2)}%`,
        );
      }
    }
  } finally {
    kill();
  }

  const markdown = renderMarkdown(cells, spec, { durationS: o.durationS, warmupS: o.warmupS, benchMarkets: o.benchMarkets });
  mkdirSync(o.outDir, { recursive: true });
  const stem = join(o.outDir, `${spec.host}-${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(`${stem}.json`, JSON.stringify({ machine: spec, options: o, cells }, null, 2));
  writeFileSync(`${stem}.md`, markdown);
  if (o.summary) appendSummary(markdown);
  return { cells, markdown, jsonPath: `${stem}.json`, mdPath: `${stem}.md` };

  async function runCell(rate: number, subscribers: number): Promise<CellResult> {
    const perClient = splitEvenly(subscribers, Math.min(o.clients, subscribers));
    const clients = perClient.map((n) =>
      fork(join(root, 'bench/dist/client.js'), [`ws://127.0.0.1:${o.servicePort}/ws`, String(n), '4'], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      }),
    );
    children.push(...clients);
    await Promise.all(clients.map((c) => once(c, 'ready')));
    await sleep(300);
    const before = await (await fetch(`${serviceUrl}/metrics`)).text();
    for (const c of clients) c.send({ type: 'record' });
    const start = await fetch(`${replayUrl}/control`, { method: 'POST', body: JSON.stringify({ op: 'rate', rate, durationMs: o.durationS * 1000, warmupMs: o.warmupS * 1000 }) });
    if (start.status !== 202) throw new Error(`replay refused the run: ${await start.text()}`);
    await waitFor(
      async () => !((await (await fetch(`${replayUrl}/control/status`)).json()) as { rate: { running: boolean } }).rate.running,
      (o.warmupS + o.durationS) * 1000 + 30_000,
    );
    await sleep(500);
    // Clients buried under a backlog may never report; a cell that cannot be measured in time
    // is recorded as collapsed instead of wedging the run.
    let collectTimer: NodeJS.Timeout | undefined;
    const results = await Promise.race([
      Promise.all(
        clients.map((c) => {
          const r = once<{ sockets: SocketReceipts[] }>(c, 'result');
          c.send({ type: 'stop' });
          return r;
        }),
      ),
      new Promise<null>((r) => (collectTimer = setTimeout(() => r(null), COLLECT_TIMEOUT_MS))),
    ]);
    clearTimeout(collectTimer);
    if (results === null) for (const c of clients) c.kill('SIGKILL');
    const after = await (await fetch(`${serviceUrl}/metrics`)).text();
    const stats = (await (await fetch(`${serviceUrl}/stats`)).json()) as { latencyUs: { p50: number; p99: number; p999: number } };
    const logRes = await fetch(`${replayUrl}/control/sendlog`);
    const log = parseSendLog(await logRes.arrayBuffer(), logRes.headers);
    const e2e =
      results === null
        ? collapsed(log)
        : joinLatencies(
            log,
            results.flatMap((r) => r.sockets),
          );
    return {
      rate,
      subscribers,
      e2e,
      internal: stats.latencyUs,
      eventLoopP99Ms: promValue(after, 'soltape_eventloop_delay_p99_seconds') * 1000,
      rssMb: promValue(after, 'process_resident_memory_bytes') / 2 ** 20,
      gcPauseMs: (promValue(after, 'nodejs_gc_duration_seconds_sum') - promValue(before, 'nodejs_gc_duration_seconds_sum')) * 1000,
      persistDrops: (promValue(after, 'soltape_persist_dropped_total') || 0) - (promValue(before, 'soltape_persist_dropped_total') || 0),
      persistence,
    };
  }
}

const COLLECT_TIMEOUT_MS = 60_000;

/** A cell whose clients could not report: every measured input counts as not delivered. */
function collapsed(log: { intendedNs: Float64Array; warmupMs: number }) {
  const measured = Array.from(log.intendedNs).filter((t) => t >= log.warmupMs * 1e6).length;
  return {
    p50: Number.POSITIVE_INFINITY,
    p99: Number.POSITIVE_INFINITY,
    p999: Number.POSITIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    samples: 0,
    conflationRatio: 1,
    measuredInputs: measured,
  };
}

function splitEvenly(n: number, k: number): number[] {
  return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
}

function once<T = unknown>(c: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (m: { type: string }) => {
      if (m.type !== type) return;
      c.off('message', onMsg);
      resolve(m as T);
    };
    c.on('message', onMsg);
    c.once('exit', (code) => code !== 0 && reject(new Error(`client exited with ${code}`)));
  });
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => (await fetch(url)).ok, timeoutMs);
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      rates: { type: 'string', default: '1000,5000,10000,20000,50000' },
      subscribers: { type: 'string', default: '1,100,1000' },
      warmup: { type: 'string', default: '10' },
      duration: { type: 'string', default: '30' },
      clients: { type: 'string', default: '4' },
      'bench-markets': { type: 'string', default: '10' },
      summary: { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      out: { type: 'string', default: join(root, 'bench/results') },
    },
  });
  const quick = values.quick;
  runBench({
    rates: (quick ? '1000,10000' : values.rates).split(',').map(Number),
    subscribers: (quick ? '1,100' : values.subscribers).split(',').map(Number),
    warmupS: quick ? 3 : Number(values.warmup),
    durationS: quick ? 10 : Number(values.duration),
    clients: Number(values.clients),
    benchMarkets: Number(values['bench-markets']),
    summary: values.summary,
    outDir: values.out,
    replayPort: 18899,
    servicePort: 18080,
  })
    .then((r) => {
      console.log(`\n${r.markdown}\nwrote ${r.jsonPath} and ${r.mdPath}`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
