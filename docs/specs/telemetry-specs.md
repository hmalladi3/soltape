# Telemetry — EARS Specs

LLD: `docs/llds/telemetry.md`

## Latency Stamps

- [ ] **OBS-LAT-001**: The system shall take pipeline stage timestamps (receive, decoded, reconciled, sent) with `performance.now()` and hold them as plain numbers, without allocating per stamp.
- [ ] **OBS-LAT-002**: When an RPC venue frame has been decoded, the system shall record the decode duration (decoded − receive) in histogram `soltape_decode_seconds` labelled by source.
- [ ] **OBS-LAT-003**: When a consolidated update is emitted, the system shall record:
  - reconcile duration (reconciled − decoded) in `soltape_reconcile_seconds`
  - fan-out duration (sent − reconciled, where "sent" is after the last `ws.send` for that update) in `soltape_fanout_seconds`
  - internal latency (sent − receive) in `soltape_internal_latency_seconds`, labelled by the triggering source
- [ ] **OBS-LAT-004**: The system shall record internal latency only for inputs that produced an emitted consolidated update.
- [ ] **OBS-LAT-005**: The latency histograms shall use buckets of 5 µs, 10 µs, 25 µs, 50 µs, 100 µs, 250 µs, 500 µs, 1 ms, 2.5 ms, 5 ms, 10 ms, and 50 ms.
- [ ] **OBS-LAT-006**: The system shall record internal latency in an HDR histogram (3 significant digits, 1 µs to 10 s) covering a rolling 10-second interval, and serve its percentiles through `/stats`.

## Metrics

- [ ] **OBS-MET-001**: The system shall expose these per-source metrics:
  - `soltape_source_updates_total`
  - `soltape_source_state`
  - `soltape_source_liveness_age_seconds`
  - `soltape_source_reconnects_total` (labelled by cause)
  - `soltape_source_request_seconds` (labelled by operation)
  - `soltape_source_slot_lag`
  - `soltape_decode_errors_total` (labelled by code)
  - `soltape_updates_out_of_order_total`
- [ ] **OBS-MET-002**: The system shall expose these per-market metrics:
  - `soltape_observation_age_seconds`
  - `soltape_observation_eligible`
  - `soltape_consolidated_sources`
  - `soltape_consolidated_degraded`
  - `soltape_consolidated_spread_bps`
  - `soltape_consolidated_updates_total`
  - `soltape_updates_suppressed_total`
- [ ] **OBS-MET-003**: The system shall expose these gateway metrics:
  - `soltape_ws_clients`
  - `soltape_ws_messages_sent_total`
  - `soltape_ws_conflated_total`
  - `soltape_ws_slow_disconnects_total`
  - `soltape_http_requests_total`
  - `soltape_http_request_seconds`
- [ ] **OBS-MET-004**: The system shall expose these persistence metrics, labelled by sink (`redis`, `pg_observations`, `pg_consolidated`):
  - `soltape_persist_queue_depth`
  - `soltape_persist_dropped_total`
  - `soltape_persist_flush_seconds`
  - `soltape_persist_state`
- [ ] **OBS-MET-005**: The system shall expose Node.js default metrics, including event-loop delay, GC duration, and heap usage.
- [ ] **OBS-MET-006**: The system shall compute time-dependent gauges (ages, liveness) at scrape time rather than on each update.
- [ ] **OBS-MET-007**: The system shall use only source, mint, and fixed enumerations as metric label values.
- [ ] **OBS-MET-008**: The system shall compute `soltape_source_slot_lag` for each RPC venue as the venue's highest slot-notification slot minus the slot of its most recent account update.

## Logging

- [ ] **OBS-LOG-001**: The system shall write structured JSON logs to stdout with pino using an asynchronous destination.
- [ ] **OBS-LOG-002**: The system shall log the following and nothing per frame, tick, or WebSocket message:
  - source, sink, and market state transitions
  - reconnects with cause and attempt
  - startup and shutdown steps
  - configuration errors
- [ ] **OBS-LOG-003**: When the same component and error code recur, the system shall log the first occurrence, then at most one summary line per 10 seconds stating the count.
- [ ] **OBS-LOG-004**: The system shall include `component` on every log line, and `source`, `mint`, `code`, and `err` fields where applicable.

## Deferred

- [D] **OBS-TRC-001**: The system shall export traces via OpenTelemetry.
