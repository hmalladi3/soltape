# Ingest Sources — EARS Specs

LLD: `docs/llds/ingest-sources.md`

## Common

- [ ] **ING-SRC-001**: Each source adapter (Orca, Raydium, Jupiter) shall report updates, liveness signals, and its connection state to the reconciler through the injected source sink, and shall not decide observation eligibility.
- [ ] **ING-SRC-002**: Each source adapter shall identify pools and markets by integer indexes assigned at startup from the markets file.
- [ ] **ING-SRC-003**: When a source frame or response is received, the source adapter shall take a monotonic receive timestamp with `performance.now()` and a wall-clock receive timestamp with `Date.now()` as its first action, deriving neither from the other.

## RPC Venue Adapter (Orca and Raydium): Validation

- [ ] **ING-RPC-001**: When an RPC venue adapter starts or reconnects, it shall fetch all of its pools with `getMultipleAccounts` using `base64` encoding and the configured commitment.
- [ ] **ING-RPC-002**: When an RPC venue adapter validates a pool, it shall require the account owner to equal the venue's program id and the decoded mints to equal the mints declared for that pool or route leg in the markets file.
- [ ] **ING-RPC-003**: When an RPC venue adapter validates a Whirlpool pool, it shall read both mints' `decimals` from their SPL Mint accounts (byte offset 44) once and treat them as immutable. For Raydium CLMM pools it shall use the decimals stored in the pool account.
- [ ] **ING-RPC-004**: When an RPC venue adapter validates a pool, it shall record whether the quote side is token B/1 or token A/0 for use in price normalization.
- [ ] **ING-RPC-005**: If an RPC venue adapter first fetches a pool after startup has completed (because the source was unreachable at boot), and the pool fails owner or mint validation or the account does not exist, then the RPC venue adapter shall mark the pool `misconfigured`, never subscribe to it, and log an error, without exiting the process.
- [ ] **ING-RPC-006**: When an RPC venue adapter completes validation, it shall emit each validated pool's snapshot as a pool update tagged with the response's `context.slot`.

## RPC Venue Adapter: Subscriptions and Liveness

- [ ] **ING-RPC-010**: Each RPC venue adapter shall use its own WebSocket connection, separate from every other venue's.
- [ ] **ING-RPC-011**: When an RPC venue adapter connects, it shall send `slotSubscribe` before any `accountSubscribe`, then send `accountSubscribe` for each valid pool with `base64` encoding and the configured commitment.
- [ ] **ING-RPC-012**: When a subscription confirmation arrives, the RPC venue adapter shall map the returned subscription id to the pool index of the originating request.
- [ ] **ING-RPC-013**: If an `accountSubscribe` request receives no confirmation within 5 seconds or receives a JSON-RPC error, then the RPC venue adapter shall retry that pool's subscription up to 3 times with full-jitter backoff, counting failures by error code.
- [ ] **ING-RPC-014**: If a pool's subscription is still unconfirmed after all retries, then the RPC venue adapter shall leave that pool without data and retry its subscription every 60 seconds in the background.
- [ ] **ING-RPC-015**: When `slotSubscribe` and at least one pool subscription are confirmed and the post-subscribe snapshot has been applied, the RPC venue adapter shall report state `live`.
- [ ] **ING-RPC-016**: When a slot notification arrives, the RPC venue adapter shall report it to the sink as that venue's liveness signal.
- [ ] **ING-RPC-017**: The RPC venue adapter shall send a WebSocket ping every 15 seconds on its connection.

## RPC Venue Adapter: Hot Path

- [ ] **ING-RPC-020**: When an RPC venue WebSocket message arrives, the RPC venue adapter shall pass the message `Buffer` directly to `decodeNotification` with the adapter's preallocated output array, without converting it to a string or parsing it as JSON.
- [ ] **ING-RPC-021**: When `decodeNotification` returns `ACCOUNT` for a subscription id mapped to a pool, the RPC venue adapter shall report a pool update with the decoded sqrt ratio, liquidity, slot, and receive timestamps.
- [ ] **ING-RPC-022**: When `decodeNotification` returns `ACCOUNT` for a subscription id that is not mapped to any pool, the RPC venue adapter shall discard the update and increment a counter.
- [ ] **ING-RPC-023**: When `decodeNotification` returns `OTHER`, the RPC venue adapter shall parse the frame as JSON to handle subscription confirmations and JSON-RPC errors.
- [ ] **ING-RPC-024**: When `decodeNotification` returns a negative status, the RPC venue adapter shall increment the decode error counter for that code. Where the output's subscription id maps to a pool, it shall mark that pool suspect until the pool's next successful update.
- [ ] **ING-RPC-025**: When `decodeNotification` reports an unexpected account size, the RPC venue adapter shall log a warning once per layout per process lifetime.
- [ ] **ING-RPC-026**: The RPC venue adapter's WebSocket client shall enforce a 64 KiB maximum inbound message size.

