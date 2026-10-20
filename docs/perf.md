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

**Runner confirmation:** pending (CI job summary of the next push).
