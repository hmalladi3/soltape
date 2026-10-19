import { afterEach, describe, expect, it } from 'vitest';
import { JupiterAdapter, type JupiterOptions } from '../../../src/ingest/jupiter-adapter.js';
import { buildSkeleton } from '../../../src/markets/model.js';
import { silentLogger } from '../../../src/telemetry/logger.js';
import { sleep, waitFor } from '../../support/fake-rpc.js';
import { ADDR, testMarkets } from '../../support/ingest.js';
import { RecordingSink } from '../../support/sink.js';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; throws?: boolean };

const adapters: JupiterAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop();
});

function setup(replies: Reply[] | ((n: number) => Reply), opts: { apiKey?: string | undefined; options?: Partial<JupiterOptions> } = {}) {
  const sk = buildSkeleton(testMarkets());
  if (!sk.ok) throw new Error('model');
  const sink = new RecordingSink();
  const calls: { url: string; headers: Headers; at: number }[] = [];
  const fetchStub = (async (url: string | URL, init?: RequestInit) => {
    const n = calls.length;
    calls.push({ url: String(url), headers: new Headers(init?.headers), at: performance.now() });
    const r = typeof replies === 'function' ? replies(n) : (replies[Math.min(n, replies.length - 1)] ?? { status: 500 });
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(init.signal!.reason)));
      });
    }
    if (r.throws) throw new TypeError('fetch failed');
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  const a = new JupiterAdapter({
    model: sk.value,
    sink,
    clock: { mono: () => performance.now(), wall: () => Date.now() },
    logger: silentLogger,
    url: 'http://jup.test/price/v3',
    apiKey: 'apiKey' in opts ? opts.apiKey : 'test-key',
    options: { intervalMs: 20, timeoutMs: 100, ...opts.options },
    fetch: fetchStub,
  });
  adapters.push(a);
  return { a, sink, calls, model: sk.value };
}

const prices = (sol: number | null, usdc: number | null, jup: number | null, blockId = 400) => ({
  ...(sol !== null ? { [ADDR.SOL]: { usdPrice: sol, blockId, decimals: 9 } } : {}),
  ...(usdc !== null ? { [ADDR.USDC]: { usdPrice: usdc, blockId, decimals: 6 } } : {}),
  ...(jup !== null ? { [ADDR.JUP]: { usdPrice: jup, blockId, decimals: 6 } } : {}),
});