## RPC Venue Adapter: Ordering and Revalidation

- [ ] **ING-RPC-030**: If an RPC venue pool update (from notification, snapshot, or revalidation) carries a slot lower than the pool's last accepted slot, then the system shall discard it and increment the out-of-order counter, except as provided by ING-RPC-032.
- [ ] **ING-RPC-031**: When an RPC venue pool has received no update for 20 seconds, the RPC venue adapter shall re-read it with `getMultipleAccounts`, batching all such quiet pools of that venue into one request, with at most one revalidation request in flight per venue.
- [ ] **ING-RPC-032**: When a revalidation read returns account data byte-identical to the pool's last accepted state at a lower slot, the system shall refresh the pool's receive timestamps without changing its slot.

## RPC Venue Adapter: Reconnect

- [ ] **ING-RPC-040**: If an RPC venue WebSocket closes, errors, or receives no pong within 10 seconds of a ping, then the RPC venue adapter shall report state `down` and reconnect.
- [ ] **ING-RPC-041**: If the reconciler reports an RPC venue `stale` continuously for 10 seconds, then the RPC venue adapter shall close and reconnect that venue's connection.
- [ ] **ING-RPC-042**: When an RPC venue adapter reconnects, it shall wait `random(0, min(30 s, 250 ms × 2^attempt))` before each attempt, and shall reset the attempt count after the connection has remained `live` for 60 seconds.
- [ ] **ING-RPC-043**: When an RPC venue adapter reconnects, it shall clear its subscription-id map, resubscribe, and apply a fresh `getMultipleAccounts` snapshot subject to the slot ordering rule.
- [ ] **ING-RPC-044**: If an RPC venue HTTP request receives status 429, then the adapter shall wait for the `Retry-After` duration when present, or otherwise the full-jitter backoff delay, before retrying.

## Jupiter Adapter

- [ ] **ING-JUP-001**: Where `JUPITER_API_KEY` is unset, the Jupiter adapter shall report state `disabled` and make no requests.
- [ ] **ING-JUP-002**: Where `JUPITER_API_KEY` is set, the Jupiter adapter shall request prices for all tracked mints and the quote mint in a single request with the `x-api-key` header, scheduling each poll only after the previous poll settles, at the configured interval (default 2 s).
- [ ] **ING-JUP-003**: If a Jupiter request does not complete within 2 seconds, then the Jupiter adapter shall abort it and count it as a failed poll.
- [ ] **ING-JUP-004**: When a Jupiter response arrives, the Jupiter adapter shall validate each mint entry independently, and shall skip entries that are missing or invalid without affecting other mints.
- [ ] **ING-JUP-005**: When a Jupiter response contains a valid quote-mint (USDC) entry, the Jupiter adapter shall report each valid tracked mint's price as `usdPrice[mint] / usdPrice[USDC]` from that same response.
- [ ] **ING-JUP-006**: If a Jupiter response lacks a valid quote-mint entry, then the Jupiter adapter shall report no price updates from that response.
- [ ] **ING-JUP-007**: When a Jupiter poll succeeds, the Jupiter adapter shall report a liveness signal, carrying `blockId` as the slot when present and null otherwise.
- [ ] **ING-JUP-008**: When a Jupiter poll succeeds and RPC venue slot data is available, if the response `blockId` is more than 150 slots behind the highest slot seen from any RPC venue, then the Jupiter adapter shall flag that poll's quotes as `lagging`.
- [ ] **ING-JUP-009**: When the first Jupiter poll succeeds, the Jupiter adapter shall report state `live`. After 3 consecutive failed polls, it shall report state `down`.
- [ ] **ING-JUP-010**: If a Jupiter request receives status 429, then the Jupiter adapter shall wait for the `Retry-After` duration when present, or otherwise double its poll interval up to 30 seconds, and shall return toward the configured interval after successful polls.

- [ ] **ING-JUP-011**: If a Jupiter response body as a whole fails schema validation (not a JSON object of mint entries), then the Jupiter adapter shall count it as a failed poll.

## Deferred

- [D] **ING-RPC-050**: Where the RPC endpoint supports `dataSlice` on `accountSubscribe`, the RPC venue adapter shall subscribe only to the price-bearing byte range of each pool account.
- [D] **ING-GEY-001**: Where a Geyser gRPC endpoint is configured, the system shall ingest pool account updates through a Geyser source adapter implementing the `PriceSource` interface.
