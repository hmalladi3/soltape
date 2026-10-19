import { readFileSync } from 'node:fs';
import { loadNativeDecoder, type FrameDecoder } from '@soltape/decoder';
import type { Clock, MarketsFile } from '@soltape/shared';
import { buildSkeleton, type MarketModel } from '../../src/markets/model.js';
import { RpcHttpClient } from '../../src/ingest/rpc-http.js';
import { RpcVenueAdapter, type RpcAdapterOptions } from '../../src/ingest/rpc-adapter.js';
import type { Logger } from '../../src/telemetry/logger.js';
import { FakeRpc } from './fake-rpc.js';
import { RecordingSink } from './sink.js';

interface AccountFixture {
  address: string;
  owner: string;
  data: string;
}
const fx = JSON.parse(readFileSync(new URL('../../../../packages/decoder/fixtures/accounts.json', import.meta.url), 'utf8')) as {
  pools: AccountFixture[];
  mints: AccountFixture[];
};
export const fixtureAccount = (address: string): AccountFixture => [...fx.pools, ...fx.mints].find((a) => a.address === address)!;
export const decoder: FrameDecoder = loadNativeDecoder();

export const ADDR = {
  ORCA_SOL_USDC: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
  ORCA_JUP_SOL: 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz',
  RAY_SOL_USDC: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};
export const RAYDIUM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export const testMarkets = (): MarketsFile => ({
  quote: { symbol: 'USDC', mint: ADDR.USDC },
  markets: [
    { symbol: 'SOL', mint: ADDR.SOL, venues: { orca: { pool: ADDR.ORCA_SOL_USDC }, raydium: { pool: ADDR.RAY_SOL_USDC }, jupiter: {} } },
    { symbol: 'JUP', mint: ADDR.JUP, venues: { orca: { route: [ADDR.ORCA_JUP_SOL, ADDR.ORCA_SOL_USDC] }, jupiter: {} } },
  ],
});

/** Loads every fixture account the test markets need into the fake RPC. */
export function seed(rpc: FakeRpc): void {
  for (const a of [ADDR.ORCA_SOL_USDC, ADDR.ORCA_JUP_SOL, ADDR.RAY_SOL_USDC, ADDR.SOL, ADDR.USDC, ADDR.JUP]) {
    const f = fixtureAccount(a);
    rpc.setAccount(a, f.owner, f.data);
  }
}

export const FAST: Partial<RpcAdapterOptions> = {
  pingIntervalMs: 1000,
  pongTimeoutMs: 1000,
  subscribeTimeoutMs: 60,
  subscribeRetries: 3,
  backgroundResubscribeMs: 150,
  revalidateAfterMs: 10_000,
  checkIntervalMs: 20,
  staleReconnectMs: 100,
  backoffBaseMs: 5,
  backoffCapMs: 20,
  backoffResetMs: 60_000,
};

export interface Harness {
  rpc: FakeRpc;
  sink: RecordingSink;
  model: MarketModel;
  markets: MarketsFile;
  adapter: RpcVenueAdapter;
  logs: { level: string; obj: object; msg?: string }[];
}

export function recordingLogger(logs: Harness['logs']): Logger {
  const mk = (level: string) => (obj: object, msg?: string) => void logs.push(msg === undefined ? { level, obj } : { level, obj, msg });
  const l: Logger = { fatal: mk('fatal'), error: mk('error'), warn: mk('warn'), info: mk('info'), debug: mk('debug'), child: () => l };
  return l;
}

export function makeAdapter(
  rpc: FakeRpc,
  opts: {
    venue?: 'orca' | 'raydium';
    options?: Partial<RpcAdapterOptions>;
    markets?: MarketsFile;
    clock?: Clock;
    decoder?: FrameDecoder;
    random?: () => number;
    sink?: RecordingSink;
    model?: MarketModel;
  } = {},
): Harness {
  const markets = opts.markets ?? testMarkets();
  const sk = buildSkeleton(markets);
  if (!sk.ok) throw new Error(sk.errors.join('\n'));
  const model = opts.model ?? sk.value;
  const sink = opts.sink ?? new RecordingSink();
  const logs: Harness['logs'] = [];
  const clock = opts.clock ?? { mono: () => performance.now(), wall: () => Date.now() };
  const adapter = new RpcVenueAdapter({
    venue: opts.venue ?? 'orca',
    model,
    markets,
    sink,
    registry: sink,
    decoder: opts.decoder ?? decoder,
    rpcHttp: new RpcHttpClient({ url: rpc.httpUrl, commitment: 'processed', timeoutMs: 1000, clock }),
    wsUrl: rpc.wsUrl,
    commitment: 'processed',
    clock,
    logger: recordingLogger(logs),
    options: { ...FAST, ...opts.options },
    ...(opts.random ? { random: opts.random } : {}),
  });
  return { rpc, sink, model, markets, adapter, logs };
}
