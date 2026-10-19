import { Status, type FrameDecoder } from '@soltape/decoder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullJitter, retryAfterMs } from '../../../src/ingest/backoff.js';
import { PoolValidationError } from '../../../src/ingest/rpc-adapter.js';
import { FakeRpc, sleep, waitFor } from '../../support/fake-rpc.js';
import { ADDR, RAYDIUM_PROGRAM, decoder, makeAdapter, seed, testMarkets, type Harness } from '../../support/ingest.js';

let rpc: FakeRpc;
const harnesses: Harness[] = [];
const make = (...args: Parameters<typeof makeAdapter> extends [unknown, ...infer R] ? R : never) => {
  const h = makeAdapter(rpc, ...args);
  harnesses.push(h);
  return h;
};

beforeEach(async () => {
  rpc = await FakeRpc.start();
  seed(rpc);
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.adapter.stop();
  await rpc.close();
});

const live = (h: Harness) => waitFor(() => h.sink.states().at(-1) === 'live', 3000, 'live');
const poolIdx = (h: Harness, address: string) => h.model.poolIndexByAddress.get(address)!;

describe('boot validation', () => {
  // @spec ING-RPC-001, ING-RPC-003
  it('fetches pools, then Whirlpool mint decimals, with base64 and the configured commitment', async () => {
    const h = make();
    await h.adapter.start();
    const http = rpc.requests.filter((r) => r.transport === 'http');
    expect(http[0]!.method).toBe('getMultipleAccounts');
    expect(http[0]!.params).toEqual([[ADDR.ORCA_SOL_USDC, ADDR.ORCA_JUP_SOL], { encoding: 'base64', commitment: 'processed' }]);
    expect(new Set((http[1]!.params as [string[]])[0])).toEqual(new Set([ADDR.SOL, ADDR.USDC, ADDR.JUP]));
    const sol = h.model.pools[poolIdx(h, ADDR.ORCA_SOL_USDC)]!;
    const jup = h.model.pools[poolIdx(h, ADDR.ORCA_JUP_SOL)]!;
    expect([sol.mintA, sol.mintB, sol.decimalsA, sol.decimalsB, sol.resolved]).toEqual([ADDR.SOL, ADDR.USDC, 9, 6, true]);
    expect([jup.decimalsA, jup.decimalsB]).toEqual([6, 9]);
  });

  // @spec ING-RPC-002
  it('rejects at boot when a pool is owned by another program', async () => {
    rpc.setAccount(ADDR.ORCA_SOL_USDC, RAYDIUM_PROGRAM, rpc.accounts.get(ADDR.ORCA_SOL_USDC)!.data);
    const h = make();
    await expect(h.adapter.start()).rejects.toThrow(PoolValidationError);
    await expect(make().adapter.start()).rejects.toThrow(ADDR.ORCA_SOL_USDC);
  });

  // @spec ING-RPC-002
  it('rejects at boot when a pool does not pair the declared mints', async () => {
    const markets = testMarkets();
    markets.markets[0]!.venues.orca = { pool: ADDR.ORCA_JUP_SOL };
    const h = make({ markets });
    await expect(h.adapter.start()).rejects.toThrow(/does not contain|ends in/);
  });

  // @spec ING-RPC-002
  it('rejects at boot when a pool account does not exist', async () => {
    rpc.accounts.delete(ADDR.ORCA_JUP_SOL);
    await expect(make().adapter.start()).rejects.toThrow(/was not found/);
  });

  // @spec ING-RPC-005
  it('keeps retrying when unreachable at boot, then marks a bad pool misconfigured without exiting', async () => {
    rpc.http = 'down';
    const h = make();
    await h.adapter.start();
    expect(h.sink.states()).toEqual(['connecting']);
    rpc.setAccount(ADDR.ORCA_JUP_SOL, RAYDIUM_PROGRAM, rpc.accounts.get(ADDR.ORCA_JUP_SOL)!.data);
    rpc.http = 'ok';
    await live(h);
    expect(h.sink.of('misconfigured').map((e) => e.pool)).toEqual([poolIdx(h, ADDR.ORCA_JUP_SOL)]);
    const subscribed = rpc.requests.filter((r) => r.method === 'accountSubscribe').map((r) => (r.params as [string])[0]);
    expect(subscribed).toEqual([ADDR.ORCA_SOL_USDC]);
  });
});

