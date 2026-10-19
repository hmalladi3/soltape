# Reconciliation

## Context and Design Philosophy

The reconciler turns per-source facts into one consolidated price per mint. It owns three decisions that no other component makes:

1. **Is a source alive?** (source registry, liveness)
2. **Does an observation count?** (freshness, suspicion, outliers)
3. **What is the price?** (route composition, median, attribution, flags)

It is the system's single place of judgement. Adapters report facts, and the gateway and persistence only consume the results. Keeping every eligibility rule here means the reasons in `/sources/:mint` and `excluded[]` always match what was actually used.

Principles:
- **Every exclusion has a reason.** No source is ever dropped silently.
- **Re-evaluate on time as well as on events.** A source can go stale without anything arriving, so a sweep timer re-runs eligibility.
- **Fixed-shape state.** Per-mint and per-pool state lives in preallocated arrays indexed by integer. A tick updates numbers in place, and no objects are allocated until an output actually changes.

HLD refs: KDD-4, KDD-5, KDD-6.

## State Model

```
poolState[poolIndex]        { sqrtRatio, liquidity, slot, recvTs, suspect, everSeen }
quoteState[mktIdx][jup]     { price, slot|null, recvTs, everSeen }
sourceState[sourceId]       { adapterState, lastSlot, lastLivenessTs }
observation[mktIdx][venue]  derived: { price, size, slot, recvTs, eligible, reason, legs[] }
consolidated[mktIdx]        { price, sources[], excluded[], spreadBps, degraded, disagreement, slot, updatedAt, trigger, seq }
```

Each market has at most one **observation per venue** (orca, raydium, jupiter). An observation comes from a direct pool, from a route of pools, or from a Jupiter quote.

## Pool State

The reconciler owns all per-pool state. Adapters report facts, and these rules decide what they mean:

- **Ordering guard.** An update whose slot is lower than the pool's last accepted slot is discarded and counted (`out_of_order`). An equal slot is accepted, since several transactions in one slot can each update the account.
- **Lagging-node refresh.** A *revalidation* result at a lower slot whose sqrt ratio, liquidity, and tick equal the last accepted state refreshes the pool's receive timestamps without moving its slot backwards. The account is provably still in that state, and the read came from an RPC node that is behind. This compares the decoded price-bearing fields rather than raw bytes. The hot path never keeps raw bytes, and no other field affects price.
- **Suspicion.** A pool reported suspect (decode error on its subscription) stays suspect until its next accepted update.
- **Misconfiguration.** A pool reported misconfigured stays so for the process lifetime.

## Source Liveness (Registry)

| Source kind | Live while | Default threshold |
|---|---|---|
| RPC venue | adapter state is `live` **and** `now − lastSlotNotificationTs ≤ SLOT_SILENCE_MS` | 2,000 ms (≈5 slots) |
| Jupiter | adapter state is `live` **and** `now − lastSuccessfulPollTs ≤ JUPITER_SILENCE_MS` | 3 × poll interval (6,000 ms) |

A source that is connected but past its threshold is `stale`, and the registry publishes that state transition. Jupiter is also `stale` while its latest `blockId` is more than `JUPITER_MAX_SLOT_LAG` (default 150 slots, about 60 s) behind the highest slot reported by any RPC venue. The check is skipped when no RPC venue has reported a slot. The registry owns this comparison because it is the only component that sees both sources' slots.

**Hysteresis:** a source moving from `stale` or `down` back to `live` must **stay** live for `RECOVERY_HOLD_MS` (default 1,000 ms) before its observations become eligible again. While it is held, its observations report reason `source_recovering`. Going stale takes effect immediately, while coming back is delayed. A source flapping around the threshold therefore can't toggle the consolidated price on every sweep, and losing a source is never delayed. A source that stays stale longer than `RECONNECT_ON_STALE_MS` triggers the adapter's forced reconnect (see `ingest-sources.md`).

## Observation Eligibility

An observation is **eligible** only if all of the following hold, checked in this order. The first failing check becomes the `reason`:

| # | Check | Reason code |
|---|---|---|
| 1 | Source configured | `source_disabled` |
| 1b | Pool (or every route leg) passed validation | `misconfigured` |
| 2 | Observation ever received since boot | `no_data` |
| 3 | Source live (registry) | `source_down` / `source_stale` |
| 4 | Not suspect (last frame for this pool decoded cleanly) | `decode_error` |
| 5 | Age ≤ hard expiry: `now − recvTs ≤ OBS_MAX_AGE_MS` (default 60 s) | `expired` |
| 5b | Normalized price is finite and > 0; size, if present, is finite and ≥ 0 | `invalid_value` |
| 6 | Not an outlier (below) | `outlier` |

