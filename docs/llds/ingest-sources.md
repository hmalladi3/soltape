# Ingest Sources

## Context and Design Philosophy

Source adapters are where the outside world enters the system. They own every connection lifecycle concern and nothing else: connect, subscribe, prove liveness, reconnect, fill gaps, validate. Each adapter turns raw input into the unified tick (HLD "Unified tick schema") and hands it to the reconciler. Adapters never decide eligibility. They report facts (*this is the price as of slot S*, *my connection is down*), and the reconciler decides what counts.

Principles:
- **Every failure is a state, not an exception.** A dropped socket, a 429, a malformed frame, or a timeout each becomes a state transition or a counted rejection.
- **No gap is silent.** After any (re)connect, the adapter takes a fresh snapshot instead of waiting for the next trade.
- **Hot path is allocation-light.** RPC account notifications go from socket to decoder to reconciler without `JSON.parse` and without creating per-frame objects in the adapter.

HLD refs: KDD-2, KDD-3, KDD-4, KDD-7.

## Adapter Interface

```ts
interface PriceSource {
  readonly id: SourceId;                   // 'orca' | 'raydium' | 'jupiter'
  start(): Promise<void>;                  // resolves once the first connect is attempted, not when connected
  stop(): Promise<void>;
  // Reports go to the injected SourceSink (the reconciler), not via return values:
  //   sink.onPoolUpdate(poolIndex, sqrtRatio, liquidity, slot, recvTs)  — on-chain
  //   sink.onQuote(marketIndex, priceInQuote, slot | null, recvTs)      — Jupiter
  //   sink.onSourceState(sourceId, state, reason?)
  //   sink.onSlot(sourceId, slot, recvTs)                               — liveness signal
}
```

Pools and markets are referred to by **dense integer indexes** assigned at startup from `markets.json`. The reconciler holds fixed arrays indexed by them, so the hot path performs no `Map` lookups by string.

### Source states

| State | Meaning |
|---|---|
| `disabled` | Not configured (e.g. Jupiter without an API key). Never retried. |
| `connecting` | Opening the socket or performing initial validation. |
| `live` | Connected, subscriptions confirmed, liveness signal current. |
| `stale` | Connected, but the liveness signal is late beyond the threshold (see `reconciliation.md`). |
| `down` | Disconnected, waiting on backoff to reconnect. |

The adapter owns the `connecting`, `live`, and `down` transitions. The source registry (in `reconciliation.md`) derives `stale` from liveness timestamps, so a single place decides staleness.

## RPC WebSocket Adapter (Orca, Raydium)

There is one instance per on-chain venue, and each has **its own WebSocket connection**, so the venues are separate failure domains: a stalled Raydium subscription can't make Orca look stale. The same class serves both venues, parameterised by venue (program id and layout).

### Boot validation (cold path)

1. `getMultipleAccounts` (HTTP, `base64`) for every pool of this venue.
2. Each account is decoded with `decoder.decodeAccount(data, venue)`, which returns the full pool info: mints, decimals where present, sqrt price, liquidity, and tick.
3. The account **owner** must equal the venue's program id, and the decoded mints must match the market or route leg declared in `markets.json`. Any mismatch is fatal (see `service-runtime.md`).
4. Mint decimals:
   - Raydium CLMM stores both decimals in the pool.
   - Whirlpool doesn't, so `getMultipleAccounts` on the mints reads SPL Mint `decimals` (byte offset 44). That offset is the same for Token-2022 mints, since the base layout is shared.
   - Decimals are fetched once and treated as immutable.
5. Orientation: for each pool, record whether the quote is token B/1 (`price = ratio²·10^(dA−dB)`) or token A/0 (inverted).
6. The snapshot values are emitted as the first `onPoolUpdate`, tagged with the snapshot's `context.slot`.

### Subscriptions

