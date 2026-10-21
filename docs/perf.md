# Performance write-up

The optimization loop's record (LID Phase 7): measurements with their hardware, the noise floor, every accepted and rejected change with before and after data, and the stopping point. Negative results stay here.

## Method

- **End-to-end:** `pnpm bench` (open-loop replay, separate processes; see `docs/llds/replay-and-benchmark.md`).
- **Component microbenchmarks:**
  - `pnpm bench:decoder`: decoder throughput and latency under GC pressure.
  - `pnpm bench:fanout`: process CPU per update, with real subscriber sockets in a child process. Variants run in interleaved blocks within one process, so they share machine conditions. Delivery is verified from the clients' counts.
- **Noise floor:** the fan-out benchmark always includes an A/A pair (two identical baseline gateways). A candidate is kept only if its gain is well above the A/A spread, measured in the same session on the same hardware.
- **Target hardware:** GitHub-hosted `ubuntu-24.04` runners (4 vCPU AMD EPYC 7763), where CI publishes every run in the job summary. A local Apple M4 is used for iteration only.

## Iteration 1: WebSocket fan-out (2026-10-19)

**Symptom:** CI quick matrix on the runner:
- 1 subscriber was healthy (1k updates/s: e2e p50 155 µs, internal p99 118 µs).
- **100 subscribers collapsed at 1k updates/s**: event loop 761 ms, 50% conflated, internal p99 about 2 ms per emission.

At 100k sends/s, that works out to roughly 15–20 µs per `ws.send` on that CPU. On the M4 the same cell was healthy, so the margin is entirely per-send cost.

**Profile (M4, 100 subscribers, CPU per update):** about 920 µs per update, or 9.2 µs per `ws.send`. ws frames the payload separately for every client (a header allocation per send) and issues one socket write per client per update.

**Candidates:**

| # | Change | Expected gain | Complexity |
|---|---|---|---|
| B | Frame each update once (`Sender.frame`, unmasked, so byte-identical for every subscriber) and write the same bytes to each socket | Removes per-client framing | Low. One private-socket write, `bufferedAmount` unaffected |
| C | B, plus cork every touched socket and uncork once per event-loop turn | Coalesces N same-turn updates into one system call per client | Low. Wire format unchanged (still one WebSocket frame per update) |

**A/B (M4, same session, interleaved; µs CPU per update, 100 subscribers, full delivery verified):**

| Variant | 1 update/turn | 10 updates/turn |
|---|---:|---:|
| A: `ws.send` per client (baseline) | 919 | 821 |
| A′: baseline again (A/A) | — | 828 (noise ≈ 1%) |
| B: frame once | 597 (−35%) | 598 (−27%) |
| C: frame once + cork/turn | 649 (−29%) | **161 (−80%)** |

**Decision:** accept B and C, both on by default (`preframe`, `corkPerTick`). C costs about 9% more than B when updates arrive one per turn, which only happens when there's spare CPU. Under load, when several updates share a turn, it is 4–5× cheaper. Gains far exceed the 1% noise floor. All 445 unit tests pass with both enabled, including the real-socket backpressure tests.

**Bug caught by the measurement:** the first B run showed 13 ns per write, which is physically impossible. Delivery counts showed the clients receiving nothing. Subscribe-time snapshots went through the same write path unframed, the raw JSON corrupted the WebSocket stream, and the clients disconnected. Fixed (every frame that reaches `enqueue` comes from `frameOnce`). The benchmark now prints delivered/expected for every variant, so a variant that does no work can't look fast.

**Runner confirmation** (GitHub `ubuntu-24.04`, AMD EPYC 9V74, commit `7455106`, same-session microbenchmark):

| Variant | 1 update/turn | 10 updates/turn |
|---|---:|---:|
| A: baseline | 1123 | 679 |
| A′: A/A | 1137 (+1%) | 764 (+12%) |
| B: frame once | 1112 (−1%) | 613 (−10%) |
| C: frame once + cork/turn | 803 (−28%) | **134 (−80%)** |

The noise floor on shared runners is wide: the A/A pair differed by up to 12%. On the runner, B alone is within noise. C is far outside it in both regimes, and it is the change that matters.

**End-to-end on the runner, before and after (quick matrix):**

