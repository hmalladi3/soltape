import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Consolidated } from '../../../src/reconcile/types.js';
import { sleep, waitFor } from '../../support/fake-rpc.js';
import { startApi, type Api } from '../../support/api.js';

let api: Api;
afterEach(() => api?.stop());

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('WebSocket protocol', () => {
  // @spec API-WS-001
  it('replies subscribed, then a snapshot for priced markets and unavailable for the rest', async () => {
    api = await startApi();
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['sol', JUP_MINT] });
    const sub = await c.next((m) => m.type === 'subscribed');
    expect(sub.mints).toEqual([SOL_MINT, JUP_MINT]);
    const snap = await c.next((m) => m.type === 'snapshot');
    expect(snap.data).toMatchObject({ mint: SOL_MINT, symbol: 'SOL' });
    expect(snap.trigger).toHaveProperty('source');
    const un = await c.next((m) => m.type === 'unavailable');
    expect(un).toEqual({ type: 'unavailable', mint: JUP_MINT, lastKnown: null });
  });

  // @spec API-WS-002
  it('subscribes to every market with "*"', async () => {
    api = await startApi();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['*'] });
    expect((await c.next((m) => m.type === 'subscribed')).mints).toHaveLength(3);
  });

  // @spec API-WS-003
  it('treats duplicate subscribes and unknown unsubscribes as no-ops', async () => {
    api = await startApi();
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'snapshot');
    c.send({ op: 'subscribe', mints: ['SOL'] });
    c.send({ op: 'unsubscribe', mints: ['JUP'] });
    await c.next((m) => m.type === 'unsubscribed');
    await sleep(30);
    expect(c.msgs.filter((m) => m.type === 'snapshot')).toHaveLength(1);
    expect(c.msgs.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(c.msgs.find((m) => m.type === 'unsubscribed').mints).toEqual([]);
  });

  // @spec API-WS-004
  it('applies valid entries and reports rejected ones in a single error', async () => {
    api = await startApi();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL', 'nope', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'] });
    expect((await c.next((m) => m.type === 'subscribed')).mints).toEqual([SOL_MINT]);
    const err = await c.next((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'INVALID_MINTS', rejected: [{ mint: 'nope', reason: 'INVALID_MINT' }, { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', reason: 'MINT_NOT_TRACKED' }] });
    await sleep(20);
    expect(c.msgs.filter((m) => m.type === 'error')).toHaveLength(1);
  });

  // @spec API-WS-005
  it('stops sending updates for unsubscribed markets', async () => {
    api = await startApi();
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'snapshot');
    c.send({ op: 'unsubscribe', mints: ['SOL'] });
    expect((await c.next((m) => m.type === 'unsubscribed')).mints).toEqual([SOL_MINT]);
    api.feed.pool(0, 100.5);
    await sleep(30);
    expect(c.msgs.filter((m) => m.type === 'price')).toHaveLength(0);
  });

  // @spec API-WS-006
  it('answers application pings', async () => {
    api = await startApi();
    const c = await api.ws();
    c.send({ op: 'ping' });
    expect(await c.next((m) => m.type === 'pong')).toEqual({ type: 'pong' });
  });

  // @spec API-WS-007
  it('pushes price updates with the consolidated record, seq and trigger', async () => {
    api = await startApi();
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    const snap = await c.next((m) => m.type === 'snapshot');
    api.feed.quote(0, 100.15);
    const p = await c.next((m) => m.type === 'price');
    expect(p.data.seq).toBe(snap.data.seq + 1);
    expect(p.data.price).toBeCloseTo(100.15, 6);
    expect(p.trigger).toEqual({ source: 'jupiter', slot: expect.any(Number) });
    expect(p.data).not.toHaveProperty('trigger');
  });

  // @spec API-WS-008
  it('pushes unavailable with lastKnown when a market loses its last source', async () => {
    api = await startApi();
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'snapshot');
    for (const s of ['orca', 'raydium', 'jupiter'] as const) api.reconciler.onSourceState(s, 'down');
    const un = await c.next((m) => m.type === 'unavailable');
    expect(un.mint).toBe(SOL_MINT);
    expect(un.lastKnown).toMatchObject({ symbol: 'SOL', stale: true });
  });

  // @spec API-WS-009
  it('does not negotiate permessage-deflate', async () => {
    api = await startApi();
    const c = await api.ws('/ws', { perMessageDeflate: true });
    expect(c.c.extensions).toBe('');
  });
});

