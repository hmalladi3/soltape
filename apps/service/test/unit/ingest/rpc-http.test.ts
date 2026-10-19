import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcHttpClient } from '../../../src/ingest/rpc-http.js';
import { FakeRpc } from '../../support/fake-rpc.js';
import { ADDR, seed } from '../../support/ingest.js';

let rpc: FakeRpc;
beforeEach(async () => {
  rpc = await FakeRpc.start();
  seed(rpc);
});
afterEach(() => rpc.close());

const client = (url = rpc.httpUrl, timeoutMs = 500, f?: typeof fetch) =>
  new RpcHttpClient({ url, commitment: 'processed', timeoutMs, clock: { mono: () => 0, wall: () => 0 }, ...(f ? { fetch: f } : {}) });

describe('RPC HTTP client', () => {
  it('returns accounts in key order with nulls for missing ones', async () => {
    const r = await client().getMultipleAccounts([ADDR.ORCA_SOL_USDC, 'missing111111111111111111111111111111111', ADDR.SOL]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.accounts.map((a) => a?.owner ?? null)).toEqual([rpc.accounts.get(ADDR.ORCA_SOL_USDC)!.owner, null, rpc.accounts.get(ADDR.SOL)!.owner]);
    expect(r.value.slot).toBe(rpc.slot);
  });

  it('splits requests above 100 keys', async () => {
    const keys = Array.from({ length: 150 }, () => ADDR.SOL);
    const r = await client().getMultipleAccounts(keys);
    expect(r.ok && r.value.accounts.length).toBe(150);
    expect(rpc.count('getMultipleAccounts')).toBe(2);
  });

  // @spec RUN-ERR-002, ING-RPC-044
  it.each([
    ['429 with Retry-After', () => (rpc.http = { status: 429, retryAfter: '3' }), { kind: 'rate_limited', retryAfterMs: 3000 }],
    ['HTTP 503', () => (rpc.http = { status: 503 }), { kind: 'http', status: 503 }],
    ['connection reset', () => (rpc.http = 'down'), { kind: 'network' }],
  ])('returns %s as a failure value, never throwing', async (_l, arrange, expected) => {
    arrange();
    const r = await client().getMultipleAccounts([ADDR.SOL]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure).toMatchObject(expected);
  });

  // @spec RUN-ERR-002
  it.each([
    ['a timeout', async () => new Promise<Response>(() => {}), 'timeout'],
    ['non-JSON', async () => new Response('<html>'), 'invalid'],
    ['a JSON-RPC error', async () => new Response(JSON.stringify({ error: { code: -32602, message: 'bad' } })), 'rpc'],
    ['a wrong shape', async () => new Response(JSON.stringify({ result: { value: 5 } })), 'invalid'],
  ])('returns %s as a failure value', async (_l, f, kind) => {
    const stub = ((_u: unknown, init?: RequestInit) =>
      Promise.race([f(), new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))])) as typeof fetch;
    const r = await client(rpc.httpUrl, 30, stub).getMultipleAccounts([ADDR.SOL]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe(kind);
  });
});
