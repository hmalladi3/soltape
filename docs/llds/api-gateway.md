# API Gateway

## Context and Design Philosophy

The gateway is the only surface consumers see: REST for point reads, WebSocket for streams, and a static live page that is a plain client of both. It reads the reconciler's in-memory state and never Redis or Postgres, except for history, which reads Postgres by definition.

Principles:
- **The WebSocket is the hot path. REST is not.** Fan-out is engineered for latency and backpressure. REST is engineered for clarity and correct error shapes.
- **Conflate, never queue** (HLD KDD-8). Each client holds at most one pending update per mint.
- **Serialize once.** An update is encoded into one `Buffer` and sent to every subscriber.
- **Malformed client input never closes a connection on the first offence and never throws.**

HLD refs: KDD-8, KDD-9, KDD-12.

## HTTP Server

A single Node `http.Server` hosts both Express 5 (REST, static files) and `ws` (`WebSocketServer({ noServer: true })`, upgraded on path `/ws`). Express 5 handles rejected promises from async handlers natively. A single error-handling middleware maps typed errors to the error shape below, and any unexpected error becomes a `500` with a request id, logged at `error`.

### Mint resolution

Every `:mint` parameter accepts either a **base58 mint address** or a **configured symbol**, case-insensitive (`SOL`, `sol`). This lets reviewers run `curl localhost:8080/price/SOL`. Resolution:

1. Is it a configured symbol? → market.
2. Is it valid base58 decoding to 32 bytes? If not → `400 INVALID_MINT`.
3. Is it a tracked mint? → market, otherwise `404 MINT_NOT_TRACKED`.

### Error shape

```json
{ "error": { "code": "MINT_NOT_TRACKED", "message": "Mint So111… is not tracked", "requestId": "…" } }
```

## REST Endpoints

| Endpoint | Success | Errors |
|---|---|---|
| `GET /price/:mint` | `200` consolidated | `400 INVALID_MINT`, `404 MINT_NOT_TRACKED`, `503 NO_ELIGIBLE_SOURCES` |
| `GET /sources/:mint` | `200` per-source breakdown | `400`, `404` |
| `GET /mints` | `200` tracked markets with symbols and configured venues | — |
| `GET /history/:mint?window=1h&bucket=1m` | `200` bucketed history | `400 INVALID_QUERY`, `404`, `503 HISTORY_UNAVAILABLE` |
| `GET /health` | `200` (`ok`/`degraded`/`starting`) | `503` (`down`/`stopping`) |
| `GET /stats` | `200` latency percentiles JSON (for the live page) | — |
| `GET /metrics` | `200` Prometheus text format | — |
| `GET /` | the live page | — |

### `GET /price/:mint`

```json
{
  "mint": "So11111111111111111111111111111111111111112",
  "symbol": "SOL",
  "quote": "USDC",
  "price": 187.4213,
  "sources": ["orca:Czfq…", "raydium:…", "jupiter"],
  "excluded": [],
  "spreadBps": 3.1,
  "degraded": false,
  "disagreement": false,
  "slot": 372000123,
  "updatedAt": "2026-10-19T14:02:11.482Z",
  "seq": 48211
}
```

A `503 NO_ELIGIBLE_SOURCES` response still includes `lastKnown`: the last consolidated value with `stale: true` and its `updatedAt`, or `null` if none exists. That way a consumer knows both that the price is unavailable *and* what it last was.

### `GET /sources/:mint`

Returns one entry per configured venue, eligible or not:

```json
{ "mint": "…", "symbol": "SOL", "sources": [
  { "source": "orca:Czfq…", "venue": "orca", "kind": "pool", "sourceState": "live",
    "price": 187.43, "size": 412000.5, "slot": 372000123, "receivedAt": "…", "ageMs": 180,
    "eligible": true, "reason": null },
  { "source": "jupiter", "venue": "jupiter", "kind": "aggregator", "sourceState": "disabled",
    "price": null, "size": null, "slot": null, "receivedAt": null, "ageMs": null,
    "eligible": false, "reason": "source_disabled" }
]}
```

A route entry includes `legs: [{ pool, price, slot, ageMs }]`. A warm-restored value with no live data carries `restored: true`.

### `GET /history/:mint`

This endpoint reads consolidated history from Postgres, bucketed with `date_bin`. Each bucket returns `open`, `high`, `low`, `close`, and `samples`.

- The response is `{ mint, symbol, from, to, bucket, clamped, buckets: [...] }`. `from` and `to` are the effective range actually queried.
- Buckets with no samples are **omitted**, not zero-filled, so a gap in the data shows up as a gap in the series.
- A `window` reaching back past retention is clamped to the oldest retained day, with `clamped: true`. That is not an error.
- No data in range → `200` with `buckets: []`.

- `window`: up to the retention period.
- `bucket`: one of `1s, 10s, 1m, 5m, 1h`.
- The result may contain at most 2,000 buckets, and `400` if exceeded.
- Postgres unreachable → `503 HISTORY_UNAVAILABLE`.

This is the only endpoint that touches a database. It has its own query timeout of 2 s.

### `GET /health`

