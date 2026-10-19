# Replay and Benchmark

## Context and Design Philosophy

Three things rest on one harness:
- **Reproducible latency numbers.** HLD KDD-10.
- **An offline demo** that always works. HLD KDD-12.
- **Deterministic integration tests.**

The harness records real mainnet traffic once and replays it against the **unchanged** service, which can't tell replay from mainnet: the replay server speaks the same JSON-RPC and Jupiter protocols on the URLs it is configured with.

Principles:
- **Real bytes.** Fixtures are captured mainnet frames, not hand-written JSON. Decoder and parity tests use the same files.
- **The harness must not be the bottleneck.** The generator and the load clients run in separate processes, are pre-encoded, and check their own capacity.
- **Open-loop load, measured from intended send time.** This avoids coordinated omission (Gil Tene): a stalled service can't slow the load and hide its own latency.

## Recorder (`pnpm record`)

`apps/replay/src/record.ts` connects to mainnet using the same `markets.json` and runs for `--duration` (default 5 min). It captures four things:

1. **Boot snapshots:** the `getMultipleAccounts` responses for pools and mints, as raw response bodies.
2. **Every WebSocket frame** on each venue connection, as the raw text exactly as received, along with a receive time relative to the start (µs) and the pool address. The recorder knows the subscription id → address mapping, so each frame can be tagged with its address.
3. **Slot notifications** for each connection.
4. **Jupiter responses**, if `JUPITER_API_KEY` is set. Otherwise it writes a synthetic Jupiter track derived from the pools' prices with jitter, labelled `synthetic: true` in the fixture header, so replay mode always has three sources.

Output: `fixtures/session-<date>.ndjson.gz`, where each line is `{t, kind, venue, address?, body}`, plus a header line with markets, program ids, recorder version, and source commit. The default committed fixture is held to under about 10 MB gzipped. Record-time verification decodes every account frame with both decoders and with each venue's official SDK (`@orca-so/whirlpools-core`, `@raydium-io/raydium-sdk-v2`, dev dependencies of the recorder only), and refuses to write a fixture whose decoders disagree with the SDK.

### Fixture coverage

The committed fixture has to cover the committed `markets.json`. If someone edits the markets file without re-recording, replay mode would fail pool validation at boot. Two guards prevent that:

- **CI check:** `pnpm fixtures:check` verifies that every pool and mint in `markets.json` has a boot snapshot and at least one account frame in the fixture. It fails with the missing addresses listed.
- **Replay server:** if asked to subscribe or snapshot an address the fixture doesn't contain, it answers `getMultipleAccounts` with `null` and logs `error` *"fixture does not cover <address>; run pnpm record"*. The service then treats the pool as missing (fatal at boot, `misconfigured` after boot).

The README tells anyone editing `markets.json` to re-run `pnpm record`.

## Replay Server (`apps/replay`)

A standalone Node process, and the only component allowed to know it is fake. It serves:

| Endpoint | Behaviour |
|---|---|
| WS `/` (RPC) | `slotSubscribe`, `accountSubscribe` (assigns fresh subscription ids and maps them to fixture addresses), `*Unsubscribe` |
| HTTP `POST /` (RPC) | `getMultipleAccounts`: the latest replayed state of each requested account, at the current replay slot |
| HTTP `GET /price/v3` | Jupiter: the fixture track at the current replay time. Requires any `x-api-key`, so it exercises the same code path |
| HTTP `POST /control` | Fault injection (below) and `/control/status` |

### Modes

| Mode | Use | Behaviour |
|---|---|---|
| `realtime` | Demo (`docker compose --profile replay up`), integration tests | Plays the fixture at its recorded timing (with `--speed`), and loops seamlessly. On each loop the slots are rebased upward so they stay monotonic. |
| `rate` | Benchmark | Ignores recorded timing. Emits account notifications at a fixed rate `R` per second, spread across `P` pools using a precomputed schedule. |

### Scaling for the benchmark

The real market set gives only about 10 pools.

- **Synthetic pools:** to reach N mints, the server clones real pool frames under synthetic addresses. The service runs with a generated `markets.bench.json` that declares the clones, and validates them against the replay's `getMultipleAccounts` exactly as on mainnet.
- **Varied prices:** each clone's `sqrt_price` bytes are perturbed per frame, so updates aren't suppressed as no-change. The benchmark measures real updates, not suppression.
- **Pre-encoding:** frames for the whole schedule are pre-encoded into `Buffer`s before the run, including the base64 re-encode after perturbation and the slot rewrite. The send loop does no encoding, only `socket.send(buf)` at the scheduled time.
- **Self-check:** before any run, the server measures its own maximum emit rate with a null sink. If that is below 3 × `R`, it refuses to run, so a slow generator can't pass itself off as service latency.

### Send log

For each emitted frame, the server records `(pool, slot, intendedSendTime)`, where `intendedSendTime` is `process.hrtime.bigint()` at the schedule's intended time, *not* the actual send time. The log is written to a preallocated buffer and dumped at the end.

### Fault injection (`POST /control`)

