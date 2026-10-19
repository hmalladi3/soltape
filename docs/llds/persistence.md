# Persistence

## Context and Design Philosophy

Persistence has two consumers with different needs:
- **Redis** holds the *latest* snapshot: the consolidated price and per-source observations per market. It enables a warm restart, and it is the integration point for future read replicas (an HLD non-goal to build them, but the design shouldn't block them).
- **Postgres** holds the *rolling history* of observations and consolidated prices for `/history` and offline analysis.

Neither store is on the hot path, and neither is a startup dependency (HLD KDD-9, Goal 3). Both writers are **bounded queues with coalescing or drop policies**: when a store is slow or down, memory stays flat, losses are counted, and the live feed is unaffected.

## Interfaces

```ts
interface LatestStore  { markDirty(mktIdx: number): void; restore(deadlineMs: number): Promise<Restored[]>; state(): 'up'|'down' }
interface HistorySink  { enqueueObservation(o: ObsRow): void; enqueueConsolidated(c: ConsRow): void; state(): 'up'|'down' }
```

Both are called synchronously from reconciler listeners. Both calls cost O(1) and never await.

## Redis: Latest Snapshot

### Key schema

| Key | Type | Fields |
|---|---|---|
| `soltape:v1:market:{mint}` | Hash | `consolidated` → JSON (REST shape), `src:{sourceId}` → JSON (observation shape), `updatedAt` → ms epoch |
| `soltape:v1:meta` | Hash | `schema` → `1`, `bootedAt`, `decoder` |

The `v1` key prefix is a schema version. A schema change bumps it, and old keys expire on their own via TTL.

### Write policy: dirty-set coalescing

- `markDirty(mktIdx)` sets a bit in a fixed-size dirty bitmap.
- Every `REDIS_FLUSH_MS` (default 100 ms), if any bit is set, the writer serializes the current state of the dirty markets and sends one pipelined `HSET` per market, plus a `PEXPIRE` of 24 h.
- **The flush reads the latest state at flush time, not queued events.** However many updates happen between flushes, a market costs exactly one write. Memory use doesn't depend on the update rate.
- At most one flush is in flight. If a flush is still running when the timer fires, that tick is skipped and the bits stay set.

### Failure behaviour

ioredis handles reconnects (`maxRetriesPerRequest: 1`, offline queue **disabled**, so commands fail fast instead of buffering while disconnected).

- **While `down`:** flushes are skipped and dirty bits accumulate. Since there is one bit per market, this is bounded.
- **On reconnect:** the next flush writes every market's current state, so Redis converges with no replay needed.

### Warm restore

At boot, the service runs `HGETALL` for every configured market, with an overall deadline of 500 ms.

- Restored entries are loaded into the reconciler's **display state only**, with `restored: true` and `stale: true`, and they never become eligible.
- REST `/price` for a market with only restored data returns `503 NO_ELIGIBLE_SOURCES` with `lastKnown` set to the restored value. Clients get "here's what it was" immediately on boot instead of nothing.
- Missing, malformed, or wrong-schema entries are ignored and counted.

## Postgres: Rolling History

### Schema (Drizzle definitions; partitioning in a hand-written SQL migration)

```sql
CREATE TABLE observations (
  ts           timestamptz      NOT NULL,   -- receivedAt (wall clock)
  mint         text             NOT NULL,
  source       text             NOT NULL,   -- e.g. orca:<pool>, raydium:<pool>, jupiter, orca:route(...)
  price        double precision NOT NULL,
  size         double precision,
  slot         bigint,
  eligible     boolean          NOT NULL,
  reason       text
) PARTITION BY RANGE (ts);

CREATE TABLE consolidated (
  ts           timestamptz      NOT NULL,
  mint         text             NOT NULL,
  price        double precision NOT NULL,
  spread_bps   double precision NOT NULL,
  n_sources    smallint         NOT NULL,
  degraded     boolean          NOT NULL,
  disagreement boolean          NOT NULL,
  slot         bigint,
  sources      text[]           NOT NULL
) PARTITION BY RANGE (ts);

-- per partition: index on (mint, ts)
```

- **No primary key.** These are append-only time-series rows with no natural unique key, and a surrogate key would cost index maintenance for nothing. Queries are always `mint + time range`, served by the `(mint, ts)` index.
- **`double precision`, not `numeric`.** Prices are computed as f64. `numeric` would imply precision the computation doesn't have, and it is slower to aggregate.

### Partition management

- Partitions are **daily**: `observations_YYYYMMDD` and `consolidated_YYYYMMDD`.
- **At boot, and then hourly**, the maintenance task:
  - ensures partitions exist for today plus the next 2 days (`CREATE TABLE IF NOT EXISTS … PARTITION OF … FOR VALUES FROM … TO …`);
  - drops partitions entirely older than `HISTORY_RETENTION_DAYS`.
- A `DEFAULT` partition catches rows that fall outside every daily partition, for example after clock skew. The task counts its rows and logs them, and it never drops the `DEFAULT` partition.
- Maintenance takes a Postgres advisory lock, so two instances, if ever run, don't race.

### Write policy: bounded batch writer

- **Two in-memory ring buffers**, one for observations and one for consolidated rows. Each holds `PG_QUEUE_MAX` rows (default 50,000).
- **Flush trigger:** a buffer reaches `PG_BATCH_ROWS` (default 1,000), or `PG_FLUSH_MS` (default 250 ms) elapses with rows pending.
- **Insert method:** a multi-row parameterized `INSERT … VALUES (…),(…)`, through the `pg` pool (`max: 4`). There is one flush in flight per table at a time.
- **Overflow:** when a buffer is full, the **oldest** row is dropped and `soltape_persist_dropped_total{sink}` is incremented. Recent history is worth more than old history to a live system.
- **Failure:** a failed batch is retried once after 1 s. If the retry fails, the batch is dropped and counted, and the sink is marked `down` until a later batch succeeds. Retrying forever would let a dead database pin memory.

### What gets written

- **Observations:** every observation whose price, eligibility, or reason changed. Unchanged revalidations are not written.
- **Consolidated:** every emitted consolidated update (after change detection).

Expected live volume is about 5 markets × 3 venues at a few changes per second, i.e. tens of rows per second, or a few million rows per day. That fits easily under 7-day retention. Replay benchmarks at 10k updates/s exercise the bounded queue, which is the point.

### Migrations

- **Drizzle-kit** generates migrations from the table definitions. The partition DDL and `DEFAULT` partitions are a hand-written SQL migration.
- **At boot**, migrations run under an advisory lock before the history sink is marked `up`. A migration failure leaves history `down` and doesn't stop the feed. It is logged at `error` level.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Redis write model | Dirty bitmap, periodic pipelined flush of current state | Write per update; Redis Streams | Constant cost however fast updates come. Streams would be a log, and only the latest value is wanted. |
| Redis offline queue | Disabled; recover by full rewrite on reconnect | ioredis default offline queue | The default buffers commands without limit while disconnected. A full rewrite on reconnect is bounded and correct. |
| Restored data eligibility | Display only, never eligible | Treat as fresh until replaced | A restart can be hours later, and serving restored prices as live would be lying. |
| History retention | Daily range partitions, drop old partitions | `DELETE WHERE ts < …`; TimescaleDB | Dropping a partition is constant-cost with no bloat or vacuum pressure. TimescaleDB is a heavier dependency for features that aren't needed here. |
| Insert path | Batched multi-row `INSERT` | `COPY`, per-row inserts | Multi-row `INSERT` through Drizzle/`pg` is simple, and at this volume is far below Postgres's limits. `COPY` (`pg-copy-streams`) is the optimization-loop upgrade if the benchmark shows flush cost. |
| Overflow policy | Drop oldest, count | Block producers; drop newest | Producers are on the hot path and must never block. Newer rows are more valuable. |
| Primary keys | None (time-series append) | Surrogate `bigserial` | No reads by row id. Saves an index per partition. |
| Numeric type | `double precision` | `numeric(38,18)` | Matches computed precision, and is faster to aggregate. |

## Open Questions & Future Decisions

### Resolved
1. ✅ The history endpoint reads `consolidated` only. `observations` is for offline analysis and debugging.
2. ✅ Persistence state appears in `/health.dependencies` and never changes `status`.

### Deferred
1. `COPY`-based ingest if flush latency matters under benchmark load.
2. A Redis pub/sub channel for horizontal read replicas (HLD non-goal).

## References

- HLD: KDD-9
- Postgres declarative partitioning; `pg_advisory_lock`
- ioredis: `enableOfflineQueue`, `maxRetriesPerRequest`