```json
{ "status": "degraded", "uptimeS": 341, "decoder": "native",
  "sources": [{ "id": "orca", "state": "live", "lastEventAgeMs": 120 },
              { "id": "raydium", "state": "stale", "lastEventAgeMs": 2400 },
              { "id": "jupiter", "state": "disabled" }],
  "dependencies": { "redis": "up", "postgres": "down" },
  "markets": { "available": 5, "unavailable": 0 } }
```

| Status | HTTP | When |
|---|---|---|
| `starting` | 200 | Within the startup grace period (see `service-runtime.md`) |
| `ok` | 200 | Every enabled source is live and every market is available |
| `degraded` | 200 | At least one market is available, but some enabled source isn't live or some market is unavailable |
| `down` | 503 | No market has an eligible source |
| `stopping` | 503 | Shutdown is in progress |

Pools marked `misconfigured` (see `ingest-sources.md`) are listed under `misconfigured: [{ pool, venue, reason }]` and make the status at least `degraded`.

A `disabled` source doesn't make the service degraded, because it was intentionally not configured. A Redis or Postgres outage shows up in `dependencies` and doesn't change `status` either, because the feed doesn't depend on them (HLD Goal 3).

## WebSocket Protocol (`/ws`)

All messages are JSON text frames, with `permessage-deflate` disabled.

### Client → server

