import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryReader } from '../../../src/api/history.js';
import { startApi, type Api } from '../../support/api.js';

let api: Api;
afterEach(() => api?.stop());

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const ORCA_SOL = 'orca:Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

describe('HTTP basics', () => {
  // @spec API-HTTP-001
  it('serves REST, the live page and WebSocket upgrades on /ws from one server', async () => {
    api = await startApi();
    api.feed.solThree();
    expect((await api.get('/health')).status).toBe(200);
    expect((await api.get('/')).headers.get('content-type')).toMatch(/text\/html/);
    const c = await api.ws('/ws');
    expect(c.c.readyState).toBe(1);
    await expect(api.ws('/elsewhere')).rejects.toThrow();
  });

  // @spec API-HTTP-002
  it('resolves configured symbols case-insensitively', async () => {
    api = await startApi();
    api.feed.solThree();
    for (const p of ['SOL', 'sol', 'Sol', SOL_MINT]) expect((await api.get(`/price/${p}`)).body.mint).toBe(SOL_MINT);
  });

  // @spec API-HTTP-003
  it('rejects values that are neither symbols nor base58 mints with 400 INVALID_MINT', async () => {
    api = await startApi();
    const r = await api.get('/price/not-a-mint');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_MINT');
  });

  // @spec API-HTTP-004
  it('rejects untracked mints with 404 MINT_NOT_TRACKED', async () => {
    api = await startApi();
    const r = await api.get('/price/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('MINT_NOT_TRACKED');
  });

  // @spec API-HTTP-005
  it('returns every error as { error: { code, message, requestId } }', async () => {
    api = await startApi();
    for (const path of ['/price/x', '/sources/x', '/nope', '/history/SOL']) {
      const { body } = await api.get(path);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
      expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  // @spec API-HTTP-006
  it('maps unexpected handler errors to 500 INTERNAL and logs them', async () => {
    const broken: HistoryReader = {
      available: () => {
        throw new TypeError('boom');
      },
      retentionStartMs: () => 0,
      query: async () => [],
    };
    api = await startApi({ history: broken });
    const r = await api.get('/history/SOL');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
    expect(api.logs.some((l) => l.level === 'error')).toBe(true);
  });

  // @spec API-HTTP-007
  it('serves prices from memory while Redis and Postgres are down', async () => {
    api = await startApi();
    api.deps.redis = 'down';
    api.deps.postgres = 'down';
    api.feed.solThree();
    expect((await api.get('/price/SOL')).status).toBe(200);
    expect((await api.get('/sources/SOL')).status).toBe(200);
  });
});

describe('REST endpoints', () => {
  // @spec API-REST-001
  it('GET /price returns the consolidated record', async () => {
    api = await startApi();
    api.feed.solThree();
    const { status, body } = await api.get('/price/SOL');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['degraded', 'disagreement', 'excluded', 'mint', 'price', 'quote', 'seq', 'slot', 'sources', 'spreadBps', 'symbol', 'updatedAt'].sort());
    expect(body).toMatchObject({ symbol: 'SOL', quote: 'USDC', degraded: false, disagreement: false });
    expect(body.price).toBeCloseTo(100.1, 6);
  });

  // @spec API-REST-002
  it('GET /price answers 503 with lastKnown when no source is eligible', async () => {
    api = await startApi();
    const never = await api.get('/price/JUP');
    expect(never.status).toBe(503);
    expect(never.body.error.code).toBe('NO_ELIGIBLE_SOURCES');
    expect(never.body.lastKnown).toBeNull();
    api.feed.solThree();
    api.reconciler.onSourceState('orca', 'down');
    api.reconciler.onSourceState('raydium', 'down');
    api.reconciler.onSourceState('jupiter', 'down');
    const r = await api.get('/price/SOL');
    expect(r.status).toBe(503);
    expect(r.body.lastKnown).toMatchObject({ symbol: 'SOL', stale: true });
  });

  // @spec API-REST-003
  it('GET /sources lists every configured venue, eligible or not, with ISO receive times', async () => {
    api = await startApi();
    api.feed.live('orca', 'raydium');
    api.reconciler.onSourceState('jupiter', 'disabled');
    api.feed.pool(0, 100);
    api.feed.pool(2, 0.0028);
    const { body } = await api.get('/sources/JUP');
    expect(body.sources).toHaveLength(3);
    const orca = body.sources.find((s: any) => s.venue === 'orca');
    expect(orca).toMatchObject({ kind: 'route', sourceState: 'live', eligible: true, reason: null });
    expect(orca.legs).toHaveLength(2);
    expect(new Date(orca.receivedAt).toISOString()).toBe(orca.receivedAt);
    expect(body.sources.find((s: any) => s.venue === 'raydium')).toMatchObject({ eligible: false, reason: 'no_data', leg: 1, price: null });
    expect(body.sources.find((s: any) => s.venue === 'jupiter')).toMatchObject({ eligible: false, reason: 'source_disabled', sourceState: 'disabled' });
  });

  // @spec API-REST-004
  it('GET /mints lists markets with their venues', async () => {
    api = await startApi();
    const { body } = await api.get('/mints');
    expect(body.markets.map((m: any) => m.symbol)).toEqual(['SOL', 'JUP', 'JTO']);
    expect(body.markets[0].venues.map((v: any) => v.venue)).toEqual(['orca', 'raydium', 'jupiter']);
    expect(body.quote.symbol).toBe('USDC');
  });

  const reader = (over: Partial<HistoryReader> = {}): HistoryReader & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      available: () => true,
      retentionStartMs: () => Date.now() - 2 * 86_400_000,
      query: async (...a) => {
        calls.push(a);
        return [{ t: new Date(0).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, samples: 3 }];
      },
      ...over,
    };
  };

  // @spec API-REST-005
  it('GET /history returns non-empty buckets with the effective range', async () => {
    const h = reader();
    api = await startApi({ history: h });
    const { status, body } = await api.get('/history/SOL?window=1h&bucket=1m');
    expect(status).toBe(200);
    expect(body).toMatchObject({ mint: SOL_MINT, symbol: 'SOL', bucket: '1m', clamped: false });
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(3_600_000);
    expect(body.buckets[0]).toEqual({ t: new Date(0).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, samples: 3 });
    expect(h.calls[0]![0]).toBe(SOL_MINT);
  });

  // @spec API-REST-006
  it('GET /history clamps windows beyond retention', async () => {
    api = await startApi({ history: reader() });
    const { body } = await api.get('/history/SOL?window=7d&bucket=1h');
    expect(body.clamped).toBe(true);
    expect(Date.parse(body.to) - Date.parse(body.from)).toBeLessThanOrEqual(2 * 86_400_000 + 1000);
  });

  // @spec API-REST-007
  it.each(['window=1w', 'window=0h', 'bucket=2m', 'window=7d&bucket=1s', 'window=abc'])('GET /history rejects %s with 400 INVALID_QUERY', async (q) => {
    api = await startApi({ history: reader({ retentionStartMs: () => 0 }) });
    const r = await api.get(`/history/SOL?${q}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_QUERY');
  });

  // @spec API-REST-008
  it('GET /history answers 503 HISTORY_UNAVAILABLE when storage is down or the query fails', async () => {
    api = await startApi();
    expect((await api.get('/history/SOL')).body.error.code).toBe('HISTORY_UNAVAILABLE');
    await api.stop();
    api = await startApi({ history: reader({ query: async () => Promise.reject(new Error('statement timeout')) }) });
    const r = await api.get('/history/SOL');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('HISTORY_UNAVAILABLE');
  });

  // @spec API-REST-009
  it('GET /stats reports latency percentiles, update rate, source states and decoder', async () => {
    api = await startApi();
    const c = await api.ws();
    c.send({ op: 'subscribe', mints: ['SOL'] });
    await c.next((m) => m.type === 'subscribed');
    api.feed.solThree();
    const { body } = await api.get('/stats');
    expect(body.samples).toBeGreaterThan(0);
    expect(body.latencyUs.p99).toBeGreaterThanOrEqual(body.latencyUs.p50);
    expect(body.latencyUs.p999).toBeGreaterThanOrEqual(body.latencyUs.p99);
    expect(body.sources.map((s: any) => s.id)).toEqual(['orca', 'raydium', 'jupiter']);
    expect(body.decoder).toBe('native');
    expect(typeof body.updatesPerSec).toBe('number');
  });

  // @spec API-REST-010
  it('GET /metrics answers in Prometheus text format', async () => {
    api = await startApi();
    const r = await api.get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
  });
});

describe('health', () => {
  // @spec API-HLTH-001, API-HLTH-002
  it('is ok when every enabled source is live and every market is available', async () => {
    api = await startApi();
    api.feed.live('orca', 'raydium', 'jupiter');
    for (const [i, p] of [[0, 100], [1, 100], [2, 0.0028], [3, 0.0028], [4, 232], [5, 232]] as const) api.feed.pool(i, p);
    for (const m of [0, 1, 2]) api.feed.quote(m, [100, 0.28, 0.43][m]!);
    const { status, body } = await api.get('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body).sort()).toEqual(['decoder', 'dependencies', 'markets', 'misconfigured', 'sources', 'status', 'uptimeS'].sort());
    expect(body.markets).toEqual({ available: 3, unavailable: 0 });
    expect(body.sources[0]).toMatchObject({ id: 'orca', state: 'live' });
    expect(typeof body.sources[0].lastEventAgeMs).toBe('number');
  });

  // @spec API-HLTH-003
  it('is degraded when a market is unavailable, a source is not live, or a pool is misconfigured', async () => {
    api = await startApi();
    api.feed.solThree();
    expect((await api.get('/health')).body.status).toBe('degraded'); // JUP and JTO unavailable
    api.reconciler.onPoolMisconfigured(5, 'pool X is owned by Y');
    const { body } = await api.get('/health');
    expect(body.misconfigured).toEqual([{ pool: api.model.pools[5]!.address, venue: 'raydium', reason: 'pool X is owned by Y' }]);
  });

  // @spec API-HLTH-004
  it('is down (503) when no market is available', async () => {
    api = await startApi();
    const r = await api.get('/health');
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('down');
  });

  // @spec API-HLTH-004
  it('reports starting (200) and stopping (503) from the lifecycle phase', async () => {
    api = await startApi();
    api.phase.phase = 'starting';
    expect(await api.get('/health')).toMatchObject({ status: 200, body: { status: 'starting' } });
    api.phase.phase = 'stopping';
    expect(await api.get('/health')).toMatchObject({ status: 503, body: { status: 'stopping' } });
  });

  // @spec API-HLTH-005
  it('ignores disabled sources and datastore outages when computing status', async () => {
    api = await startApi();
    api.feed.live('orca', 'raydium');
    api.reconciler.onSourceState('jupiter', 'disabled');
    for (const [i, p] of [[0, 100], [1, 100], [2, 0.0028], [3, 0.0028], [4, 232], [5, 232]] as const) api.feed.pool(i, p);
    api.deps.redis = 'down';
    api.deps.postgres = 'down';
    const { body } = await api.get('/health');
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({ redis: 'down', postgres: 'down' });
    expect(body.sources.find((s: any) => s.id === 'jupiter')).toEqual({ id: 'jupiter', state: 'disabled' });
  });
});
