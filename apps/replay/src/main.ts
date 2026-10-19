import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createLogger } from '@soltape/service/telemetry/logger.js';
import { pino } from 'pino';
import type { MarketsFile } from '@soltape/shared';
import { coverage } from './check.js';
import { readFixture } from './fixture.js';
import { record } from './record.js';
import { ReplayServer } from './server.js';
import { buildBenchSet } from './synthetic.js';

/** Newest committed session fixture, by file name date. */
export function defaultFixture(dir = 'fixtures'): string {
  const files = readdirSync(dir)
    .filter((f) => /^session-.*\.ndjson\.gz$/.test(f))
    .sort();
  if (!files.length) throw new Error(`no fixtures/session-*.ndjson.gz found; run pnpm record`);
  return join(dir, files.at(-1)!);
}

async function main(): Promise<void> {
  const [cmd = 'serve', ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      mode: { type: 'string', default: process.env['REPLAY_MODE'] ?? 'realtime' },
      port: { type: 'string', default: process.env['REPLAY_PORT'] ?? '8899' },
      fixture: { type: 'string' },
      speed: { type: 'string', default: '1' },
      'bench-markets': { type: 'string', default: '10' },
      markets: { type: 'string', default: process.env['MARKETS_FILE'] ?? 'config/markets.json' },
      out: { type: 'string' },
      duration: { type: 'string', default: '300' },
    },
  });
  const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info', pino.destination({ sync: true }));
  if (cmd === 'serve') {
    const server = new ReplayServer({
      fixture: readFixture(values.fixture ?? defaultFixture()),
      mode: values.mode === 'rate' ? 'rate' : 'realtime',
      port: Number(values.port),
      speed: Number(values.speed),
      benchMarkets: Number(values['bench-markets']),
      logger,
    });
    await server.start();
    const stop = () => void server.stop().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } else if (cmd === 'record') {
    const date = new Date().toISOString().slice(0, 10);
    await record({
      marketsFile: values.markets,
      out: values.out ?? `fixtures/session-${date}.ndjson.gz`,
      durationMs: Number(values.duration) * 1000,
      rpcHttpUrl: process.env['RPC_HTTP_URL'] ?? 'https://api.mainnet-beta.solana.com',
      rpcWsUrl: process.env['RPC_WS_URL'] ?? 'wss://api.mainnet-beta.solana.com',
      jupiterUrl: process.env['JUPITER_URL'] ?? 'https://api.jup.ag/price/v3',
      jupiterApiKey: process.env['JUPITER_API_KEY'] || undefined,
      logger,
    });
  } else if (cmd === 'check') {
    const path = values.fixture ?? defaultFixture();
    const { missing, warnings } = coverage(JSON.parse(readFileSync(values.markets, 'utf8')) as MarketsFile, readFixture(path));
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (missing.length) {
      console.error(`${path} does not cover ${values.markets} (run pnpm record):\n  ${missing.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`${path} covers every pool and mint in ${values.markets}`);
  } else if (cmd === 'bench-markets') {
    const set = buildBenchSet(readFixture(values.fixture ?? defaultFixture()), Number(values['bench-markets']));
    writeFileSync(values.out ?? 'config/markets.bench.json', JSON.stringify(set.markets, null, 2) + '\n');
  } else {
    console.error(`unknown command ${cmd}; use serve | record | check | bench-markets`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