describe('WebSocket policing', () => {
  // @spec API-WS-020
  it('closes with 1009 on messages larger than 4 KiB', async () => {
    api = await startApi();
    const c = await api.ws();
    const closed = new Promise<number>((r) => c.c.once('close', (code) => r(code)));
    c.send('x'.repeat(4097));
    expect(await closed).toBe(1009);
  });

  // @spec API-WS-021
  it('applies subscriptions up to the limit and reports TOO_MANY_SUBSCRIPTIONS', async () => {
    api = await startApi({ gateway: { maxSubscriptions: 2 } });
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['*'] });
    expect((await c.next((m) => m.type === 'subscribed')).mints).toHaveLength(2);
    expect(await c.next((m) => m.type === 'error')).toMatchObject({ code: 'TOO_MANY_SUBSCRIPTIONS' });
  });

  // @spec API-WS-022, API-WS-023
  it('answers bad messages with BAD_MESSAGE and closes with 1008 after the strike limit', async () => {
    api = await startApi({ gateway: { maxStrikes: 3 } });
    const c = await api.ws();
    const closed = new Promise<number>((r) => c.c.once('close', (code) => r(code)));
    c.send('not json');
    c.send({ op: 'dance' });
    expect((await c.next((m) => m.type === 'error')).code).toBe('BAD_MESSAGE');
    c.send({ op: 'subscribe', mints: [1, 2] });
    expect(await closed).toBe(1008);
    expect(c.msgs.filter((m) => m.code === 'BAD_MESSAGE')).toHaveLength(3);
  });

  // @spec API-WS-024
  it('terminates clients that stop answering protocol pings', async () => {
    api = await startApi({ gateway: { heartbeatMs: 40 } });
    const c = await api.ws('/ws', { autoPong: false });
    const closed = new Promise<void>((r) => c.c.once('close', () => r()));
    await closed;
    const ok = await api.ws('/ws');
    await sleep(150);
    expect(ok.c.readyState).toBe(1);
  });
});

describe('fan-out and backpressure', () => {
  const big = (api: Api, seq: number): Consolidated => ({
    ...api.reconciler.consolidated(0)!,
    seq,
    sources: Array.from({ length: 40 }, (_, i) => `orca:${'x'.repeat(40)}${i}`),
  });

  // @spec API-FAN-001
  it('serializes each update once for all subscribers', async () => {
    api = await startApi();
    api.feed.solThree();
    const cs = await Promise.all([api.ws(), api.ws(), api.ws()]);
    for (const c of cs) {
      c.send({ op: 'subscribe', mints: ['SOL'] });
      await c.next((m) => m.type === 'snapshot');
    }
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      api.feed.quote(0, 100.12);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    for (const c of cs) await c.next((m) => m.type === 'price');
  });

  // @spec API-FAN-002, API-FAN-003
  it('conflates to the newest update per market while congested, then flushes it on drain', async () => {
    api = await startApi({ gateway: { highWater: 8 * 1024, lowWater: 2 * 1024, slowClientMs: 10_000 } });
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'snapshot');
    const sock = (c.c as unknown as { _socket: import('node:net').Socket })._socket;
    sock.pause();
    let seq = 10_000;
    for (let i = 0; i < 20_000 && api.gateway.stats.conflated === 0; i++) api.gateway.onConsolidated(0, big(api, ++seq), { recvTs: null, decodedTs: null, reconciledTs: 0 });
    expect(api.gateway.stats.conflated).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) api.gateway.onConsolidated(0, big(api, ++seq), { recvTs: null, decodedTs: null, reconciledTs: 0 });
    const last = seq;
    sock.resume();
    await waitFor(() => c.msgs.some((m) => m.data?.seq === last), 5000, 'newest update delivered');
    const seqs = c.msgs.filter((m) => m.type === 'price').map((m) => m.data.seq);
    expect(seqs.length).toBeLessThan(last - 10_000); // some updates were conflated away
    expect(seqs.at(-1)).toBe(last);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // never out of order
  });

  // @spec API-FAN-004
  it('disconnects a client that stays congested with 1013', async () => {
    api = await startApi({ gateway: { highWater: 8 * 1024, lowWater: 2 * 1024, slowClientMs: 150 } });
    api.feed.solThree();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'snapshot');
    const sock = (c.c as unknown as { _socket: import('node:net').Socket })._socket;
    sock.pause();
    // A live feed keeps publishing; once kernel buffers are full the client stays congested.
    let seq = 10_000;
    const feed = setInterval(() => {
      for (let i = 0; i < 200; i++) api.gateway.onConsolidated(0, big(api, ++seq), { recvTs: null, decodedTs: null, reconciledTs: 0 });
    }, 2);
    try {
      await waitFor(() => api.gateway.stats.slowDisconnects === 1, 5000, 'slow disconnect');
    } finally {
      clearInterval(feed);
    }
    const closed = new Promise<number>((r) => c.c.once('close', (code) => r(code)));
    sock.resume();
    expect(await closed).toBe(1013);
  });
});
