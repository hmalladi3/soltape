import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgHistory, Ring } from '../../src/persistence/pg-history.js';
import { RedisLatestStore, META_KEY, marketKey } from '../../src/persistence/redis-latest.js';
import { maintainPartitions, DAY_MS, startOfDayUtc } from '../../src/persistence/partitions.js';
import { Reconciler } from '../../src/reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS, type Consolidated } from '../../src/reconcile/types.js';
import { silentLogger } from '../../src/telemetry/logger.js';
import { FakeClock } from '../support/clock.js';
import { sleep, waitFor } from '../support/fake-rpc.js';
import { sqrtForPoolPrice, testModel } from '../support/model.js';

let pgc: StartedPostgreSqlContainer;
let redisc: StartedRedisContainer;
let admin: pg.Pool;
let redis: Redis;
const toClose: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  [pgc, redisc] = await Promise.all([new PostgreSqlContainer('postgres:17-alpine').start(), new RedisContainer('redis:7-alpine').start()]);
  admin = new pg.Pool({ connectionString: pgc.getConnectionUri() });
  redis = new Redis(redisc.getConnectionUrl());
});

afterAll(async () => {
  for (const c of toClose.splice(0)) await c.close();
  await admin?.end();
  redis?.disconnect();
  await Promise.all([pgc?.stop(), redisc?.stop()]);
});

beforeEach(async () => {
  for (const c of toClose.splice(0)) await c.close();
  await redis.flushall();
  await admin.query('DROP TABLE IF EXISTS observations, consolidated, soltape_migrations CASCADE');
});

/** A reconciler with SOL priced by orca + raydium. */
function priced() {
  const model = testModel();
  const clock = new FakeClock();
  const rec = new Reconciler({ model, clock, thresholds: DEFAULT_THRESHOLDS });
  let slot = 100;
  const pool = (i: number, price: number) =>
    rec.onPoolUpdate(i, sqrtForPoolPrice(model.pools[i]!, price), 1e12, 0, ++slot, clock.mono(), clock.wall(), clock.mono(), 'notification');
  rec.onSourceState('orca', 'live');
  rec.onSourceState('raydium', 'live');
  rec.onSourceState('jupiter', 'disabled');
  rec.onSlot('orca', 1, clock.mono());
  rec.onSlot('raydium', 1, clock.mono());
  pool(0, 100);
  pool(1, 100.1);
  return { model, clock, rec, pool };
}

function redisStore(url: string, p = priced()) {
  const s = new RedisLatestStore({ url, model: p.model, source: p.rec, clock: p.clock, logger: silentLogger, options: { flushMs: 20 } });
  toClose.push(s);
  return { s, ...p };
}

function history(url = pgc.getConnectionUri(), options: ConstructorParameters<typeof PgHistory>[0]['options'] = {}, clock = new FakeClock()) {
  const h = new PgHistory({ url, model: testModel(), clock, logger: silentLogger, options: { flushMs: 20, retryDelayMs: 20, reconnectMs: 50, ...options } });
  toClose.push(h);
  return { h, clock };
}

const consolidatedAt = (ts: number, price: number, mint = 'So11111111111111111111111111111111111111112'): Consolidated => ({
  mint,
  symbol: 'SOL',
  quote: 'USDC',
  price,
  sources: ['orca:x'],
  excluded: [],
  spreadBps: 1,
  degraded: false,
  disagreement: false,
  slot: 5,
  updatedAt: new Date(ts).toISOString(),
  seq: 1,
  trigger: { source: 'orca:x', slot: 5 },
});