- `slotSubscribe` provides the venue's liveness heartbeat (HLD KDD-4). Slot notifications come every ~400 ms on a healthy connection.
- `accountSubscribe(pool, { encoding: "base64", commitment })` for each pool.
- Subscription confirmations (`{"result": <subId>, "id": <reqId>}`) map `subId → poolIndex` in a small `Map<number, number>`, which is rebuilt on every reconnect.

### Hot path

Every WebSocket `message` event goes through these steps:

1. `ws` delivers the frame as a `Buffer`, with no `toString` call.
2. `kind = decoder.decodeNotification(buf, out)`. `out` is one preallocated `Float64Array` per adapter (see `frame-decoder.md`).
3. Branch on `kind`:
   - **`ACCOUNT`:** look up `poolIndex` from the subscription id (an unknown id is counted and ignored), then call `sink.onPoolUpdate(poolIndex, out[SQRT], out[LIQ], out[SLOT], recvTs)`.
   - **`SLOT`:** `sink.onSlot(id, out[SLOT], recvTs)`.
   - **`OTHER`:** cold path. `JSON.parse` the frame and handle subscription confirmations and JSON-RPC errors.
   - **Negative (decode error):** count by code, log with rate limiting, and mark the pool *suspect* if the subscription id was recoverable (`out[SUB] ≥ 0`). The decoder writes the subscription id before failing on payload errors where it can.

`recvTs` is taken with `performance.now()` as the first statement in the handler (see `telemetry.md`).

### Slot ordering

Per pool, an update whose slot is **lower** than the last accepted slot is dropped and counted (`out_of_order`). This prevents snapshot/notification races after a reconnect from moving the price backwards. An equal slot is accepted, because several transactions in the same slot can each update the account, and notifications for one slot arrive in order on a single connection.

### Revalidation of quiet pools

A pool with no notification for `REVALIDATE_AFTER_MS` (default 20 s) is re-read with `getMultipleAccounts`, batched across all quiet pools of the venue.

- **Read succeeds:** the result is emitted as a normal update at its slot. Unchanged data at a newer slot is exactly what proves a quiet pool is still correct.
- **Read fails:** nothing is emitted, and the observation ages toward its hard expiry (see `reconciliation.md`).
- **Rate:** at most one revalidation batch per venue in flight at a time.

### Reconnect

- **Triggers:**
  - socket `close` or `error`
  - no pong received within 10 s of a ping (pings every 15 s)
  - the source registry reporting the venue stale for longer than `RECONNECT_ON_STALE_MS` (default 10 s), which catches connections that are open but silently dead
- **Backoff:** full-jitter exponential, `delay = random(0, min(30 s, 250 ms · 2^attempt))`. The attempt counter resets once a connection has stayed `live` for 60 s.
- **On reconnect:**
  1. Clear the `subId` map.
  2. Resubscribe `slotSubscribe` first, then every pool.
  3. Once all confirmations arrive, take a fresh `getMultipleAccounts` snapshot, subject to the slot ordering guard, then go `live`.
- **During `down`:** the adapter emits `onSourceState(down)`. Its last observations remain in the reconciler but are ineligible while the source is down (see `reconciliation.md`).

### Rate-limit awareness

The public mainnet RPC rate-limits by IP. Steady state makes no HTTP calls except revalidation, which is batched, at most once per 20 s per venue. On an HTTP 429, the adapter honours `Retry-After` if present, otherwise it backs off with the same jittered schedule.

## Jupiter Adapter

Enabled only when `JUPITER_API_KEY` is set. Otherwise it is constructed in the `disabled` state and does nothing.