describe('subscriptions and snapshot', () => {
  // @spec ING-RPC-011, ING-RPC-012, ING-RPC-006, ING-RPC-015
  it('subscribes slots before accounts, applies a snapshot, then goes live', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    const ws = rpc.requests.filter((r) => r.transport === 'ws');
    expect(ws.map((r) => r.method)).toEqual(['slotSubscribe', 'accountSubscribe', 'accountSubscribe']);
    expect(ws[1]!.params).toEqual([ADDR.ORCA_SOL_USDC, { encoding: 'base64', commitment: 'processed' }]);
    const snaps = h.sink.of('pool').filter((e) => e.kind === 'snapshot');
    expect(snaps.map((e) => e.pool).sort()).toEqual([poolIdx(h, ADDR.ORCA_SOL_USDC), poolIdx(h, ADDR.ORCA_JUP_SOL)].sort());
    expect(snaps.every((e) => e.slot === rpc.slot)).toBe(true);
    expect(h.sink.states()).toEqual(['connecting', 'live']);
    // The snapshot lands before the live transition.
    const iLive = h.sink.events.findIndex((e) => e.t === 'state' && e.state === 'live');
    const iSnap = h.sink.events.findIndex((e) => e.t === 'pool');
    expect(iSnap).toBeLessThan(iLive);
  });

  // @spec ING-RPC-010
  it('uses a separate WebSocket connection per venue', async () => {
    const a = make({ venue: 'orca' });
    const b = make({ venue: 'raydium', sink: a.sink, model: a.model });
    await Promise.all([a.adapter.start(), b.adapter.start()]);
    await waitFor(() => a.sink.states().filter((s) => s === 'live').length === 2, 3000);
    expect(rpc.connections).toBe(2);
  });

  // @spec ING-RPC-013
  it('retries a subscription that is never confirmed', async () => {
    let ignored = 0;
    rpc.confirm = (m, p) => (m === 'accountSubscribe' && (p as [string])[0] === ADDR.ORCA_JUP_SOL && ignored++ < 2 ? 'ignore' : 'ok');
    const h = make();
    await h.adapter.start();
    await waitFor(() => rpc.subscribers('account', ADDR.ORCA_JUP_SOL) === 1, 3000);
    expect(rpc.requests.filter((r) => r.method === 'accountSubscribe' && (r.params as [string])[0] === ADDR.ORCA_JUP_SOL)).toHaveLength(3);
    expect(h.adapter.stats.subscribeFailures.get('timeout')).toBe(2);
  });

  // @spec ING-RPC-013
  it('retries a subscription answered with a JSON-RPC error and counts it by code', async () => {
    let errored = 0;
    rpc.confirm = (m) => (m === 'accountSubscribe' && errored++ < 1 ? 'error' : 'ok');
    const h = make();
    await h.adapter.start();
    await waitFor(() => rpc.subscribers('account') === 2, 3000);
    expect(h.adapter.stats.subscribeFailures.get('rpc_-32005')).toBe(1);
  });

  // @spec ING-RPC-014, ING-RPC-015
  it('goes live with one confirmed pool and keeps retrying the rejected one in the background', async () => {
    rpc.confirm = (m, p) => (m === 'accountSubscribe' && (p as [string])[0] === ADDR.ORCA_JUP_SOL ? 'error' : 'ok');
    const h = make();
    await h.adapter.start();
    await live(h);
    const attempts = () => rpc.requests.filter((r) => r.method === 'accountSubscribe' && (r.params as [string])[0] === ADDR.ORCA_JUP_SOL).length;
    await waitFor(() => attempts() >= 4, 3000, 'initial + 3 retries');
    const n = attempts();
    expect(n).toBe(4);
    await waitFor(() => attempts() > n, 1000, 'background retry');
  });
});

