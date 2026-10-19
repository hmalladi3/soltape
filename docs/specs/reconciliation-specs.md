# Reconciliation — EARS Specs

LLD: `docs/llds/reconciliation.md`

## Source Liveness

- [x] **REC-LIVE-001**: While an RPC venue (Orca or Raydium) reports adapter state `live` and its last slot notification (or, before the first one, its transition to `live`) is at most 2,000 ms old, the reconciler shall treat that venue as live.
- [x] **REC-LIVE-002**: Jupiter is live while all of the following hold: it reports adapter state `live`; its last successful poll is at most 3× the configured (not backed-off) poll interval old; and, where its latest poll carried a `blockId` and any RPC venue has reported a slot, that `blockId` is at most 150 slots behind the highest RPC venue slot seen. While these hold, the reconciler shall treat Jupiter as live.
- [x] **REC-LIVE-003**: While a source's adapter state is `live` but its liveness condition (REC-LIVE-001 or REC-LIVE-002) does not hold, the reconciler shall treat the source as `stale` and publish the state transition.
- [x] **REC-LIVE-004**: When a source changes from `stale` or `down` back to live, the reconciler shall keep that source's observations ineligible with reason `source_recovering` until the source has stayed live for 1,000 ms continuously.
- [x] **REC-LIVE-005**: When a source changes from live to `stale` or `down`, the reconciler shall make that source's observations ineligible immediately, with no hold period.
- [x] **REC-LIVE-006**: When an adapter reports a source state change, the reconciler shall re-evaluate every market that uses that source immediately, without waiting for the next sweep.

## Pool State (owned by the reconciler)

- [x] **REC-POOL-001**: If a pool update (from notification, snapshot, or revalidation) carries a slot lower than the pool's last accepted slot, then the reconciler shall discard it and increment the out-of-order counter for that source, except as provided by REC-POOL-002.
- [x] **REC-POOL-002**: When a revalidation read for a pool returns a lower slot than the last accepted one, but the same sqrt ratio, liquidity, and tick as the pool's last accepted state, the reconciler shall refresh the pool's receive timestamps without changing its slot.
- [x] **REC-POOL-003**: When an adapter reports a pool as suspect, the reconciler shall mark it suspect, and shall clear the mark on that pool's next accepted update.
- [x] **REC-POOL-004**: When an adapter reports a pool as misconfigured, the reconciler shall mark it misconfigured for the rest of the process lifetime.

## Observation Normalization

- [x] **REC-NORM-001**: When a pool update arrives, the reconciler shall compute the pool price as `sqrtRatio² × 10^(decBase − decQuote)`, inverted when the pool's quote side is token A/0.
- [x] **REC-NORM-002**: When a pool update arrives, the reconciler shall compute the pool's depth estimate as the smaller of the quote amounts needed to move the price up and down by 1% at the current active liquidity, expressed in quote units.
- [x] **REC-NORM-003**: When a pool update arrives for a pool used as a leg in one or more routes, the reconciler shall recompute every route observation using that pool.
- [x] **REC-NORM-004**: When computing a route observation, the reconciler shall set its price to the product of the leg prices, its slot and receive timestamp to the minimum across legs, its depth to the minimum leg depth in quote units, and its source id to `<venue>:route(<pool1>,<pool2>)`.
- [x] **REC-NORM-005**: When a Jupiter quote arrives, the reconciler shall record it as that market's Jupiter observation with a null depth.

## Eligibility

- [x] **REC-ELIG-001**: The reconciler shall evaluate each observation's eligibility with these checks in order, assigning the first failing check's reason:
  1. source configured (`source_disabled`)
  2. pool and all legs validated (`misconfigured`)
  3. observation received live since boot (`no_data`)
  4. source live (`source_down` / `source_stale` / `source_recovering`)
  5. not suspect (`decode_error`)
  6. age ≤ 60 s (`expired`)
  7. finite positive price and finite non-negative depth (`invalid_value`)
  8. not an outlier (`outlier`)
- [x] **REC-ELIG-002**: When a route observation fails an eligibility check because of one leg, the reconciler shall report the reason code unchanged plus a separate `leg` field with the failing leg's 1-based position.
- [x] **REC-ELIG-003**: The reconciler shall never treat values restored from Redis as eligible observations.

## Consolidation

- [x] **REC-CONS-001**: When three or more observations pass eligibility checks 1–7 for a market, the reconciler shall mark as `outlier` every observation whose price deviates from the median of those observations by more than 100 bps.
- [x] **REC-CONS-002**: When eligible observations exist for a market, the reconciler shall set the consolidated price to their median, defined as the middle value for odd counts and the mean of the two middle values for even counts.
- [x] **REC-CONS-003**: When a market has exactly two eligible observations whose prices differ by more than 100 bps relative to their midpoint, the reconciler shall keep both eligible and set `disagreement` to true.
- [x] **REC-CONS-004**: When outlier rejection among three or more observations leaves exactly one eligible observation, the reconciler shall set `disagreement` to true.
- [x] **REC-CONS-005**: When a market's consolidated price is computed, the reconciler shall include:
  - the eligible source ids
  - an `excluded` list giving each other configured source with its reason
  - `spreadBps` as `(max − min) / median × 10⁴` over eligible observations
  - `slot` as the maximum slot among eligible on-chain observations
  - `degraded` as true when fewer observations are eligible than the market has configured venues whose source is not `disabled`
  - `trigger` as the input that caused the evaluation: `<venue>:<pool>` with the pool update's slot (also for route observations, where it names the leg pool that updated), `jupiter` with its `blockId`, `state:<venue>` with a null slot when a source state change caused it, or `sweep` with a null slot
- [x] **REC-CONS-006**: If a market has no eligible observations, then the reconciler shall mark the market `unavailable` and retain its last consolidated value for display with `stale: true`. Where the market was previously available, it shall emit an `unavailable` event.
- [x] **REC-CONS-007**: When a market's evaluation produces the same price, eligible set, exclusion reasons, `degraded`, and `disagreement` as its previous emission, the reconciler shall emit nothing and increment the suppressed-updates counter.
- [x] **REC-CONS-008**: When a market's evaluation differs from its previous emission in any field listed in REC-CONS-007, the reconciler shall increment that market's `seq` and emit the consolidated update.
- [x] **REC-CONS-009**: The reconciler shall compute medians in place over preallocated storage, without allocating or calling `Array.sort`.

## Sweep and Emission Order

- [x] **REC-SWP-001**: The reconciler shall re-evaluate source liveness and observation expiry every 250 ms, re-consolidating each market whose eligible set changed with trigger source `sweep`.
- [x] **REC-EMIT-001**: When the reconciler emits a consolidated update or an `unavailable` event, it shall invoke the WebSocket gateway listener before the persistence listener, synchronously and in that order.
- [x] **REC-EMIT-002**: When an observation's price, eligibility, or reason changes, the reconciler shall notify observation listeners.

## Lifecycle

- [x] **REC-LIFE-001**: When service shutdown begins, the reconciler shall stop its sweep timer and stop emitting events before any source adapter is stopped, so that shutdown never produces `degraded` or `unavailable` emissions.

## Deferred

- [D] **REC-CONS-020**: Where the Phoenix venue is configured, the reconciler shall offer a best-bid/offer consolidated view alongside the median.
- [D] **REC-NORM-020**: The reconciler shall compute depth by walking initialized tick arrays instead of assuming constant active liquidity.
