import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNativeDecoder, referenceDecoder, type FrameDecoder } from '@soltape/decoder';
import { silentLogger } from '@soltape/service/telemetry/logger.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { coverage, fixtureCoverage } from '../../src/check.js';
import { readFixture, writeFixture, type FixtureLine } from '../../src/fixture.js';
import { record } from '../../src/record.js';
import { ReplayServer } from '../../src/server.js';
import { buildBenchSet, perturbSqrt, syntheticKey } from '../../src/synthetic.js';
import { synthesizeJupiter } from '../../src/synthetic-jupiter.js';
import { loadSdkDecode, verifyFrame } from '../../src/verify.js';
import { FakeRpc, waitFor } from '../../../service/test/support/fake-rpc.js';
import { recordingLogger } from '../../../service/test/support/ingest.js';
import { markets, smallFixture } from '../support/fixture.js';

const native = loadNativeDecoder();
const servers: ReplayServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await s.stop();
});

async function serve(o: Partial<ConstructorParameters<typeof ReplayServer>[0]> = {}) {
  const logs: { level: string; obj: object; msg?: string }[] = [];
  const s = new ReplayServer({ fixture: smallFixture(), mode: 'realtime', port: 0, host: '127.0.0.1', logger: recordingLogger(logs), ...o });
  servers.push(s);
  await s.start();
  return { s, logs, base: `http://127.0.0.1:${s.port}` };
}

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const msgs: any[] = [];
  ws.on('message', (d) => msgs.push(String(d)));
  await new Promise((r) => ws.once('open', r));
  let id = 1;
  const call = async (method: string, params?: unknown[]) => {
    const myId = id++;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, ...(params ? { params } : {}) }));
    return waitFor(() => msgs.map((m) => JSON.parse(m)).find((m) => m.id === myId));
  };
  return {
    ws,
    msgs,
    call,
    parsed: () =>
      msgs.flatMap((m) => {
        try {
          return [JSON.parse(m)];
        } catch {
          return [{ raw: m }];
        }
      }),
  };
}

const rpc = (base: string, method: string, params: unknown[]) =>
  fetch(base, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json() as Promise<any>);
