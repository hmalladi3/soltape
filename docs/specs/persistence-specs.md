# Persistence — EARS Specs

LLD: `docs/llds/persistence.md`

## Common

- [ ] **PER-COM-001**: When the reconciler notifies persistence of a consolidated update or observation change, the persistence components shall record the work in O(1) without awaiting I/O.
- [ ] **PER-COM-002**: While Redis or Postgres is unreachable, the system shall continue ingesting, reconciling, and serving REST and WebSocket traffic.

## Redis Latest Snapshot

- [ ] **PER-RDS-001**: When a market's consolidated value or any of its observations changes, or the market emits an `unavailable` event, the Redis latest store shall mark that market dirty.
- [ ] **PER-RDS-002**: Every 100 ms, if any market is dirty and no Redis flush is in flight, the Redis latest store shall write the current state of each dirty market to hash `soltape:v1:market:{mint}` in one pipeline, set a 24-hour expiry on each hash, and clear the written dirty marks. The hash holds `consolidated`, `src:{sourceId}` per source, and `updatedAt`.
- [ ] **PER-RDS-003**: The Redis client shall run with its offline queue disabled and at most one retry per request.
- [ ] **PER-RDS-004**: When the Redis connection is restored after an outage, the Redis latest store shall write the current state of every market on its next flush.
- [ ] **PER-RDS-005**: When the service starts, the Redis latest store shall read the stored hash of each currently configured market within a 500 ms overall deadline, and load the result as display-only state marked `restored: true` and `stale: true`.
- [ ] **PER-RDS-006**: If a restored Redis entry is malformed, has a different schema version, or refers to a source not currently configured, then the Redis latest store shall ignore that entry and increment a counter.

## Postgres History: Schema and Partitions

- [ ] **PER-PG-001**: The system shall store observation history in table `observations` and consolidated history in table `consolidated`, each range-partitioned by day on `ts`, with an index on `(mint, ts)` in every partition.
- [ ] **PER-PG-002**: The system shall store prices and sizes in history tables as `double precision`.
- [ ] **PER-PG-003**: After migrations have been applied, at startup, hourly thereafter, and each time a history sink transitions to `up` (before its first flush), the system shall ensure daily partitions exist for the current day and the next 2 days. It shall then drop every daily partition whose whole range is older than `HISTORY_RETENTION_DAYS`.
- [ ] **PER-PG-004**: The system shall keep a `DEFAULT` partition on each history table, shall never drop it, and shall report its row count when partition maintenance runs.
- [ ] **PER-PG-005**: If the `DEFAULT` partition holds rows within the range of a daily partition about to be created, then the system shall create that partition, move the matching rows into it, and attach it, all in one transaction.
- [ ] **PER-PG-006**: The system shall run partition maintenance and migrations under a Postgres advisory lock.
- [ ] **PER-PG-007**: When the history sink first connects, the system shall apply pending migrations before marking the sink `up`. If migration fails, the system shall log an error and leave history `down`, without affecting the live feed.

## Postgres History: Writer

- [ ] **PER-PG-010**: When an observation's price, eligibility, or reason changes, the history sink shall enqueue an `observations` row.
- [ ] **PER-PG-011**: When a consolidated update is emitted, the history sink shall enqueue a `consolidated` row. `unavailable` events produce no history row.
- [ ] **PER-PG-012**: When a history table's queue reaches 1,000 rows, or 250 ms have passed with rows pending, and no flush for that table is in flight, the history sink shall write the pending rows in one multi-row parameterized `INSERT`.
- [ ] **PER-PG-013**: If a history queue is full (50,000 rows) when a row is enqueued, then the history sink shall drop the oldest queued row and increment the dropped-rows counter for that sink.
- [ ] **PER-PG-014**: If a history flush fails, then the history sink shall retry it once after 1 second. If the retry also fails, it shall drop the batch, count the dropped rows, and mark the sink `down` until a later flush succeeds.
- [ ] **PER-PG-015**: The history writer's Postgres pool shall use at most 4 connections, a 2-second connection timeout, and a 5-second statement timeout.

- [ ] **PER-PG-016**: The system shall serve history reads from a Postgres pool separate from the history writer's, with at most 2 connections, so that reads never queue behind writes.

## Deferred

- [D] **PER-PG-020**: The history sink shall write batches with `COPY` instead of multi-row `INSERT`.
- [D] **PER-RDS-020**: The system shall publish consolidated updates on a Redis pub/sub channel for read replicas.