For a route observation, every leg must pass checks 2–5. If one fails, its reason is reported with the failing leg named, e.g. `source_stale (leg 2)`.

Warm-restored values from Redis (see `persistence.md`) never satisfy check 2. `no_data` means "nothing received live since boot", even if a restored value is shown.

**Why a hard expiry, given that liveness exists:** liveness proves the *connection* is healthy. A subscription that is dropped for one account while the connection stays up would otherwise look healthy forever. Revalidation (ingest) keeps quiet pools under the expiry, so only a truly dead feed for that pool hits it.

## Route Composition

Both legs of a route must belong to the **same venue** as the route. Config validation rejects cross-venue routes, because attribution and liveness are per venue and a cross-venue route would merge two failure domains into one observation.

A route `[leg1, leg2]` (e.g. JTO/SOL then SOL/USDC) gives `price = p(leg1) · p(leg2)`, where each leg's price is already decimal-adjusted and oriented. Attributes of a route observation:

- `slot`: the minimum of the leg slots. A route is only as current as its oldest leg.
- `recvTs`: the minimum of the leg recvTs, for the same reason, applied to expiry.
- `size`: the minimum of the legs' depth after converting both to quote units. The thinner leg bounds what can be traded through the route.
- `source`: `orca:route(<pool1>,<pool2>)`, so attribution names every pool involved.

The legs are distinct pool states. An update to the SOL/USDC pool therefore re-derives every route that uses it. That relationship is precomputed at boot as `poolIndex → [mktIdx…]`.

## Depth Estimate (`size`)

For a concentrated-liquidity pool, depth is the quote amount needed to move the price ±`DEPTH_BAND` (default 1%), assuming liquidity stays at the current active `L`. In other words, it assumes no initialized tick is crossed inside the band.

- Quote is token B/1: `Δy = L · √P · (√(1+b) − 1)` in raw B units, then `/10^decB`.
- Quote is token A/0: `Δx = L · (1/√P) · (1 − 1/√(1+b))` in raw A units, then `/10^decA`.

Here `√P` is `SQRT` (the raw ratio), and the smaller of the up-move and down-move depths is reported. The value is labelled `size` in the schema and documented as an *active-liquidity estimate*. It isn't a guaranteed fill size, and the API docs say so. Jupiter observations have `size: null`.

## Consolidation

The consolidation runs on every change to an input of a market (pool update, quote, liveness transition, or sweep) and then works through the steps below.

1. Collect the observations that pass checks 1–5, the *candidates*.
2. **Outlier rejection**, which needs at least 3 candidates:
   - Let `m` be the median of the candidates. Any candidate with `|p − m| / m > OUTLIER_BPS` (default 100 bps) is marked `outlier`.
   - With 3 candidates this tolerates one wrong source. If two candidates are both outliers in opposite directions, only the median remains, and `disagreement = true`.
3. **Two candidates:** an outlier can't be identified with only two. The price is the midpoint. If they diverge by more than `OUTLIER_BPS`, set `disagreement = true`, keep both, and exclude neither, because there is no basis for picking one.
4. **One candidate:** the price is that candidate's.
5. **Zero candidates:** there is no consolidated price. The market's state becomes `unavailable`, the last consolidated price is retained for display only with `stale: true`, and REST returns 503 (see `api-gateway.md`). On a transition from available, the reconciler emits an **`unavailable` event**. This is a second event kind next to consolidated updates. It goes to the gateway (`unavailable` message) and to Redis (marked dirty), and it writes no history row, since there is no price to record. A market that has never been available emits nothing.
6. Fill in the remaining fields:
   - `price`: the median of the eligible observations.
   - `sources`: the eligible source ids.
   - `excluded`: `[{source, reason}]` for the rest.
   - `spreadBps`: `(max − min) / median` over the eligible observations.
   - `slot`: the maximum slot among eligible on-chain observations.
   - `degraded`: `eligible count < count of configured venues whose source isn't disabled`. Without a Jupiter key, a healthy two-venue market is not degraded. Jupiter still appears in `excluded` as `source_disabled`, for transparency.
   - `trigger`: the input that caused this evaluation:
     - `<venue>:<pool>` with the pool update's slot. For a route, this names the leg pool that changed.
     - `jupiter` with its `blockId`.
     - `sweep` with a null slot.

     Triggers are pool-level, so the benchmark can join outputs to inputs exactly.