describe('hot path', () => {
  // @spec ING-RPC-021, ING-RPC-016, ING-SRC-002, ING-SRC-001
  it('reports account notifications as pool updates and slot notifications as liveness', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    rpc.pushAccount(ADDR.ORCA_SOL_USDC, { slot: 5000 });
    rpc.pushSlot(5001);
    await waitFor(() => h.sink.of('slot').length > 0 && h.sink.of('pool').some((e) => e.kind === 'notification'));
    const out = new Float64Array(8);
    decoder.decodeNotification(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'accountNotification',
          params: { result: { context: { slot: 1 }, value: { data: [rpc.accounts.get(ADDR.ORCA_SOL_USDC)!.data.toString('base64'), 'base64'] } }, subscription: 1 },
        }),
      ),
      out,
    );
    const u = h.sink.of('pool').find((e) => e.kind === 'notification')!;
    expect(u).toMatchObject({ pool: poolIdx(h, ADDR.ORCA_SOL_USDC), slot: 5000, sqrt: out[3], liq: out[4], tick: out[5] });
    expect(Number.isInteger(u.pool)).toBe(true);
    expect(h.sink.of('slot').at(-1)).toMatchObject({ source: 'orca', slot: 5001 });
    // Facts only: the adapter reports updates, slots and states; it never reports eligibility.
    expect(new Set(h.sink.events.map((e) => e.t))).toEqual(new Set(['state', 'pool', 'slot']));
  });

  // @spec ING-SRC-003
  it('takes receive timestamps from the injected clock before decoding', async () => {
    let mono = 0;
    const clock = { mono: () => (mono += 10), wall: () => 1_700_000_000_000 };
    const h = make({ clock });
    await h.adapter.start();
    await live(h);
    rpc.pushAccount(ADDR.ORCA_SOL_USDC);
    await waitFor(() => h.sink.of('pool').some((e) => e.kind === 'notification'));
    const u = h.sink.of('pool').find((e) => e.kind === 'notification')!;
    expect(u.recvWall).toBe(1_700_000_000_000);
    expect(u.decodedTs).toBe(u.recvTs + 10);
  });

  // @spec ING-RPC-020
  it('passes the raw message Buffer to the decoder', async () => {
    const seen: unknown[] = [];
    const spy: FrameDecoder = { ...decoder, decodeNotification: (f, o) => (seen.push(f), decoder.decodeNotification(f, o)), decodeAccount: (d, v) => decoder.decodeAccount(d, v) };
    const h = make({ decoder: spy });
    await h.adapter.start();
    await live(h);
    rpc.pushAccount(ADDR.ORCA_SOL_USDC);
    await waitFor(() => h.sink.of('pool').some((e) => e.kind === 'notification'));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((f) => Buffer.isBuffer(f))).toBe(true);
  });

  // @spec ING-RPC-022
  it('discards notifications for unknown subscriptions and counts them', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    const before = h.sink.of('pool').length;
    const data = rpc.accounts.get(ADDR.ORCA_SOL_USDC)!.data.toString('base64');
    rpc.sendRaw(
      JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { result: { context: { slot: 9 }, value: { data: [data, 'base64'] } }, subscription: 999_999 } }),
    );
    await waitFor(() => h.adapter.stats.unknownSubscription === 1);
    expect(h.sink.of('pool').length).toBe(before);
  });

  // @spec ING-RPC-024, ING-RPC-023
  it('counts decode errors and reports the pool suspect when its subscription is recoverable', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    const sub = rpc.subscriptionId(ADDR.ORCA_SOL_USDC)!;
    rpc.sendRaw(
      JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { result: { context: { slot: 9 }, value: { data: ['***', 'base64'] } }, subscription: sub } }),
    );
    rpc.sendRaw('{not json');
    await waitFor(() => h.adapter.stats.decodeErrors.get(Status.MALFORMED_JSON) === 1);
    expect(h.adapter.stats.decodeErrors.get(Status.BAD_ENCODING)).toBe(1);
    expect(h.sink.of('suspect').map((e) => e.pool)).toEqual([poolIdx(h, ADDR.ORCA_SOL_USDC)]);
  });

  // @spec ING-RPC-025
  it('warns once per layout about unexpected account sizes', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    const longer = Buffer.concat([rpc.accounts.get(ADDR.ORCA_SOL_USDC)!.data, Buffer.alloc(32)]);
    rpc.pushAccount(ADDR.ORCA_SOL_USDC, { data: longer });
    rpc.pushAccount(ADDR.ORCA_SOL_USDC, { data: longer });
    await waitFor(() => h.sink.of('pool').filter((e) => e.kind === 'notification').length === 2);
    expect(h.logs.filter((l) => l.level === 'warn' && /size/.test(l.msg ?? ''))).toHaveLength(1);
  });

  // @spec ING-RPC-026
  it('closes on frames larger than 64 KiB and reconnects', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    rpc.sendRaw(Buffer.alloc(64 * 1024 + 1, 0x20));
    await waitFor(() => h.sink.states().filter((s) => s === 'live').length === 2, 3000, 'second live');
    expect(h.sink.states()).toEqual(['connecting', 'live', 'down', 'live']);
    expect(rpc.connections).toBe(2);
  });
});