| Command | Effect |
|---|---|
| `{"op":"drop","venue":"orca"}` | Close that venue's WS connections and refuse new ones until `restore` |
| `{"op":"stall","venue":"raydium"}` | Keep the connection open but stop sending account **and** slot notifications (silent stall) |
| `{"op":"stall_accounts","venue":"orca","address":"…"}` | Stop one account's notifications only, with slots still flowing (per-account silent death) |
| `{"op":"garbage","venue":"orca","rate":0.1}` | Replace a fraction of frames with malformed variants from the fuzz corpus |
| `{"op":"jupiter","status":429}` / `{"op":"jupiter","delayMs":3000}` | Rate-limit or slow responses |
| `{"op":"restore","venue":"*"}` | Clear all faults |

Integration tests and the resilience demo drive these commands. A README section shows a reviewer how to trigger a fault with `curl` and watch the live page degrade and recover.

## Benchmark (`pnpm bench`)

`bench/run.ts` orchestrates:
- replay server (rate mode)
- service (production build, `NODE_ENV=production`)
- `C` load-client **processes** that share `S` subscribers between them

Each client subscribes to `["*"]`. On every `price` message, it records `process.hrtime.bigint()` along with `data.mint`, `trigger.source`, and `trigger.slot`.

### Measuring end-to-end latency

`e2e = clientRecvTime − intendedSendTime` for the frame identified by `(trigger.source, trigger.slot)`.

- **Shared clock:** on Linux, `hrtime` reads `CLOCK_MONOTONIC`, which is system-wide, so stamps from separate processes on the same host can be compared. The benchmark runs inside one container or host for this reason. It refuses to run on platforms where that guarantee is undocumented, i.e. it warns on macOS and labels the results.
- **Conflated inputs:** inputs absorbed by conflation (an input whose `trigger` never reaches a given client) are counted per client as `conflated`, not as latency. A healthy run reports a near-zero conflation ratio, and the knee is where it rises.

### Run matrix (defaults)

| Parameter | Values |
|---|---|
| Rate `R` (updates/s) | 1k, 5k, 10k, 20k, 50k |
| Subscribers `S` | 1, 100, 1,000 |
| Duration | 10 s warmup (discarded) + 30 s measured, per cell |

### Output per cell

- e2e p50/p99/p99.9/max (HDR)
- internal `t3 − t0` p50/p99/p99.9 (scraped from `/stats` at the end)
- event-loop delay p99
- RSS
- GC pause total
- conflation ratio
- persistence drops

### Knee and reports

The **knee** is the first `R` where any of these holds:
- e2e p99 > 1 ms
- conflation ratio > 1%
- event-loop delay p99 > 1 ms

The knee is the honest throughput number. Reports:
- `bench/results/<host>-<date>.json`, the raw data
- `bench/results/<host>-<date>.md`, a table plus the machine specs from `os` and `/proc/cpuinfo`, with Node, Rust, and commit versions
- `--summary`, which appends the Markdown to `$GITHUB_STEP_SUMMARY` in CI

### Decoder microbenchmark (`pnpm bench:decoder`)

This benchmark runs the native and reference decoders on the recorded fixture frames, in-process, with no I/O. It runs in two phases:

1. **Throughput:** frames per second over at least 5 s for each implementation.
2. **Latency under GC pressure:** per-call time in an HDR histogram, while a background allocation loop churns the heap to trigger collections. This is the Rust justification in HLD success metrics: allocation-free native decoding should keep its p99 flat under GC, while the reference decoder's p99 should rise.

Both are reported side by side in the same report format.

### Reviewer path

`docker compose --profile bench run --rm bench` runs the full matrix inside the image, so it needs only Docker. It writes results to `./bench/results` via a bind mount. `pnpm bench` does the same on the host.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Load source | Recorded mainnet frames, replayed | Synthetic JSON | Real frame sizes, field order, and base64 payloads, and the same bytes the decoders are tested on. |
| Load model | Open loop, latency from intended send time | Closed loop; latency from actual send | Avoids coordinated omission. A stalled service can't make the load gentler and hide its own stall. |
| Scaling mints | Cloned pools with perturbed prices + generated markets file | Only real pools | Real pools can't reach 10k updates/s. Perturbation prevents the benchmark from measuring only no-change suppression. |
| Cross-process timing | `hrtime.bigint()` (`CLOCK_MONOTONIC`) in harness and clients | Wall clock; embedding stamps in the payload | Monotonic and comparable across processes on one Linux host. Embedding stamps would change the frame format the service parses. |
| Attributing outputs to inputs | `trigger {source, slot}` in every update | Correlate by price value | Exact, cheap, and also useful to real consumers. |
| Load clients | Multiple processes | One process | 1,000 sockets parsing JSON in one client process would make the client the bottleneck. |
| Generator honesty | Self-check ≥ 3 × target rate before running | Trust it | A benchmark that is limited by its own generator is the most common way to publish a fake number. |
| Jupiter without key | Synthetic track in fixtures, labelled | Replay with only two sources | Replay mode keeps showing 3-source reconciliation with no credentials. The label keeps it honest. |

## Open Questions & Future Decisions

### Resolved
1. ✅ macOS runs are allowed but labelled. Headline numbers come from Linux.
2. ✅ The committed fixture is ≤ ~10 MB gzipped. Larger recordings stay local.

### Deferred
1. Running the service under `perf` / `0x` flamegraph capture as a bench option for the optimization loop.
2. A soak mode (e.g. 1 h at 50% of knee) to check for memory growth.

## References

- Gil Tene, "How NOT to Measure Latency" (coordinated omission)
- HdrHistogram
- Linux `clock_gettime(CLOCK_MONOTONIC)`
