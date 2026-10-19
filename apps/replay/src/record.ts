import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadNativeDecoder, referenceDecoder } from '@soltape/decoder';
import { poolAddresses } from '@soltape/service/markets/model.js';
import { PROGRAM_IDS } from '@soltape/service/ingest/validate.js';
import type { Logger } from '@soltape/service/telemetry/logger.js';
import type { MarketsFile, PoolVenue } from '@soltape/shared';
import WebSocket from 'ws';
import { FIXTURE_VERSION, writeFixture, type FixtureAccount, type FixtureFrame, type FixtureJupiter, type FixtureLine, type FixtureSlot } from './fixture.js';
import { synthesizeJupiter } from './synthetic-jupiter.js';
import { loadSdkDecode, verifyFrame } from './verify.js';

export interface RecordOptions {
  marketsFile: string;
  out: string;
  durationMs: number;
  rpcHttpUrl: string;
  rpcWsUrl: string;
  jupiterUrl: string;
  jupiterApiKey: string | undefined;
  logger: Logger;
}

const RECORDER_VERSION = '1';

/**
 * Records a mainnet session: boot accounts, every account and slot notification per venue
 * connection (raw), and Jupiter responses (or a labelled synthetic track). Every frame is
 * verified against both decoders and the venue SDK before anything is written.
 * @spec RPL-REC-001, RPL-REC-002, RPL-REC-003, RPL-REC-004
 */
export async function record(o: RecordOptions): Promise<{ frames: number; path: string }> {
  const markets = JSON.parse(readFileSync(o.marketsFile, 'utf8')) as MarketsFile;
  const log = o.logger.child({ component: 'recorder' });
  const t0 = performance.now();
  const us = () => Math.round((performance.now() - t0) * 1000);

  const pools = { orca: poolAddresses(markets, 'orca'), raydium: poolAddresses(markets, 'raydium') };
  const mints = [...new Set([markets.quote.mint, 'So11111111111111111111111111111111111111112', ...markets.markets.map((m) => m.mint)])];
  const accounts = new Map<string, FixtureAccount>();
  const fetched = await getMultiple(o.rpcHttpUrl, [...pools.orca, ...pools.raydium, ...mints]);
  for (const a of fetched) accounts.set(a.address, a);
  log.info({ accounts: accounts.size }, 'boot accounts fetched');

  const frames: FixtureFrame[] = [];
  const slots: FixtureSlot[] = [];
  const jupiter: FixtureJupiter[] = [];
  const sockets = (['orca', 'raydium'] as PoolVenue[]).map((venue) => subscribe(o.rpcWsUrl, venue, pools[venue], frames, slots, us, log));
  let jupTimer: NodeJS.Timeout | undefined;
  if (o.jupiterApiKey) {
    const ids = [...markets.markets.map((m) => m.mint), markets.quote.mint].join(',');
    const poll = async () => {
      try {
        const r = await fetch(`${o.jupiterUrl}?ids=${ids}`, { headers: { 'x-api-key': o.jupiterApiKey! } });
        if (r.ok) jupiter.push({ kind: 'jupiter', t: us(), body: await r.text() });
      } catch {
        /* recorded as a gap */
      }
      jupTimer = setTimeout(() => void poll(), 2000);
    };
    void poll();
  }
  await new Promise((r) => setTimeout(r, o.durationMs));
  clearTimeout(jupTimer);
  for (const s of await Promise.all(sockets)) s.terminate();
  log.info({ frames: frames.length, slots: slots.length, jupiter: jupiter.length }, 'recording finished; verifying');

  const native = loadNativeDecoder();
  const sdk = await loadSdkDecode();
  for (const f of frames) {
    const problem = verifyFrame(f.body, f.venue, Buffer.from(f.data, 'base64'), native, referenceDecoder, sdk);
    if (problem) throw new Error(`frame for ${f.address} at slot ${f.slot} failed verification: ${problem}; fixture not written`);
  }
  const header = {
    kind: 'header' as const,
    version: FIXTURE_VERSION,
    recordedAt: new Date().toISOString(),
    durationMs: o.durationMs,
    recorderVersion: RECORDER_VERSION,
    commit: gitCommit(),
    programIds: PROGRAM_IDS,
    markets,
    synthetic: { jupiter: !o.jupiterApiKey },
  };
  const jupTrack = o.jupiterApiKey ? jupiter : synthesizeJupiter(header, accounts, frames, native);
  const lines: FixtureLine[] = [header, ...accounts.values(), ...frames, ...slots, ...jupTrack];
  await writeFixture(o.out, lines);
  log.info({ path: o.out, frames: frames.length, syntheticJupiter: !o.jupiterApiKey }, 'fixture written');
  return { frames: frames.length, path: o.out };
}

async function getMultiple(url: string, keys: string[]): Promise<FixtureAccount[]> {
  const out: FixtureAccount[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const r = (await (
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch, { encoding: 'base64', commitment: 'processed' }] }),
      })
    ).json()) as {
      result: { context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] };
    };
    r.result.value.forEach((v, j) => {
      if (v) out.push({ kind: 'account', address: batch[j]!, owner: v.owner, data: v.data[0], slot: r.result.context.slot });
    });
  }
  return out;
}

function subscribe(url: string, venue: PoolVenue, addresses: string[], frames: FixtureFrame[], slots: FixtureSlot[], us: () => number, log: Logger): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const reqAddr = new Map<number, string>();
    const subAddr = new Map<number, string>();
    let slotSub: number | null = null;
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }));
      addresses.forEach((a, i) => {
        reqAddr.set(i + 2, a);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'accountSubscribe', params: [a, { encoding: 'base64', commitment: 'processed' }] }));
      });
      resolve(ws);
    });
    ws.on('error', reject);
    ws.on('message', (raw: Buffer) => {
      const t = us();
      const body = raw.toString('utf8');
      const m = JSON.parse(body) as {
        id?: number;
        result?: number;
        method?: string;
        params?: {
          subscription: number;
          result: { slot?: number; context?: { slot: number }; value?: { data: [string, string]; lamports: number; owner: string; space: number } };
        };
      };
      if (m.id !== undefined) {
        if (m.id === 1 && typeof m.result === 'number') slotSub = m.result;
        else if (typeof m.result === 'number' && reqAddr.has(m.id)) subAddr.set(m.result, reqAddr.get(m.id)!);
        return;
      }
      if (m.method === 'slotNotification' && m.params?.subscription === slotSub && m.params.result.slot !== undefined) {
        slots.push({ kind: 'slot', t, venue, slot: m.params.result.slot });
      } else if (m.method === 'accountNotification' && m.params) {
        const address = subAddr.get(m.params.subscription);
        const v = m.params.result.value;
        if (!address || !v || !m.params.result.context) return;
        frames.push({ kind: 'frame', t, venue, address, slot: m.params.result.context.slot, data: v.data[0], lamports: v.lamports, owner: v.owner, space: v.space, body });
        if (frames.length % 50 === 0) log.info({ frames: frames.length }, 'recording');
      }
    });
  });
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