const control = (base: string, body: unknown) => fetch(`${base}/control`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const ORCA_SOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const RAY_SOL = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';

describe('fixture format', () => {
  // @spec RPL-REC-003
  it('round-trips gzipped NDJSON with the header first', async () => {
    const fx = smallFixture();
    const path = join(mkdtempSync(join(tmpdir(), 'soltape-')), 'f.ndjson.gz');
    await writeFixture(path, [fx.header, ...fx.accounts.values(), ...fx.frames, ...fx.slots, ...fx.jupiter] as FixtureLine[]);
    const back = readFixture(path);
    expect(back.header).toEqual(fx.header);
    expect(back.frames).toHaveLength(fx.frames.length);
    expect(back.accounts.size).toBe(fx.accounts.size);
  });

  // @spec RPL-REC-005
  it('reports pools and mints the fixture cannot replay', () => {
    const fx = smallFixture();
    expect(fixtureCoverage(markets, fx)).toEqual([]);
    fx.frames = fx.frames.filter((f) => f.address !== ORCA_SOL);
    fx.accounts.delete(RAY_SOL);
    fx.accounts.delete('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL');
    expect(fixtureCoverage(markets, fx)).toEqual([`${RAY_SOL}: no boot snapshot`, 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: no mint account']);
    expect(coverage(markets, fx).warnings).toEqual([expect.stringContaining(`${ORCA_SOL}: no account frame`)]);
  });
});

describe('recorder', () => {
  // @spec RPL-REC-004
  it('verifies frames against both decoders and the venue SDK, and reports disagreement', async () => {
    const sdk = await loadSdkDecode();
    const f = smallFixture().frames[0]!;
    const data = Buffer.from(f.data, 'base64');
    expect(verifyFrame(f.body, f.venue, data, native, referenceDecoder, sdk)).toBeNull();
    expect(verifyFrame(f.body, f.venue, data, native, referenceDecoder, (v, d) => ({ ...sdk(v, d), tick: 1 }))).toMatch(/tick/);
    const liar: FrameDecoder = { ...referenceDecoder, decodeNotification: (fr, out) => (referenceDecoder.decodeNotification(fr, out), (out[4] = 1), 1) };
    expect(verifyFrame(f.body, f.venue, data, native, liar, sdk)).toMatch(/slot 4/);
  });

  // @spec RPL-REC-002
  it('synthesises a Jupiter track from on-chain prices when no key is available', () => {
    const fx = smallFixture();
    const track = synthesizeJupiter(fx.header, fx.accounts, fx.frames, native, { random: () => 0.5 });
    expect(track.length).toBeGreaterThan(0);
    const body = JSON.parse(track.at(-1)!.body);
    const sol = body['So11111111111111111111111111111111111111112'].usdPrice / body['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].usdPrice;
    expect(sol).toBeGreaterThan(80);
    expect(sol).toBeLessThan(150);
    expect(Object.keys(body)).toHaveLength(6);
  });

  // @spec RPL-REC-001, RPL-REC-002
  it('records boot accounts, frames and slots from a node, verifies them and writes a labelled fixture', async () => {
    const node = await FakeRpc.start();
    try {
      const fx = smallFixture();
      for (const a of fx.accounts.values()) node.setAccount(a.address, a.owner, a.data);
      const dir = mkdtempSync(join(tmpdir(), 'soltape-'));
      const marketsFile = join(dir, 'markets.json');
      writeFileSync(marketsFile, JSON.stringify(markets));
      const out = join(dir, 'session.ndjson.gz');
      const pushing = setInterval(() => {
        node.pushSlot();
        node.pushAccount(ORCA_SOL);
        node.pushAccount(RAY_SOL);
      }, 40);
      await record({ marketsFile, out, durationMs: 500, rpcHttpUrl: node.httpUrl, rpcWsUrl: node.wsUrl, jupiterUrl: '', jupiterApiKey: undefined, logger: silentLogger });
      clearInterval(pushing);
      const back = readFixture(out);
      expect(back.header.synthetic.jupiter).toBe(true);
      expect(back.accounts.size).toBe(16);
      expect(back.frames.length).toBeGreaterThan(4);
      expect(new Set(back.frames.map((f) => f.venue))).toEqual(new Set(['orca', 'raydium']));
      expect(back.frames.every((f) => f.t >= 0 && f.body.includes('accountNotification'))).toBe(true);
      expect(back.slots.length).toBeGreaterThan(0);
      expect(back.jupiter.length).toBeGreaterThan(0);
    } finally {
      await node.close();
    }
  });
});

describe('replay server: protocol', () => {
  // @spec RPL-SRV-001
  it('implements slot and account subscriptions with Solana message shapes', async () => {
    const { s } = await serve({ speed: 4 });
    const c = await client(s.port);
    expect((await c.call('slotSubscribe')).result).toBe(1);
    const sub = (await c.call('accountSubscribe', [ORCA_SOL, { encoding: 'base64', commitment: 'processed' }])).result;
    expect(sub).toBeGreaterThanOrEqual(1000);
    const note = await waitFor(() => c.parsed().find((m) => m.method === 'accountNotification'), 3000);
    expect(note.params.subscription).toBe(sub);
    expect(note.params.result.value.data[1]).toBe('base64');
    expect(await waitFor(() => c.parsed().find((m) => m.method === 'slotNotification'))).toBeTruthy();
    expect((await c.call('accountUnsubscribe', [sub])).result).toBe(true);
  });

  // @spec RPL-SRV-002
  it('serves the Jupiter v3 shape and requires an API key', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/price/v3?ids=x`)).status).toBe(401);
    const r = await fetch(`${base}/price/v3?ids=x`, { headers: { 'x-api-key': 'k' } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body['So11111111111111111111111111111111111111112'].usdPrice).toBe(104);
  });

  // @spec RPL-SRV-003, RPL-SRV-004
  it('answers getMultipleAccounts with the latest replayed state and null (logged) for unknown accounts', async () => {
    const { base, logs } = await serve();
    const r = await rpc(base, 'getMultipleAccounts', [[ORCA_SOL, '11111111111111111111111111111112'], { encoding: 'base64' }]);
    expect(r.result.value[0].owner).toBe('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    expect(r.result.value[1]).toBeNull();
    expect(typeof r.result.context.slot).toBe('number');
    expect(logs.some((l) => l.level === 'error' && /run pnpm record/.test(l.msg ?? ''))).toBe(true);
  });

  // @spec RPL-SRV-005
  it('plays at the recorded timing scaled by speed, and loops with increasing slots', async () => {
    const fx = smallFixture(1, 200);
    const { s } = await serve({ fixture: fx, speed: 2 });
    const c = await client(s.port);
    await c.call('accountSubscribe', [ORCA_SOL]);
    await waitFor(() => s.stats.loops >= 2, 3000);
    const slots = c
      .parsed()
      .filter((m) => m.method === 'accountNotification')
      .map((m) => m.params.result.context.slot);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
  });
});

describe('replay server: rate mode', () => {
  // @spec RPL-SRV-007
  it('clones pools under synthetic pool and mint addresses with perturbed prices', () => {
    const set = buildBenchSet(smallFixture(), 3);
    expect(set.markets.markets).toHaveLength(3);
    expect(new Set(set.markets.markets.map((m) => m.mint)).size).toBe(3);
    const p = set.pools[0]!;
    const info = native.decodeAccount(p.data, p.venue).info!;
    expect(info.mintA).toBe(syntheticKey('mint', 0));
    expect(info.mintB).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(set.accounts.get(syntheticKey('mint', 0))!.data[44]).toBe(9);
    const moved = native.decodeAccount(perturbSqrt(p.data, p.venue, 1e-5), p.venue).info!;
    expect(moved.sqrtRatio).not.toBe(info.sqrtRatio);
  });

  // @spec RPL-SRV-006, RPL-SRV-009, RPL-SRV-010
  it('emits on an open-loop schedule with unique increasing slots and logs intended send times', async () => {
    const { s, base } = await serve({ mode: 'rate', benchMarkets: 2 });
    const c = await client(s.port);
    await c.call('slotSubscribe');
    for (const p of s.bench!.pools) await c.call('accountSubscribe', [p.address]);
    const run = s.startRate(2000, 300);
    await run.done;
    expect(run.sent).toBe(600);
    const notes = await waitFor(() => {
      const n = c.parsed().filter((m) => m.method === 'accountNotification');
      return n.length >= 600 ? n : null;
    }, 3000);
    const slots = notes.map((n) => n.params.result.context.slot);
    expect(new Set(slots).size).toBe(600);
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
    expect(run.intendedNs[1]! - run.intendedNs[0]!).toBeCloseTo(500_000, 0);
    // Consecutive updates of one pool carry different prices.
    const pool0 = notes
      .filter((n) => n.params.subscription === notes[0].params.subscription)
      .slice(0, 2)
      .map((n) => n.params.result.value.data[0]);
    expect(pool0[0]).not.toBe(pool0[1]);
    const log = await fetch(`${base}/control/sendlog`);
    expect(log.headers.get('x-count')).toBe('600');
    expect((await log.arrayBuffer()).byteLength).toBe(600 * 16);
  });

  // @spec RPL-SRV-008
  it('refuses to run when its own emit capacity is below 3x the target rate', async () => {
    const { s, base } = await serve({ mode: 'rate', benchMarkets: 1 });
    expect(s.measureEmitCapacity(100)).toBeGreaterThan(10_000);
    expect(() => s.startRate(1e10, 100)).toThrow(/refusing to run/);
    expect((await control(base, { op: 'rate', rate: 1e10, durationMs: 100 })).error).toMatch(/refusing/);
  });
});

describe('fault injection', () => {
  async function subscribed() {
    const r = await serve({ speed: 8 });
    const c = await client(r.s.port);
    await c.call('slotSubscribe');
    await c.call('accountSubscribe', [ORCA_SOL]);
    return { ...r, c };
  }

  // @spec RPL-FLT-001, RPL-FLT-006
  it('drop closes a venue’s connections and refuses its subscriptions until restore', async () => {
    const { base, s, c } = await subscribed();
    const closed = new Promise((r) => c.ws.once('close', r));
    await control(base, { op: 'drop', venue: 'orca' });
    await closed;
    const c2 = await client(s.port);
    const closed2 = new Promise((r) => c2.ws.once('close', r));
    c2.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'accountSubscribe', params: [ORCA_SOL] }));
    await closed2;
    await control(base, { op: 'restore', venue: 'orca' });
    const c3 = await client(s.port);
    expect((await c3.call('accountSubscribe', [ORCA_SOL])).result).toBeGreaterThan(0);
  });

  // @spec RPL-FLT-002
  it('stall keeps the connection open but silent', async () => {
    const { base, c } = await subscribed();
    await waitFor(() => c.msgs.length > 3, 3000);
    await control(base, { op: 'stall', venue: 'orca' });
    await new Promise((r) => setTimeout(r, 30));
    const n = c.msgs.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(c.msgs.length).toBe(n);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  // @spec RPL-FLT-003
  it('stall_accounts silences one account while slots keep flowing', async () => {
    const { base, c } = await subscribed();
    await control(base, { op: 'stall_accounts', address: ORCA_SOL });
    const before = c.parsed().length;
    await new Promise((r) => setTimeout(r, 400));
    const after = c.parsed().slice(before);
    expect(after.some((m) => m.method === 'slotNotification')).toBe(true);
    expect(after.some((m) => m.method === 'accountNotification')).toBe(false);
  });

  // @spec RPL-FLT-004
  it('garbage replaces a fraction of frames with malformed variants', async () => {
    const { base, c } = await subscribed();
    await control(base, { op: 'garbage', venue: 'orca', rate: 1 });
    const before = c.msgs.length;
    await waitFor(() => c.msgs.length > before + 2, 3000);
    const after = c.msgs.slice(before).filter((m) => !m.includes('slotNotification'));
    const out = new Float64Array(8);
    expect(after.every((m) => native.decodeNotification(Buffer.from(m), out) !== 1)).toBe(true);
  });

  // @spec RPL-FLT-005
  it('jupiter faults return the injected status or delay', async () => {
    const { base } = await serve();
    await control(base, { op: 'jupiter', status: 429 });
    expect((await fetch(`${base}/price/v3`, { headers: { 'x-api-key': 'k' } })).status).toBe(429);
    await control(base, { op: 'jupiter', delayMs: 150 });
    const t0 = performance.now();
    await fetch(`${base}/price/v3`, { headers: { 'x-api-key': 'k' } });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
    await control(base, { op: 'restore', venue: '*' });
    expect(((await (await fetch(`${base}/control/status`)).json()) as any).faults.jupiter).toEqual({});
  });
});
