# Telemetry

## Context and Design Philosophy

Telemetry exists so that every claim in the README (latency, throughput, resilience) can be checked from the running system. Measuring must not change what it measures. The hot path records timestamps as plain numbers into preallocated slots, histogram updates are O(1) without allocation, and logging never happens per tick.

HLD refs: KDD-10, Goal 5.

## Latency Stamps

### Clock

`performance.now()` is a monotonic double in milliseconds with sub-microsecond resolution in Node, and it **does not allocate**.

`process.hrtime.bigint()` allocates a `BigInt` per call. On a path stamped four times per tick, that is avoidable GC pressure, so the hot path uses `performance.now()`. `hrtime.bigint()` is reserved for the benchmark harness, which needs a clock shared across processes (see `replay-and-benchmark.md`).

Wall-clock time (`receivedAt`, persisted `ts`) comes from `Date.now()`, taken at the same moment as `t0`. It is never derived from `performance.timeOrigin + performance.now()`, because the two clocks drift apart over a long uptime, and NTP corrections apply to one of them but not the other.

### Stages

| Stamp | Taken at | Where it's held |
|---|---|---|
| `t0 recv` | First statement of the WS `message` handler / Jupiter response arrival | adapter local → passed as `recvTs` |
| `t1 decoded` | After `decodeNotification` returns | adapter local |
| `t2 reconciled` | After consolidation and change detection | reconciler, on the consolidated record |
| `t3 sent` | After the last `ws.send` of the fan-out loop for that update | gateway |

### Histograms

| Histogram | Stage | Labels |
|---|---|---|
| `soltape_decode_seconds` | `t1 − t0` | `venue` |
| `soltape_reconcile_seconds` | `t2 − t1` | — |
| `soltape_fanout_seconds` | `t3 − t2` | — |
| `soltape_internal_latency_seconds` | `t3 − t0` | `venue` (`orca`, `raydium`, `jupiter`, `sweep`) |

- `t3 − t0` is the **headline internal latency**. It is recorded only for inputs that produced an emitted update. Suppressed no-change inputs are counted separately (`soltape_updates_suppressed_total`).
- **Two recorders:**
  - **prom-client histograms** with fixed buckets `[5µs, 10µs, 25µs, 50µs, 100µs, 250µs, 500µs, 1ms, 2.5ms, 5ms, 10ms, 50ms]`, for `/metrics`.
  - **An HDR histogram** (`hdr-histogram-js`, 3 significant digits, 1 µs–10 s range) that is swapped every 10 s. It backs `/stats` and the live page's p50/p99/p99.9. Bucketed Prometheus histograms can't give an accurate p99.9 at microsecond scale, which HDR can.

## Collection Model

- **Hot path:** components only call `TelemetryHooks` (`decode`, `request`, `emitted`, `flush`). These are histogram observations on pre-resolved label children.
- **Counters:** never incremented on the hot path. Each counter is *derived at scrape time* from statistics the components already keep (adapter `stats`, gateway `stats`, reconciler `emittedCount` / `suppressedCount` / `outOfOrderCount`), and the collector increments it by the delta since the last scrape, so counters stay monotonic.
- **Gauges:** computed entirely at scrape time.
- **HTTP metrics:** labelled by Express route template (`/price/:mint`), never by raw path, so label values stay bounded.
- **Per-market metrics:** carry both `mint` and `symbol` labels. The values come from config, so cardinality doesn't grow.

## Metrics (`/metrics`)

Metric names are fixed here, because the README and benchmark refer to them.

**Per source**

| Metric | Type | Labels |
|---|---|---|
| `soltape_source_updates_total` | counter | `source` |
| `soltape_source_state` | gauge (1 for current state) | `source`, `state` |
| `soltape_source_liveness_age_seconds` | gauge | `source` |
| `soltape_source_reconnects_total` | counter | `source`, `cause` (`close`, `ping_timeout`, `stale`) |
| `soltape_source_request_seconds` | histogram | `source`, `op` (`jupiter_poll`, `snapshot`, `revalidate`) |
| `soltape_source_slot_lag` | gauge | `source` |
| `soltape_decode_errors_total` | counter | `source`, `code` |
| `soltape_updates_out_of_order_total` | counter | `source` |

`soltape_source_slot_lag` is the highest slot seen on the venue's `slotSubscribe` minus the slot of its most recent account update. It shows how far behind the chain head a venue's account data is.

**Per market**

