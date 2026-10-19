# Reconciliation — EARS Specs

LLD: `docs/llds/reconciliation.md`

## Source Liveness

- [ ] **REC-LIVE-001**: While an RPC venue (Orca or Raydium) reports adapter state `live` and its last slot notification is at most 2,000 ms old, the reconciler shall treat that venue as live.
- [ ] **REC-LIVE-002**: While Jupiter reports adapter state `live`, its last successful poll is at most 3× the configured (not backed-off) poll interval old, and its latest poll is not flagged `lagging`, the reconciler shall treat Jupiter as live.
- [ ] **REC-LIVE-003**: While a source's adapter state is `live` but its liveness condition (REC-LIVE-001 or REC-LIVE-002) does not hold, the reconciler shall treat the source as `stale` and publish the state transition.
- [ ] **REC-LIVE-004**: When a source changes from `stale` or `down` back to live, the reconciler shall keep that source's observations ineligible with reason `source_recovering` until the source has stayed live for 1,000 ms continuously.
- [ ] **REC-LIVE-005**: When a source changes from live to `stale` or `down`, the reconciler shall make that source's observations ineligible immediately, with no hold period.

## Observation Normalization

- [ ] **REC-NORM-001**: When a pool update arrives, the reconciler shall compute the pool price as `sqrtRatio² × 10^(decBase − decQuote)`, inverted when the pool's quote side is token A/0.
- [ ] **REC-NORM-002**: When a pool update arrives, the reconciler shall compute the pool's depth estimate as the smaller of the quote amounts needed to move the price up and down by 1% at the current active liquidity, expressed in quote units.
- [ ] **REC-NORM-003**: When a pool update arrives for a pool used as a leg in one or more routes, the reconciler shall recompute every route observation using that pool.
- [ ] **REC-NORM-004**: When computing a route observation, the reconciler shall set its price to the product of the leg prices, its slot and receive timestamp to the minimum across legs, its depth to the minimum leg depth in quote units, and its source id to `<venue>:route(<pool1>,<pool2>)`.
- [ ] **REC-NORM-005**: When a Jupiter quote arrives, the reconciler shall record it as that market's Jupiter observation with a null depth.

## Eligibility

- [ ] **REC-ELIG-001**: The reconciler shall evaluate each observation's eligibility with these checks in order, assigning the first failing check's reason:
  1. source configured (`source_disabled`)
  2. pool and all legs validated (`misconfigured`)
  3. observation received live since boot (`no_data`)
  4. source live (`source_down` / `source_stale` / `source_recovering`)
  5. not suspect (`decode_error`)
  6. age ≤ 60 s (`expired`)
  7. finite positive price and finite non-negative depth (`invalid_value`)
  8. not an outlier (`outlier`)
- [ ] **REC-ELIG-002**: When a route observation fails an eligibility check because of one leg, the reconciler shall report the reason with the failing leg's position.
- [ ] **REC-ELIG-003**: The reconciler shall never treat values restored from Redis as eligible observations.

## Consolidation

- [ ] **REC-CONS-001**: When three or more observations pass eligibility checks 1–7 for a market, the reconciler shall mark as `outlier` every observation whose price deviates from the median of those observations by more than 100 bps.
- [ ] **REC-CONS-002**: When eligible observations exist for a market, the reconciler shall set the consolidated price to their median, defined as the middle value for odd counts and the mean of the two middle values for even counts.
- [ ] **REC-CONS-003**: When a market has exactly two eligible observations whose prices differ by more than 100 bps relative to their midpoint, the reconciler shall keep both eligible and set `disagreement` to true.
- [ ] **REC-CONS-004**: When outlier rejection among three or more observations leaves exactly one eligible observation, the reconciler shall set `disagreement` to true.
- [ ] **REC-CONS-005**: When a market's consolidated price is computed, the reconciler shall include:
  - the eligible source ids
  - an `excluded` list giving each other configured source with its reason
  - `spreadBps` as `(max − min) / median × 10⁴` over eligible observations
  - `slot` as the maximum slot among eligible on-chain observations
  - `degraded` as true when fewer observations are eligible than the market has configured venues
  - `trigger` as the source and slot of the input that caused the evaluation
- [ ] **REC-CONS-006**: If a market has no eligible observations, then the reconciler shall mark the market `unavailable` and retain its last consolidated value for display with `stale: true`.
- [ ] **REC-CONS-007**: When a market's evaluation produces the same price, eligible set, exclusion reasons, `degraded`, and `disagreement` as its previous emission, the reconciler shall emit nothing and increment the suppressed-updates counter.
- [ ] **REC-CONS-008**: When a market's evaluation differs from its previous emission in any field listed in REC-CONS-007, the reconciler shall increment that market's `seq` and emit the consolidated update.
- [ ] **REC-CONS-009**: The reconciler shall compute medians in place over preallocated storage, without allocating or calling `Array.sort`.

## Sweep and Emission Order

- [ ] **REC-SWP-001**: The reconciler shall re-evaluate source liveness and observation expiry every 250 ms, re-consolidating each market whose eligible set changed with trigger source `sweep`.
- [ ] **REC-EMIT-001**: When a consolidated update is emitted, the reconciler shall invoke the WebSocket gateway listener before the persistence listener, synchronously and in that order.
- [ ] **REC-EMIT-002**: When an observation's price, eligibility, or reason changes, the reconciler shall notify observation listeners.

## Deferred

- [D] **REC-CONS-020**: Where the Phoenix venue is configured, the reconciler shall offer a best-bid/offer consolidated view alongside the median.
- [D] **REC-NORM-020**: The reconciler shall compute depth by walking initialized tick arrays instead of assuming constant active liquidity.