7. **Change detection:** emit only if `price`, the eligible set, the `excluded` reasons, `degraded`, or `disagreement` changed. A pool update at a new slot with an identical price emits nothing. This is the main suppressor of redundant fan-out. Each emission increments `seq`.

**Median definition:** for an odd count, the middle value. For an even count, the mean of the two middle values (so two sources give the midpoint, matching step 3). It is computed in place over a preallocated scratch array with insertion sort, which is allocation-free and optimal for n ≤ 8. That covers today's 3 venues and leaves room for Phoenix and Drift. `Array.sort` isn't used.

## Sweep Timer

Every `SWEEP_MS` (default 250 ms), the reconciler re-checks liveness and expiry for every source and observation. Any market whose eligible set changed is re-consolidated with `trigger = { source: 'sweep' }`. This is how a source going silent drops out of the price within about `threshold + 250 ms`, with no event needed. The sweep loops over fixed arrays, at a cost of O(markets × venues), which amounts to tens of comparisons.

## Lifecycle

On shutdown the reconciler is **frozen first**: the sweep timer stops and emissions stop *before* the adapters are stopped. Otherwise every restart would publish a burst of spurious `degraded` and `unavailable` updates, as each source went `down` during shutdown, and write them into history.

## Output Interface

```ts
interface ConsolidatedListener {
  onConsolidated(mktIdx: number, c: Consolidated): void
  onUnavailable(mktIdx: number, lastKnown: Consolidated | null): void
}
```

- The gateway (fan-out) and persistence subscribe to this interface.
- **Listener calls are synchronous and ordered:** the gateway is called first, then persistence. That makes the WebSocket push the first thing that happens after reconciliation (HLD "Persistence is off the hot path"). Persistence only enqueues work.
- **Per-source observation updates** go through a separate `onObservation` listener, which is used by `/sources` state, persistence history, and the live page.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Staleness model | Source liveness + observation expiry + suspicion | Age since last update only | HLD KDD-4. Quiet pools stay eligible. Silent per-account death is still caught by expiry. |
| Consolidation | Median, outlier band against median, n ≥ 3 | Mean; liquidity-weighted mean; trimmed mean | HLD KDD-5. Robust to one bad source, and needs no liquidity figure from Jupiter. |
| Two-source divergence | Midpoint + `disagreement` flag | Pick the deeper source; pick on-chain over Jupiter | With two sources neither can be shown wrong. Flagging is honest, and choosing would hide information. |
| Route freshness | Min of legs (slot, recvTs) | Max; last updated leg | A composite price is only as fresh as its oldest input. |
| Change detection | Emit on any change to price, eligible set, reasons, or flags | Emit on every input; epsilon threshold | Exact change keeps consumers' view correct, and conflation downstream handles rate. An epsilon would hide real moves and complicate tests. |
| Time-based re-evaluation | Fixed 250 ms sweep | Per-observation timers | One timer, constant cost, predictable. Per-observation timers churn on every update. |
| Hot-path data structures | Preallocated arrays indexed by integers, in-place insertion sort | Maps keyed by string, `Array.sort` | No allocation or hashing per tick. The input set is fixed at boot. |
| Recovery | 1 s hold before a recovered source counts again; going stale is immediate | Symmetric thresholds | Prevents flapping without ever delaying exclusion of a bad source. |
| Routes | Same-venue legs only | Cross-venue routes | Keeps attribution and failure domains per venue. |

## Open Questions & Future Decisions

### Resolved
1. ✅ Restored (Redis) values never count as eligible.
2. ✅ With two sources diverging, both are kept and flagged.

### Deferred
1. A per-venue weighting or priority (e.g. trusting on-chain over Jupiter on ties), if real data shows systematic bias.
2. Best bid/offer consolidation if the Phoenix stretch goal adds true bid/ask (HLD KDD-5).
3. Tick-crossing-aware depth (walking initialized tick arrays). It needs extra account subscriptions and is out of scope.

## References

- HLD: KDD-4, KDD-5, KDD-6
- Uniswap v3 whitepaper §6 (concentrated liquidity math for Δx, Δy), which applies to both Whirlpool and Raydium CLMM