describe('Redis latest snapshot', () => {
  // @spec PER-RDS-001, PER-RDS-002
  it('coalesces many updates into one pipelined write per dirty market, with a 24 h expiry', async () => {
    const { s } = redisStore(redisc.getConnectionUrl());
    s.start();
    await waitFor(() => s.state() === 'up', 5000);
    for (let i = 0; i < 1000; i++) s.onConsolidated(0);
    s.onObservation(0);
    await waitFor(() => s.stats.written >= 1, 2000);
    expect(s.stats.written).toBe(1);
    const h = await redis.hgetall(marketKey('So11111111111111111111111111111111111111112'));
    expect(JSON.parse(h['consolidated']!)).toMatchObject({ symbol: 'SOL', price: expect.any(Number) });
    expect(Object.keys(h).filter((k) => k.startsWith('src:'))).toHaveLength(3);
    const ttl = await redis.pttl(marketKey('So11111111111111111111111111111111111111112'));
    expect(ttl).toBeGreaterThan(23 * 3_600_000);
    expect(await redis.hget(META_KEY, 'schema')).toBe('1');
  });

  // @spec PER-RDS-003, PER-COM-002
  it('fails fast and keeps dirty marks while Redis is unreachable', async () => {
    const { s } = redisStore('redis://127.0.0.1:1');
    s.start();
    s.onConsolidated(0);
    const t0 = performance.now();
    await s.flush();
    expect(performance.now() - t0).toBeLessThan(50);
    expect(s.state()).toBe('down');
    expect(s.stats.skipped).toBeGreaterThan(0);
    expect(s.stats.written).toBe(0);
  });

  // @spec PER-RDS-004
  it('rewrites every market after reconnecting', async () => {
    const { s } = redisStore(redisc.getConnectionUrl());
    s.start();
    await waitFor(() => s.state() === 'up', 5000);
    s.onConsolidated(0);
    await waitFor(() => s.stats.written === 1, 2000);
    await redis.flushall();
    await redis.call('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes');
    await waitFor(() => s.stats.written >= 4, 5000);
    expect(await redis.exists(marketKey('So11111111111111111111111111111111111111112'))).toBe(1);
  });

  // @spec PER-RDS-005
  it('restores display-only state for configured markets', async () => {
    const a = redisStore(redisc.getConnectionUrl());
    a.s.start();
    await waitFor(() => a.s.state() === 'up', 5000);
    a.s.onConsolidated(0);
    await waitFor(() => a.s.stats.written === 1, 2000);
    const fresh = priced();
    const b = redisStore(redisc.getConnectionUrl(), { ...fresh, rec: new Reconciler({ model: fresh.model, clock: fresh.clock, thresholds: DEFAULT_THRESHOLDS }) });
    const entries = await b.s.restore();
    expect(entries).toHaveLength(1);
    b.rec.restore(entries);
    expect(b.rec.available(0)).toBe(false);
    expect(b.rec.consolidated(0)).toMatchObject({ symbol: 'SOL', stale: true, restored: true });
  });

  // @spec PER-RDS-005
  it('restores while the background connection is still being established', async () => {
    const a = redisStore(redisc.getConnectionUrl());
    a.s.start();
    await waitFor(() => a.s.state() === 'up', 5000);
    a.s.onConsolidated(0);
    await waitFor(() => a.s.stats.written === 1, 2000);
    const b = redisStore(redisc.getConnectionUrl());
    b.s.start(); // connecting, not yet ready: the boot sequence in ServiceRuntime
    const entries = await b.s.restore();
    expect(entries.map((e) => e.mint)).toEqual(['So11111111111111111111111111111111111111112']);
  });

  // @spec PER-RDS-006
  it('ignores malformed, wrong-schema and unknown-source entries', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    await redis.hset(marketKey(mint), { consolidated: '{not json', 'src:phoenix:abc': JSON.stringify({ source: 'phoenix:abc', venue: 'phoenix', price: 1, eligible: false }) });
    const { s } = redisStore(redisc.getConnectionUrl());
    expect(await s.restore()).toEqual([]);
    expect(s.stats.restoreIgnored).toBe(2);
    await redis.hset(META_KEY, 'schema', '99');
    await redis.hset(marketKey(mint), 'consolidated', JSON.stringify(consolidatedAt(Date.now(), 100)));
    expect(await s.restore()).toEqual([]);
  });

  // @spec PER-COM-001
  it('records work synchronously in O(1) without touching the network', () => {
    const { s } = redisStore('redis://127.0.0.1:1');
    const { h } = history('postgres://u:p@127.0.0.1:1/db');
    const c = consolidatedAt(Date.now(), 100);
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      expect(s.onConsolidated(0)).toBeUndefined();
      h.onConsolidated(0, c);
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('Postgres history: schema and partitions', () => {
  // @spec PER-PG-001, PER-PG-002, PER-PG-007
  it('migrates before going up: partitioned tables, double precision prices and (mint, ts) indexes', async () => {
    const { h } = history();
    expect(h.state()).toBe('down');
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    const parts = (await admin.query(`SELECT c.relname FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid ORDER BY 1`)).rows.map((r) => r.relname);
    expect(parts).toEqual(['consolidated', 'observations']);
    const types = (
      await admin.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('observations','consolidated') AND column_name IN ('price','size','spread_bps')`,
      )
    ).rows;
    expect(types.every((t) => t.data_type === 'double precision')).toBe(true);
    const idx = (await admin.query(`SELECT tablename, indexdef FROM pg_indexes WHERE tablename LIKE 'consolidated_2%'`)).rows;
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.every((i) => /\(mint, ts\)/.test(i.indexdef))).toBe(true);
  });

  // @spec PER-PG-007
  it('leaves history down when a migration fails, without throwing', async () => {
    await admin.query('CREATE TABLE observations (x int)');
    const { h } = history();
    h.start();
    await sleep(300);
    expect(h.state()).toBe('down');
    expect(h.available()).toBe(false);
  });

  // @spec PER-PG-003, PER-PG-004
  it('creates today plus two days ahead, drops partitions past retention, never the DEFAULT', async () => {
    const { h, clock } = history(undefined, { retentionDays: 7 });
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    const today = startOfDayUtc(clock.wall());
    const name = (t: number) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
    const old = today - 9 * DAY_MS;
    await admin.query(
      `CREATE TABLE consolidated_${name(old)} PARTITION OF consolidated FOR VALUES FROM ('${new Date(old).toISOString()}') TO ('${new Date(old + DAY_MS).toISOString()}')`,
    );
    await admin.query(`INSERT INTO consolidated_default VALUES ('1999-01-01', 'm', 1, 0, 1, false, false, null, '{}')`);
    const r = await h.maintain();
    expect(r.dropped).toEqual([`consolidated_${name(old)}`]);
    expect(r.defaultRows.consolidated).toBe(1);
    const parts = (
      await admin.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'consolidated' ORDER BY 1`,
      )
    ).rows.map((x) => x.relname);
    expect(parts).toEqual(['consolidated_default', ...[0, 1, 2].map((d) => `consolidated_${name(today + d * DAY_MS)}`)].sort());
  });

  // @spec PER-PG-005
  it('moves DEFAULT rows into a newly created partition in one transaction', async () => {
    const { h, clock } = history();
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    const day3 = startOfDayUtc(clock.wall()) + 3 * DAY_MS;
    await admin.query(`INSERT INTO consolidated VALUES ($1, 'm', 1, 0, 1, false, false, null, '{}'), ($2, 'm', 2, 0, 1, false, false, null, '{}')`, [
      new Date(day3 + 1000),
      new Date(day3 + 2000),
    ]);
    expect((await admin.query('SELECT count(*)::int n FROM consolidated_default')).rows[0].n).toBe(2);
    clock.advance(DAY_MS);
    const r = await h.maintain();
    expect(r.moved).toEqual([{ partition: expect.stringMatching(/^consolidated_\d{8}$/), rows: 2 }]);
    expect((await admin.query('SELECT count(*)::int n FROM consolidated_default')).rows[0].n).toBe(0);
    expect((await admin.query('SELECT count(*)::int n FROM consolidated')).rows[0].n).toBe(2);
  });

  // @spec PER-PG-006
  it('serializes concurrent maintenance with the advisory lock', async () => {
    const { h, clock } = history();
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    const c1 = await admin.connect();
    const c2 = await admin.connect();
    try {
      await admin.query(
        'DROP TABLE IF EXISTS ' +
          (
            await admin.query(
              `SELECT string_agg(c.relname, ',') s FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname='observations' AND c.relname <> 'observations_default'`,
            )
          ).rows[0].s,
      );
      // Same clock as the sink: real Date.now() can be a different UTC day from the fake clock.
      const [a, b] = await Promise.all([maintainPartitions(c1, clock.wall(), 7), maintainPartitions(c2, clock.wall(), 7)]);
      expect(a.created.length + b.created.length).toBe(3);
    } finally {
      c1.release();
      c2.release();
    }
  });
});

describe('Postgres history: writer and reader', () => {
  // @spec PER-PG-010, PER-PG-011, PER-PG-012
  it('writes observations and consolidated rows in batches', async () => {
    const p = priced();
    const { h, clock } = history();
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    for (const o of p.rec.observations(0)) h.onObservation(0, 0, o);
    for (let i = 0; i < 1500; i++) h.onConsolidated(0, consolidatedAt(clock.wall() + i, 100 + i / 1000));
    await waitFor(async () => (await admin.query('SELECT count(*)::int n FROM consolidated')).rows[0].n === 1500, 5000);
    expect((await admin.query('SELECT count(*)::int n FROM consolidated_default')).rows[0].n).toBe(0); // all landed in daily partitions
    expect((await admin.query('SELECT count(*)::int n FROM observations')).rows[0].n).toBe(2); // jupiter has no price
    expect(h.stats.written.pg_consolidated).toBe(1500);
  });

  // @spec PER-PG-013
  it('drops the oldest queued rows when the queue is full', () => {
    const r = new Ring<number>(5);
    for (let i = 1; i <= 8; i++) r.push(i);
    expect(r.take(10)).toEqual([4, 5, 6, 7, 8]);
    const { h } = history('postgres://u:p@127.0.0.1:1/db', { queueMax: 5, batchRows: 1000 });
    for (let i = 0; i < 12; i++) h.onConsolidated(0, consolidatedAt(Date.now(), 1));
    expect(h.stats.dropped.pg_consolidated).toBe(7);
    expect(h.pending()).toBe(5);
  });

  // @spec PER-PG-014, PER-COM-002
  it('retries a failed batch once, then drops it and reports down', async () => {
    const { h } = history('postgres://u:p@127.0.0.1:1/db', { connectTimeoutMs: 100 });
    h.start();
    for (let i = 0; i < 10; i++) h.onConsolidated(0, consolidatedAt(Date.now(), 1));
    await waitFor(() => h.stats.dropped.pg_consolidated === 10, 5000);
    expect(h.state()).toBe('down');
  });

  // @spec PER-PG-015, PER-PG-016
  it('uses a writer pool (5 s statement timeout) and a separate reader pool (2 s)', async () => {
    const { h } = history();
    const pools = h as unknown as { writer: pg.Pool; reader: pg.Pool };
    expect(pools.writer.options.max).toBe(4);
    expect(pools.reader.options.max).toBe(2);
    expect(pools.writer.options.connectionTimeoutMillis).toBe(2000);
    expect((await pools.writer.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('5s');
    expect((await pools.reader.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('2s');
  });

  // @spec PER-PG-016
  it('answers bucketed OHLC from consolidated history, omitting empty buckets', async () => {
    const { h, clock } = history();
    h.start();
    await waitFor(() => h.state() === 'up', 10_000);
    const t0 = Math.floor(clock.wall() / 60_000) * 60_000 - 10 * 60_000;
    for (const [dt, price] of [
      [1000, 10],
      [2000, 12],
      [3000, 9],
      [4000, 11],
      [3 * 60_000 + 5000, 20],
    ] as const)
      h.onConsolidated(0, consolidatedAt(t0 + dt, price));
    await waitFor(async () => (await admin.query('SELECT count(*)::int n FROM consolidated')).rows[0].n === 5, 5000);
    const b = await h.query('So11111111111111111111111111111111111111112', t0, t0 + 10 * 60_000, '1m');
    expect(b).toEqual([
      { t: new Date(t0).toISOString(), open: 10, high: 12, low: 9, close: 11, samples: 4 },
      { t: new Date(t0 + 3 * 60_000).toISOString(), open: 20, high: 20, low: 20, close: 20, samples: 1 },
    ]);
    expect(h.retentionStartMs()).toBe(startOfDayUtc(clock.wall()) - 7 * DAY_MS);
  });
});