| Metric | Type | Labels |
|---|---|---|
| `soltape_observation_age_seconds` | gauge | `mint`, `source` |
| `soltape_observation_eligible` | gauge | `mint`, `source` |
| `soltape_consolidated_sources` | gauge | `mint` |
| `soltape_consolidated_degraded` | gauge | `mint` |
| `soltape_consolidated_spread_bps` | gauge | `mint` |
| `soltape_consolidated_updates_total` | counter | `mint` |
| `soltape_updates_suppressed_total` | counter | `mint` |

**Pipeline**

- The four latency histograms listed above.
- `nodejs_eventloop_lag_*` via prom-client `collectDefaultMetrics` (backed by `monitorEventLoopDelay`), plus GC duration and heap metrics.
- `soltape_eventloop_delay_p99_seconds`: `monitorEventLoopDelay` reports the sampling interval *plus* lateness. Measured: about 10.6 ms at 10 ms resolution on an idle loop. This gauge samples at 1 ms, subtracts the interval, and resets on every scrape, so it reads as real delay since the last scrape. The benchmark's event-loop column and knee use it. The first benchmark run, using the default metric, reported a constant 11 ms that was pure resolution.

**Gateway**

| Metric | Type | Labels |
|---|---|---|
| `soltape_ws_clients` | gauge | — |
| `soltape_ws_messages_sent_total` | counter | — |
| `soltape_ws_conflated_total` | counter | — |
| `soltape_ws_slow_disconnects_total` | counter | — |
| `soltape_http_requests_total` | counter | `route`, `status` |
| `soltape_http_request_seconds` | histogram | `route` |

**Persistence**

| Metric | Type | Labels |
|---|---|---|
| `soltape_persist_queue_depth` | gauge | `sink` |
| `soltape_persist_dropped_total` | counter | `sink` |
| `soltape_persist_flush_seconds` | histogram | `sink` |
| `soltape_persist_state` | gauge | `sink` |

The `sink` values are `redis`, `pg_observations`, and `pg_consolidated`.

**Cardinality:** labels are only `source`, `mint`, and bounded enums, all fixed by config at boot. There are no per-client or per-request labels.

**Gauge updates:** gauges that depend on time (ages, liveness) are computed in a prom-client `collect()` callback at scrape time, not on the hot path.

## Logging

- **pino** writes JSON to stdout through `pino.destination({ sync: false })`. That is a buffered, asynchronous write on the main thread through sonic-boom. Worker-thread transports aren't needed, since output goes to stdout for Docker.
- `pino-pretty` is used only in `pnpm dev`, never in the image.
- **What is logged:**
  - state transitions (source state, sink state, market available ↔ unavailable)
  - reconnects, with cause and attempt number
  - startup and shutdown steps
  - config errors
  - rate-limited errors
- **What is never logged:** every tick, every frame, every WebSocket message.
- **Rate limiting:** repeated errors with the same `(component, code)` key log the first occurrence, then a summary at most every 10 s (`"decode_error BAD_LENGTH x 412 in last 10s"`). A malformed-frame storm can't flood stdout or slow the event loop.
- **Standard fields:** `component`, `source`, `mint`, `code`, `err`. HTTP requests are logged at `debug` with `requestId`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Hot-path clock | `performance.now()` | `process.hrtime.bigint()` | No allocation, sub-µs resolution, monotonic. |
| Percentiles | prom-client buckets for scraping + HDR for exact p99.9 | Prometheus only; summaries | Buckets give scrape-friendly aggregates. HDR gives accurate tails at microsecond scale. prom-client summaries compute quantiles on every observation, which costs more. |
| Time-dependent gauges | Computed at scrape via `collect()` | Updated on every tick | Zero hot-path cost. |
| Logging transport | pino async destination to stdout | pino worker transport; winston | The container collects stdout. sonic-boom buffering is enough, and a worker thread adds nothing here. |
| Error log flood control | Per-key rate limit + periodic summary | Log everything; sample randomly | Logs stay bounded during malformed-frame storms, with no loss of counts (metrics hold the exact numbers). |

## Open Questions & Future Decisions

### Resolved
1. ✅ Headline latency is `t3 − t0` for emitted updates only. Suppression is reported separately.

### Deferred
1. OpenTelemetry tracing export (HLD KDD-11 chose prom-client). Revisit only if multi-service.

## References

- HLD: KDD-10
- prom-client: https://github.com/siimon/prom-client
- HdrHistogram / hdr-histogram-js
- pino: https://getpino.io
