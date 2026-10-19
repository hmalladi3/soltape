# API Gateway — EARS Specs

LLD: `docs/llds/api-gateway.md`

## Common

- [ ] **API-HTTP-001**: The system shall serve REST, the live page, and WebSocket upgrades on path `/ws` from a single HTTP server on the configured port.
- [ ] **API-HTTP-002**: When a REST request's `:mint` parameter matches a configured market symbol (case-insensitive), the system shall resolve it to that market.
- [ ] **API-HTTP-003**: If a REST `:mint` parameter is neither a configured symbol nor a base58 encoding of exactly 32 bytes, then the system shall respond `400` with error code `INVALID_MINT`.
- [ ] **API-HTTP-004**: If a REST `:mint` parameter is a valid base58 address that is not a tracked mint, then the system shall respond `404` with error code `MINT_NOT_TRACKED`.
- [ ] **API-HTTP-005**: The system shall return every REST error as `{ "error": { "code", "message", "requestId" } }`.
- [ ] **API-HTTP-006**: If a REST handler fails with an unexpected error, then the system shall respond `500` with error code `INTERNAL` and a request id, and log the error at `error` level.
- [ ] **API-HTTP-007**: The system shall serve all REST endpoints except `/history` from in-memory state, without querying Redis or Postgres.

## REST Endpoints

- [ ] **API-REST-001**: When `GET /price/:mint` is requested for an available market, the system shall respond `200` with the consolidated price record: mint, symbol, quote, price, sources, excluded, spreadBps, degraded, disagreement, slot, updatedAt, seq.
- [ ] **API-REST-002**: When `GET /price/:mint` is requested for an unavailable market, the system shall respond `503` with error code `NO_ELIGIBLE_SOURCES` and a `lastKnown` field holding the last consolidated value (live or restored from Redis) marked `stale: true`, or null if none exists.
- [ ] **API-REST-003**: When `GET /sources/:mint` is requested, the system shall respond `200` with one entry per configured venue of that market, eligible or not. Each entry gives source, venue, kind, source state, price, size, slot, receivedAt, ageMs, eligible, and reason. Route entries also list their legs, and restored entries include `restored: true`.
- [ ] **API-REST-004**: When `GET /mints` is requested, the system shall respond `200` with every tracked market's mint, symbol, and configured venues.
- [ ] **API-REST-005**: When `GET /history/:mint` is requested with a valid `window` and a `bucket` of `1s`, `10s`, `1m`, `5m`, or `1h`, the system shall respond `200` with open, high, low, close, and sample count per non-empty bucket from consolidated history, together with the effective `from`, `to`, `bucket`, and `clamped` fields.
- [ ] **API-REST-006**: If a `GET /history/:mint` request's `window` extends beyond the retention period, then the system shall clamp the range to the oldest retained data and set `clamped` to true.
- [ ] **API-REST-007**: If a `GET /history/:mint` request has an unrecognised `window` or `bucket`, or would produce more than 2,000 buckets, then the system shall respond `400` with error code `INVALID_QUERY`.
- [ ] **API-REST-008**: If Postgres is unreachable, or the history query exceeds 2 seconds, while serving `GET /history/:mint`, then the system shall respond `503` with error code `HISTORY_UNAVAILABLE`.
- [ ] **API-REST-009**: When `GET /stats` is requested, the system shall respond `200` with:
  - internal latency p50, p99, and p99.9
  - update rate
  - source states
  - decoder implementation
- [ ] **API-REST-010**: When `GET /metrics` is requested, the system shall respond `200` with all registered metrics in Prometheus text exposition format.

## Health

- [ ] **API-HLTH-001**: When `GET /health` is requested, the system shall respond with:
  - overall status
  - uptime
  - decoder implementation
  - per-source state with last event age
  - Redis and Postgres state
  - available and unavailable market counts
  - misconfigured pools
- [ ] **API-HLTH-002**: The system shall report health status `ok` (HTTP 200) while every enabled source is live, every market is available, and no pool is misconfigured.
- [ ] **API-HLTH-003**: The system shall report health status `degraded` (HTTP 200) while at least one market is available and any enabled source is not live, any market is unavailable, or any pool is misconfigured.
- [ ] **API-HLTH-004**: The system shall report health status `down` (HTTP 503) while no market is available, outside the startup grace period and shutdown.
- [ ] **API-HLTH-005**: The system shall exclude `disabled` sources and Redis or Postgres state from the computation of health status.

## WebSocket Protocol