describe('liveness and reconnect', () => {
  // @spec ING-RPC-017
  it('pings the server periodically', async () => {
    const h = make({ options: { pingIntervalMs: 30 } });
    await h.adapter.start();
    await live(h);
    await waitFor(() => rpc.pings >= 3, 2000);
  });

  // @spec ING-RPC-040
  it('reconnects when no pong arrives', async () => {
    rpc.autoPong = false;
    const h = make({ options: { pingIntervalMs: 30, pongTimeoutMs: 40 } });
    await h.adapter.start();
    await live(h);
    await waitFor(() => h.adapter.stats.reconnects.get('ping_timeout') === 1, 2000);
    expect(h.sink.states()).toContain('down');
  });

  // @spec ING-RPC-040, ING-RPC-043
  it('reports down on close, then resubscribes and re-snapshots on reconnect', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    rpc.dropAll();
    await waitFor(() => h.sink.states().filter((s) => s === 'live').length === 2, 3000);
    expect(h.sink.states()).toEqual(['connecting', 'live', 'down', 'live']);
    expect(rpc.count('slotSubscribe')).toBe(2);
    expect(rpc.count('accountSubscribe')).toBe(4);
    expect(h.sink.of('pool').filter((e) => e.kind === 'snapshot')).toHaveLength(4);
    // The new connection's subscription ids are used.
    rpc.pushAccount(ADDR.ORCA_SOL_USDC);
    await waitFor(() => h.sink.of('pool').some((e) => e.kind === 'notification'));
  });

  // @spec ING-RPC-041
  it('reconnects when the registry reports the venue stale for long enough', async () => {
    const h = make();
    await h.adapter.start();
    await live(h);
    h.sink.status = { state: 'stale', lastEventAgeMs: 5000, staleSince: performance.now() - 200 };
    await waitFor(() => h.adapter.stats.reconnects.get('stale') === 1, 2000);
    h.sink.status = { state: 'live', lastEventAgeMs: 0, staleSince: null };
  });

  // @spec ING-RPC-042
  it('computes full-jitter backoff capped at 30 s', () => {
    expect(fullJitter(0, 250, 30_000, () => 1)).toBe(250);
    expect(fullJitter(3, 250, 30_000, () => 1)).toBe(2000);
    expect(fullJitter(20, 250, 30_000, () => 1)).toBe(30_000);
    expect(fullJitter(5, 250, 30_000, () => 0.5)).toBe(4000);
    expect(fullJitter(5, 250, 30_000, () => 0)).toBe(0);
  });

  // @spec ING-RPC-042
  it('resets the backoff attempt after staying live long enough', async () => {
    const h = make({ random: () => 1, options: { backoffBaseMs: 40, backoffCapMs: 10_000, backoffResetMs: 150 } });
    await h.adapter.start();
    await live(h);
    const lives = () => h.sink.states().filter((s) => s === 'live').length;
    for (let i = 2; i <= 4; i++) {
      rpc.dropAll();
      await waitFor(() => lives() === i, 3000);
    }
    // Three quick drops: delays 40, 80, 160 ms. Now stay live past the reset window.
    await sleep(200);
    const t0 = performance.now();
    rpc.dropAll();
    await waitFor(() => lives() === 5, 3000);
    expect(performance.now() - t0).toBeLessThan(250); // 40 ms after reset, not 320 ms
  });

  // @spec ING-RPC-044
  it('waits at least Retry-After after a 429 before calling the RPC again', async () => {
    rpc.http = { status: 429, retryAfter: '0.3' };
    const h = make();
    const t0 = performance.now();
    await h.adapter.start();
    rpc.http = 'ok';
    await live(h);
    const second = performance.now() - t0;
    expect(second).toBeGreaterThanOrEqual(290);
  });

  // @spec ING-RPC-044
  it('parses Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('2', 0)).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
  });
});

describe('revalidation', () => {
  // @spec ING-RPC-031
  it('re-reads pools that have been quiet, as one batched revalidation', async () => {
    const h = make({ options: { revalidateAfterMs: 100 } });
    await h.adapter.start();
    await live(h);
    const httpBefore = rpc.requests.filter((r) => r.transport === 'http').length;
    await waitFor(() => h.sink.of('pool').some((e) => e.kind === 'revalidation'), 2000);
    const reval = rpc.requests.filter((r) => r.transport === 'http').slice(httpBefore);
    expect((reval[0]!.params as [string[]])[0].sort()).toEqual([ADDR.ORCA_SOL_USDC, ADDR.ORCA_JUP_SOL].sort());
  });

  // @spec ING-RPC-031
  it('does not revalidate pools that keep receiving notifications', async () => {
    const h = make({ options: { revalidateAfterMs: 100 } });
    await h.adapter.start();
    await live(h);
    const t = setInterval(() => {
      rpc.pushAccount(ADDR.ORCA_SOL_USDC);
      rpc.pushAccount(ADDR.ORCA_JUP_SOL);
    }, 20);
    await sleep(300);
    clearInterval(t);
    expect(h.sink.of('pool').filter((e) => e.kind === 'revalidation')).toHaveLength(0);
  });
});