- **Polling:** one request per interval for all tracked mints plus the quote mint: `GET {JUPITER_URL}?ids=<mint1,…,USDC>` with header `x-api-key`. Default interval 2 s. The free-tier limit is the binding constraint here, and the interval is configurable.
- **Single-flight:** the next poll is scheduled when the previous one settles, never on a fixed `setInterval`, so slow responses never pile up.
- **Timeout:** 2 s via `AbortSignal.timeout`. A timeout counts as a failed poll.
- **Validation:** the response goes through a zod schema, `Record<mint, { usdPrice: number > 0, blockId?: number | null, decimals?: number }>`. Each entry is validated on its own. An entry that fails, or that is missing, means no update for that mint this round, and that observation ages normally. A response where the whole body fails validation counts as a failed poll.
- **Quote conversion (HLD KDD-6):** `priceInUsdc = usdPrice[mint] / usdPrice[USDC]`, using both values from the same response. If the USDC entry is missing or invalid, the whole poll yields no updates, because nothing can be converted.
- **Slot:** `blockId` is used when present, otherwise `null`.
- **Liveness:** each successful poll calls `sink.onSlot('jupiter', blockId ?? null, recvTs)`. Liveness for Jupiter means "the last successful poll is recent" (see `reconciliation.md`).
- **States:** the first success moves `connecting → live`. A failure marks `down` only after `JUPITER_FAILS_TO_DOWN` (default 3) consecutive failures, since one timeout is noise.
- **429 handling:** honour `Retry-After`, and otherwise double the interval up to 30 s. The interval decays back after successes.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Connections | One WS connection per on-chain venue | One shared connection | Separate failure domains, so one venue's stall can't mark the other stale. Costs one extra socket. |
| Liveness signal | `slotSubscribe` on the same connection | WS ping/pong only; time since last account update | Ping/pong proves the TCP path works, not that notifications are flowing. Slot notifications prove the node is actively pushing on this connection (HLD KDD-4). Both are used. |
| Gap handling | Snapshot after every (re)subscribe, plus a slot ordering guard | Wait for the next notification | Quiet pools might not update for minutes, so the snapshot makes recovery immediate. The guard makes the race between snapshot and notification harmless. |
| Quiet pools | Batched revalidation reads after 20 s | Expire them; poll everything constantly | Keeps correct-but-quiet pools eligible at negligible RPC cost. |
| Hot-path parsing | Raw `Buffer` → native decoder; `JSON.parse` only for `OTHER` frames | `JSON.parse` everything | HLD KDD-2. Control frames are rare, and account frames are the volume. |
| Pool identity in hot path | Integer index via `subId → poolIndex` | Map keyed by address string | Notifications don't carry the account address anyway, only the subscription id. An integer index keeps reconciler state in arrays. |
| Backoff | Full-jitter exponential, cap 30 s, reset after 60 s stable | Fixed delay; exponential without jitter | Full jitter avoids synchronized reconnect storms against a shared public RPC. The stability reset stops a flapping link from settling at short delays. |
| Jupiter scheduling | Single-flight `setTimeout` chain | `setInterval` | Never more than one request in flight, and slow responses never queue up. |
| Jupiter `down` | After 3 consecutive failures | First failure | A single timeout is common on free tiers. Flapping states would make attribution noisy. Hard observation expiry still bounds staleness. |

## Open Questions & Future Decisions

### Resolved
1. ✅ Jupiter quote conversion uses the USDC entry from the same response (HLD KDD-6).
2. ✅ An equal slot is accepted, and only a lower slot is rejected.

### Deferred
1. Whether public mainnet `accountSubscribe` honours `dataSlice`. If it does, subscribing only to the price-bearing byte range would cut frame size about 10×. Measure during implementation. The decoder contract would need a sliced layout variant.
2. The exact pool addresses for each market are chosen during implementation and committed to `markets.json`. Boot validation guards correctness.
3. A Geyser/Yellowstone adapter behind the same `PriceSource` interface (HLD non-goal for now).

## References

- Solana WebSocket API: `accountSubscribe`, `slotSubscribe`. HTTP: `getMultipleAccounts`.
- Jupiter Price API v3: https://developers.jup.ag/docs/price/v3
- AWS Architecture Blog, "Exponential Backoff and Jitter" (full jitter)