- [ ] **API-WS-001**: When a WebSocket client sends `subscribe` with a list of mints or symbols, the system shall add each valid entry not already subscribed, reply `subscribed` with the resolved mint addresses, then send per newly subscribed market either a `snapshot` or, if the market is unavailable, an `unavailable` message.
- [ ] **API-WS-002**: When a WebSocket client sends `subscribe` with `["*"]`, the system shall subscribe it to every tracked market.
- [ ] **API-WS-003**: When a WebSocket client subscribes to a mint it is already subscribed to, or unsubscribes from one it is not subscribed to, the system shall treat that entry as a no-op.
- [ ] **API-WS-004**: If a WebSocket `subscribe` request contains invalid or untracked entries, then the system shall apply the valid entries and send a single `error` message with code `INVALID_MINTS` listing each rejected entry with its reason.
- [ ] **API-WS-005**: When a WebSocket client sends `unsubscribe`, the system shall remove the listed mints and reply `unsubscribed`.
- [ ] **API-WS-006**: When a WebSocket client sends `{"op":"ping"}`, the system shall reply `{"type":"pong"}`.
- [ ] **API-WS-007**: When a consolidated update is emitted for a market, the system shall send subscribers of that market a `price` message containing the consolidated record (including `seq`) and its `trigger`.
- [ ] **API-WS-008**: When a market becomes unavailable, the system shall send its subscribers an `unavailable` message with `lastKnown`.
- [ ] **API-WS-009**: The system shall disable `permessage-deflate` on the WebSocket server.

## WebSocket Policing

- [ ] **API-WS-020**: If a WebSocket client message exceeds 4 KiB, then the system shall close the connection with code 1009.
- [ ] **API-WS-021**: If a WebSocket client's subscriptions would exceed 100 mints, then the system shall apply subscriptions up to the limit and send an `error` message with code `TOO_MANY_SUBSCRIPTIONS`.
- [ ] **API-WS-022**: If a WebSocket client sends a message that is not valid JSON or not a recognised operation, then the system shall send an `error` message with code `BAD_MESSAGE` and count one strike. A request that is only partly invalid (API-WS-004) also counts one strike.
- [ ] **API-WS-023**: If a WebSocket client accumulates 10 strikes, then the system shall close the connection with code 1008.
- [ ] **API-WS-024**: The system shall send a WebSocket protocol ping to each client every 30 seconds, and if no pong arrives before the next ping, then the system shall terminate that connection.

## Fan-out and Backpressure

- [ ] **API-FAN-001**: When a consolidated update is emitted, the system shall serialize the outbound message once into a single `Buffer` and send that same `Buffer` to every subscriber.
- [ ] **API-FAN-002**: While a WebSocket client's `bufferedAmount` exceeds 256 KiB, the system shall hold that client's updates in a per-market pending slot that keeps only the newest update for each market, and count each overwritten or deferred update as conflated.
- [ ] **API-FAN-003**: When a congested WebSocket client's `bufferedAmount` falls to 64 KiB or below, the system shall send its pending updates within 10 ms, in market order, and clear its congested state.
- [ ] **API-FAN-004**: If a WebSocket client remains congested continuously for 10 seconds, then the system shall close it with code 1013 and increment the slow-disconnect counter.

## Live Page

- [ ] **API-UI-001**: When `GET /` is requested, the system shall serve a single self-contained HTML live page that requires no build step.
- [ ] **API-UI-002**: While open, the live page shall show one row per tracked market with:
  - consolidated price, highlighted on change
  - contributing sources, and excluded sources with reasons
  - spread
  - degraded and disagreement indicators
  - slot
  - time since last update
- [ ] **API-UI-003**: When a market row is expanded, the live page shall show that market's per-source breakdown from `GET /sources/:mint`, refreshed every second while expanded.
- [ ] **API-UI-004**: While open, the live page shall poll `GET /stats` every second and show internal latency percentiles, update rate, source states, and decoder implementation.
- [ ] **API-UI-005**: If the live page's WebSocket closes, then the live page shall show a disconnected banner and reconnect with backoff.
- [ ] **API-UI-006**: The live page shall follow the browser's `prefers-color-scheme` for light and dark themes.

## Deferred

- [D] **API-WS-030**: Where a client requests binary encoding, the system shall send updates in a fixed-layout binary format.
- [D] **API-WS-031**: Where a client sets a per-mint rate cap, the system shall limit that client's updates per mint to the cap.
- [D] **API-UI-020**: The system shall provide a React dashboard as an alternative to the live page.