describe('Jupiter adapter', () => {
  // @spec ING-JUP-001
  it('is disabled and makes no requests without an API key', async () => {
    const { a, sink, calls } = setup([], { apiKey: undefined });
    await a.start();
    await sleep(60);
    expect(sink.states()).toEqual(['disabled']);
    expect(calls).toHaveLength(0);
  });

  // @spec ING-JUP-002
  it('polls all tracked mints plus the quote mint in one request with the API key', async () => {
    const { a, calls } = setup([{ body: prices(100, 1, 0.5) }]);
    await a.start();
    await waitFor(() => calls.length >= 2);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('ids')!.split(',')).toEqual([ADDR.SOL, ADDR.JUP, ADDR.USDC]);
    expect(calls[0]!.headers.get('x-api-key')).toBe('test-key');
  });

  // @spec ING-JUP-002
  it('never has more than one request in flight', async () => {
    const { a, calls } = setup(() => ({ body: prices(100, 1, 0.5), delayMs: 50 }), { options: { intervalMs: 1, timeoutMs: 500 } });
    await a.start();
    await waitFor(() => calls.length >= 3, 2000);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(49);
  });

  // @spec ING-JUP-005, ING-JUP-007, ING-JUP-009
  it('converts USD prices into USDC with the same response and reports liveness first', async () => {
    const { a, sink } = setup([{ body: prices(104, 0.998, 0.52, 777) }]);
    await a.start();
    await waitFor(() => sink.of('quote').length >= 2);
    expect(sink.states()).toEqual(['connecting', 'live']);
    const q = sink.of('quote').slice(0, 2);
    expect(q.map((x) => x.market)).toEqual([0, 1]);
    expect(q[0]!.price).toBeCloseTo(104 / 0.998, 12);
    expect(q[1]!.price).toBeCloseTo(0.52 / 0.998, 12);
    expect(q[0]!.blockId).toBe(777);
    const iSlot = sink.events.findIndex((e) => e.t === 'slot');
    const iQuote = sink.events.findIndex((e) => e.t === 'quote');
    expect(iSlot).toBeLessThan(iQuote);
    expect(sink.of('slot')[0]).toMatchObject({ source: 'jupiter', slot: 777 });
  });

  // @spec ING-JUP-007
  it('reports a null slot when the response carries no blockId', async () => {
    const { a, sink } = setup([{ body: { [ADDR.SOL]: { usdPrice: 100 }, [ADDR.USDC]: { usdPrice: 1 } } }]);
    await a.start();
    await waitFor(() => sink.of('slot').length > 0);
    expect(sink.of('slot')[0]!.slot).toBeNull();
  });

  // @spec ING-JUP-004
  it('skips missing or invalid entries without affecting other mints', async () => {
    const { a, sink } = setup([{ body: { ...prices(100, 1, null), [ADDR.JUP]: { usdPrice: -3 } } }]);
    await a.start();
    await waitFor(() => sink.of('quote').length >= 1);
    await sleep(30);
    expect(new Set(sink.of('quote').map((q) => q.market))).toEqual(new Set([0]));
  });

  // @spec ING-JUP-006
  it('reports no prices when the quote-mint entry is missing or invalid', async () => {
    const { a, sink } = setup([{ body: { ...prices(100, null, 0.5), [ADDR.USDC]: { usdPrice: 'one' } } }]);
    await a.start();
    await waitFor(() => sink.of('slot').length >= 2);
    expect(sink.of('quote')).toHaveLength(0);
  });

  // @spec ING-JUP-003, ING-JUP-009
  it('counts timeouts as failures and goes down after 3 consecutive failures', async () => {
    const { a, sink } = setup((n) => (n === 0 ? { body: prices(100, 1, 0.5) } : { delayMs: 1000 }), { options: { timeoutMs: 30 } });
    await a.start();
    await waitFor(() => sink.states().includes('down'), 2000);
    expect(sink.states()).toEqual(['connecting', 'live', 'down']);
    expect(a.stats.failures).toBeGreaterThanOrEqual(3);
  });

  // @spec ING-JUP-009
  it('does not go down on fewer than 3 consecutive failures', async () => {
    const { a, sink, calls } = setup((n) => (n % 3 === 2 ? { body: prices(100, 1, 0.5) } : { throws: true }));
    await a.start();
    await waitFor(() => calls.length >= 9, 2000);
    expect(sink.states()).not.toContain('down');
  });

  // @spec ING-JUP-010
  it('honours Retry-After on 429', async () => {
    const { a, calls } = setup((n) => (n === 0 ? { status: 429, headers: { 'retry-after': '0.2' } } : { body: prices(100, 1, 0.5) }));
    await a.start();
    await waitFor(() => calls.length >= 2, 2000);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(190);
  });

  // @spec ING-JUP-010
  it('doubles the interval on 429 without Retry-After, capped, and returns toward the configured interval', async () => {
    const { a, calls } = setup((n) => (n < 3 ? { status: 429 } : { body: prices(100, 1, 0.5) }), { options: { intervalMs: 20, maxIntervalMs: 60 } });
    await a.start();
    await waitFor(() => calls.length >= 7, 3000);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(gaps[0]).toBeGreaterThanOrEqual(38); // 40
    expect(gaps[1]).toBeGreaterThanOrEqual(58); // 60 (cap)
    expect(gaps[2]).toBeGreaterThanOrEqual(58); // still capped
    expect(gaps.at(-1)!).toBeLessThan(45); // decayed back toward 20
  });

  // @spec ING-JUP-011
  it.each([
    ['an array body', [1, 2]],
    ['a string body', 'x'],
  ])('counts %s as a failed poll', async (_label, body) => {
    const { a, sink } = setup([{ body }]);
    await a.start();
    await waitFor(() => sink.states().includes('down'), 2000);
    expect(sink.of('quote')).toHaveLength(0);
  });
});