| Cell | Before (`b4db481`) | After (`7455106`) |
|---|---|---|
| 1k/s × 100 subs | e2e p50 2.73 s, p99 7.59 s, 50% conflated, event loop 761 ms | e2e p50 482 µs, p99 1.19 ms, 0% conflated, event loop 0.41 ms |
| 10k/s × 100 subs | collapsed (100% conflated, event loop 2.6 s) | e2e p50 1.60 ms, p99 13.8 ms, 0% conflated, event loop 2.7 ms |
| 1k/s × 1 sub | p50 155 µs, p99 369 µs | p50 124 µs, p99 388 µs (unchanged within noise) |

**Stopping point for this iteration:** the 100-subscriber cells now deliver everything. At 10k × 100 the service uses about 92% of a core, so the next ceiling is the single event loop itself, not per-send overhead. The CI regression gate is re-armed with these numbers (`bench/baseline.json`).

## Iteration 2: history writes blocking the event loop (2026-10-21)

**Symptom:** the full matrix on the runner with Redis and Postgres up (`bench` workflow, run 39372676270) was far worse than the quick matrix without persistence:
- 1k/s × 100 subscribers: e2e p99 23.3 ms vs 1.19 ms.
- 10k/s × 1 subscriber: 11.7% conflated, event loop 67 ms.

Internal latency stayed at 35–90 µs, so the hot path was fine, and the event loop itself was being blocked. The same run also overran the 60-minute job limit in the 1,000-subscriber cells: the harness had no timeout on client connects. Fixed with a per-cell watchdog and cooldown.

**Profile** (local, 10k updates/s for 15 s, Redis and Postgres up, `--cpu-prof`):
- Event-loop delay p99 was 34 ms.
- **Drizzle's insert query builder was 25.4% of all samples, about 64% of non-idle CPU.** Mostly `is()` entity checks, called per value across about 9,000 parameters per 1,000-row batch.
- The whole feed (decoder, reconciler, gateway, metrics) was about 4%.

**Candidates** (`bench:history`, interleaved, real Postgres, ms of event-loop CPU per batch of 1,000 consolidated + 1,000 observation rows):

| Writer | CPU / batch | Wall / batch |
|---|---:|---:|
| A: Drizzle multi-row `INSERT` (baseline) | 34.3 | 49.9 |
| A′: A/A | 35.4 (+3%) | 56.7 |
| B: `INSERT … SELECT FROM unnest(column arrays)` | **2.67 (−92%)** | 15.2 |
| C: `COPY FROM STDIN` (text) | 2.18 (−94%) | 10.1 |

**Decision:** ship B. C's extra 0.5 ms per 2,000 rows (about 0.5% of a core at 20k rows/s) does not justify a new dependency and a dedicated connection per batch. B stays one parameterized statement with a constant 9 parameters. The deferred `COPY` spec (PER-PG-020) is removed. Its measurement is kept here, and COPY stays in `bench:history` as the comparison.

**Result** (same local profile, after):

| | Before | After |
|---|---|---|
| Event-loop delay p99 | 34 ms | 1.4 ms |
| Postgres flush wall, per batch | ~57 ms | ~19 ms |
| Postgres client share of samples | 25.7% | 1.4% |
| Rows written / dropped | — | 150,030 + 150,040 / 0 |

**Runner confirmation** (full matrix, Redis and Postgres up, `bench` run 39650914440 vs 39372676270, same workflow and settings):

| Cell | Before | After |
|---|---|---|
| 10k/s × 1 sub | p99 85.9 ms, 11.7% conflated, loop 67 ms | p99 10.8 ms, 0% conflated, loop 5.0 ms |
| 20k/s × 1 sub | 41% conflated | 0.07% conflated |
| 1k/s × 100 subs | p99 23.3 ms, loop 5.4 ms | p99 3.67 ms, loop 2.1 ms |
| 10k/s × 100 subs | p99 164 ms, 42% conflated | p99 60.8 ms, 0.12% conflated |

Zero persistence drops in every cell below saturation. All 15 cells completed: the per-cell watchdog held, and no cell overran.

## Stopping point (2026-10-21)

**The remaining ceiling is the single event loop doing useful work.** The service is at about 95% of a core:
- at 10–20k updates/s with one subscriber;
- at about 100k fan-out messages/s (1k/s × 100 subscribers, about 8 µs per corked send with no same-turn batching at that rate).

Internal latency stays at tens of microseconds in every cell. No remaining in-process candidate shows a large measured cost. Going further means using more cores, which is a design change (below).

## Next candidates (not started)

- Shard WebSocket subscribers across worker processes (`SO_REUSEPORT`) to use more than one core.
- A binary encoding to shrink the 400-byte frames.

Both are design changes and would walk the arrow (LLD → EARS) first.