| Message | Effect |
|---|---|
| `{"op":"subscribe","mints":["SOL","<mint>"]}` | Adds the mints. Replies with `subscribed`, then per mint a `snapshot`, or `unavailable` if that market currently has no consolidated price |
| `{"op":"unsubscribe","mints":[…]}` | Removes the mints. Replies with `unsubscribed` |
| `{"op":"subscribe","mints":["*"]}` | Subscribes to every tracked mint |
| `{"op":"ping"}` | Replies with `pong` (application-level, for browsers that can't send protocol pings) |

### Server → client

| Message | Shape |
|---|---|
| `snapshot` / `price` | `{"type":"price","data":<consolidated as in REST>, "trigger":{"source":"orca:…","slot":N}}`. `snapshot` has the same shape and is sent on subscribe. |
| `unavailable` | `{"type":"unavailable","mint":…, "lastKnown":…}`, sent on the reconciler's `unavailable` event (a market losing its last eligible source), and on subscribe to a market that is currently unavailable |
| `subscribed` / `unsubscribed` | `{"type":"subscribed","mints":[resolved mint addresses]}` |
| `error` | `{"type":"error","code":"INVALID_MINT","message":…}` |

**Subscribe semantics:**
- Subscribing to an already-subscribed mint is a no-op: no duplicate snapshot and no error.
- If a request contains invalid or untracked entries, the valid ones are applied and listed in `subscribed`, and **one** `error` message lists the rejected entries with a reason each (`{"type":"error","code":"INVALID_MINTS","rejected":[{"mint":"…","reason":"MINT_NOT_TRACKED"}]}`). A partly invalid request counts as **one** strike, not one per entry.
- Unsubscribing from a mint that isn't subscribed is a no-op.

`trigger` lets a consumer, and the benchmark, attribute each update to the source frame that caused it (see `replay-and-benchmark.md`). `seq` in `data` increases per mint, so a client can detect conflation gaps (`seq` jumps), which are expected and not an error.

### Limits and policing

| Limit | Default | On violation |
|---|---|---|
| Max inbound message size | 4 KiB | `ws` `maxPayload` closes with code `1009` |
| Max mints per client | 100 | `error TOO_MANY_SUBSCRIPTIONS`; the subscription is partially applied up to the limit |
| Malformed messages | 10 strikes per connection | Each one sends `error BAD_MESSAGE`. After 10, close with code `1008` |
| Heartbeat | Protocol ping every 30 s | No pong before the next ping → `terminate()` |

## Fan-out and Backpressure

`onConsolidated(mktIdx, c)`:

1. Serialize once: `buf = Buffer.from(JSON.stringify({type:'price', data:c, trigger}))`.
2. For each subscriber of `mktIdx`, held in a per-market array of client handles:
   - If the client's `bufferedAmount ≤ WS_HIGH_WATER` (default 256 KiB), `ws.send(buf)`.
   - Otherwise, store `buf` in the client's **pending slot** for this market, overwriting any older pending update. That overwrite is the conflation. Mark the client `congested` with a timestamp and increment `soltape_ws_conflated_total`.
3. A `drainTimer` every 10 ms checks congested clients. Any client whose `bufferedAmount` has fallen to the low-water mark (default 64 KiB) gets its pending slots flushed in market order and leaves `congested`.
4. A client congested continuously for longer than `WS_SLOW_CLIENT_MS` (default 10 s) is closed with code `1013 Try Again Later`, and `soltape_ws_slow_disconnects_total` is incremented.

**Why poll `bufferedAmount`:** `ws` doesn't emit a per-socket drain event. A 10 ms timer that only visits congested clients costs nothing when clients are healthy, and with one slot per market, pending memory per client is bounded by `markets × ~400 B`.

**Frame once, write raw, cork per turn** (see `docs/perf.md`, iteration 1):
- Server-to-client frames are unmasked, so every subscriber receives byte-identical bytes. Each update is framed once (`Sender.frame`), and the same buffer is written straight to each client's socket.
- Every socket touched in an event-loop turn is corked, and all are uncorked together in `setImmediate`. N updates handled in one turn then reach each client in one system call, still as N separate WebSocket frames.
- Measured: −27% CPU per update one-at-a-time, −80% when 10 updates share a turn.
- Both are options (`preframe`, `corkPerTick`, default on), so the fan-out benchmark can A/B them.

**Implementation notes:**
- **Congestion is sticky until the low-water mark.** Once a client is congested, every update (price or `unavailable`) goes to its pending slot until `bufferedAmount` falls to the low-water mark. Sending directly while older frames are pending would deliver one market's updates out of order.
- **Control replies bypass conflation.** `subscribed`, `error`, and `pong` are never conflated, because they are answers rather than market data.
- **Text frames.** Frames are built with the text opcode, so clients receive text frames.
- **Kernel buffers absorb a burst first.** The server only sees congestion once the kernel's socket buffer (several MB on localhost) is full. A consumer that stops reading is therefore detected under a continuous feed, not from a single burst. The tests reproduce exactly that.

Memory bound: per client, at most `WS_HIGH_WATER + markets × frameSize`. With 1,000 clients that is about 256 MiB in the worst case, at which point clients are disconnected. The bound is stated in the README.

## Live Page

`apps/service/public/index.html` is a single file with inline CSS and JS, no framework, and no build step. Express serves it statically.

- On load it fetches `GET /mints` and opens `/ws` with `subscribe ["*"]`.
- **Design.** A cool slate palette (light and dark), system sans with tabular numerals, no web fonts (replay mode must work offline), and no framework. The one distinctive element is a **deviation strip** in each row: every source plotted as a dot by its distance in bps from the consolidated price (±50 bps scale), with excluded sources drawn hollow. Labels alternate above and below the axis, so neighbouring sources never collide. The strip shows reconciliation at work, which a plain price table cannot.
- The per-source data for the strips comes from polling `GET /sources/:mint` once per second for every market. That costs one cheap in-memory read per market per second, and keeps the WebSocket protocol free of a page-specific message.
- It shows a table with one row per market: consolidated price (highlighted on change), contributing and excluded sources with reason badges, spread, a degraded indicator, slot, and time since the last update.
- Clicking a row expands it into a per-source breakdown from `GET /sources/:mint`, refreshed every second while open.
- A header strip polls `GET /stats` every second and shows the internal p50/p99/p99.9 receive→send latency, update rate, connected sources, and decoder implementation (`native`/`reference`).
- Reconnect: if the socket closes, it retries with backoff, and shows a banner while disconnected.
- Dark and light colour scheme via `prefers-color-scheme`.

The page is one WebSocket subscriber among many, with no special path in the server.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| REST framework | Express 5 | Fastify, raw `http` | HLD KDD-11. REST reads from memory and isn't the hot path. Express 5 handles async errors natively. |
| WS server | `ws` with `noServer` on the shared HTTP server | uWS.js, socket.io, separate port | HLD KDD-8. One port keeps Docker and reviewer instructions simple. |
| Symbol aliases | Accept configured symbols as `:mint` | Base58 only | `curl …/price/SOL` is the first thing a reviewer types. Aliases come from config, so there's no ambiguity. |
| Unavailable price | `503` + `lastKnown` | `200` with stale data; `404` | 503 is honest, and `lastKnown` keeps it useful. A `200` carrying stale data is how consumers end up trading on dead prices. |
| Health semantics | `disabled` and DB outages don't degrade | Any failure degrades | Health reflects the feed's ability to serve prices, which is what an orchestrator or reviewer needs to know. |
| Backpressure | `bufferedAmount` high/low water + per-market pending slot + slow-client eviction | Unbounded queue; drop updates without conflation | Bounded memory and latency. A consumer always converges to the latest value. |
| Serialization | Once per update into a `Buffer` | Per-client `JSON.stringify` / string send | `ws` would otherwise convert the string to a Buffer on every send. With N subscribers this saves N−1 encodes. |
| History read | Postgres `date_bin` OHLC | Return raw rows; no history endpoint | Makes the Postgres history visible and useful, with output size bounded by the bucket count. |
| Live page | One static HTML file served by the service | React app (stretch), separate container | Works with zero build steps and nothing to host, so a reviewer sees it with one command (HLD KDD-12). |

## Open Questions & Future Decisions

### Resolved
1. ✅ `/stats` exists as JSON so the live page doesn't have to parse Prometheus text.
2. ✅ `seq` gaps are expected under conflation and documented as such.

### Deferred
1. A binary WebSocket encoding (e.g. fixed-layout) as an opt-in, if JSON encoding shows up in the fan-out profile.
2. Per-client rate caps (max N updates/s per mint) as an opt-in for slow dashboards.

## References

- `ws`: https://github.com/websockets/ws (`bufferedAmount`, `noServer`, `maxPayload`)
- RFC 6455 close codes: 1001, 1008, 1009, 1013
- Postgres `date_bin`
