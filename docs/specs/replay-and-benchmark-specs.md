# Replay and Benchmark — EARS Specs

LLD: `docs/llds/replay-and-benchmark.md`

## Recorder

- [ ] **RPL-REC-001**: When `pnpm record` runs, the recorder shall connect to mainnet using the markets file and capture, for the configured duration (default 5 minutes):
  - the boot `getMultipleAccounts` responses
  - every RPC WebSocket frame as received, with its relative receive time and pool address
  - slot notifications
  - Jupiter responses
- [ ] **RPL-REC-002**: Where `JUPITER_API_KEY` is unset during recording, the recorder shall write a synthetic Jupiter track derived from the recorded pool prices with jitter, and mark it `synthetic: true` in the fixture header.
- [ ] **RPL-REC-003**: The recorder shall write fixtures as gzipped NDJSON, with a header line holding markets, program ids, recorder version, and source commit.
- [ ] **RPL-REC-004**: If any recorded account frame decodes differently between the native decoder, the reference decoder, and the venue's official SDK, then the recorder shall refuse to write the fixture.
- [ ] **RPL-REC-005**: When `pnpm fixtures:check` runs, if any pool or mint in `markets.json` lacks a boot snapshot or at least one account frame in the committed fixture, then the system shall fail and list the missing addresses.

## Replay Server

- [ ] **RPL-SRV-001**: The replay server shall implement `slotSubscribe`, `accountSubscribe`, and their unsubscribe methods over WebSocket, and `getMultipleAccounts` over HTTP, with the same message shapes as Solana JSON-RPC.
- [ ] **RPL-SRV-002**: The replay server shall serve `GET /price/v3` in the Jupiter Price API v3 response shape, requiring an `x-api-key` header.
- [ ] **RPL-SRV-003**: When `getMultipleAccounts` is requested, the replay server shall return each requested account's latest replayed state at the current replay slot.
- [ ] **RPL-SRV-004**: If the replay server is asked for an account address the fixture does not contain, then it shall return `null` for that account and log an error naming the address and instructing to run `pnpm record`.
- [ ] **RPL-SRV-005**: While in `realtime` mode, the replay server shall emit fixture frames at their recorded timing scaled by the speed factor, and loop the fixture with slots rebased so they increase across loops.
- [ ] **RPL-SRV-006**: While in `rate` mode, the replay server shall emit account notifications at a fixed configured rate across the configured pools, following a precomputed open-loop schedule, from frames pre-encoded before the run.
- [ ] **RPL-SRV-007**: While in `rate` mode with more markets than the fixture contains, the replay server shall clone fixture pools under synthetic pool **and mint** addresses. Mint fields in the cloned account bytes shall be rewritten, and synthetic mint accounts with the original decimals shall be served through `getMultipleAccounts`. Each frame's sqrt price shall be perturbed so that consecutive updates change price.
- [ ] **RPL-SRV-010**: While in `rate` mode, the replay server shall assign slots from one global counter that increments with every emitted account frame, so each (pool, slot) pair is unique. Slot notifications and Jupiter `blockId`s shall report the current counter value.
- [ ] **RPL-SRV-008**: Before a `rate` mode run, if the replay server's measured maximum emit rate to a null sink is below 3× the target rate, then it shall refuse to run.
- [ ] **RPL-SRV-009**: While in `rate` mode, the replay server shall log, for each emitted frame, the pool, slot, and intended send time (`process.hrtime.bigint()` at the scheduled time).

## Fault Injection

- [ ] **RPL-FLT-001**: When the replay server receives `drop` for a venue, it shall close that venue's WebSocket connections and refuse new ones until `restore`.
- [ ] **RPL-FLT-002**: When the replay server receives `stall` for a venue, it shall keep that venue's connections open but stop sending all notifications on them until `restore`.
- [ ] **RPL-FLT-003**: When the replay server receives `stall_accounts` for an address, it shall stop sending that account's notifications while continuing slot notifications, until `restore`.
- [ ] **RPL-FLT-004**: When the replay server receives `garbage` with a rate for a venue, it shall replace that fraction of the venue's frames with malformed variants from the fuzz corpus, until `restore`.
- [ ] **RPL-FLT-005**: When the replay server receives a `jupiter` fault with a status or delay, it shall respond to Jupiter requests with that status or after that delay, until `restore`.
- [ ] **RPL-FLT-006**: When the replay server receives `restore` for a venue or `*`, it shall clear the matching faults.

## Benchmark

- [ ] **RPL-BEN-001**: When `pnpm bench` runs, the benchmark shall start the replay server in `rate` mode, the service in production mode, and multiple load-client processes, each subscribed to every market.
- [ ] **RPL-BEN-002**: When a load client receives a `price` message, it shall record its receive time with `process.hrtime.bigint()` along with the message's mint and trigger.
- [ ] **RPL-BEN-003**: The benchmark shall compute end-to-end latency as client receive time minus the replay server's intended send time of the frame identified by the message trigger's source and slot.
- [ ] **RPL-BEN-004**: The benchmark shall count replayed inputs that never reached a given client as conflated, separately from latency.
- [ ] **RPL-BEN-005**: The benchmark shall run each cell of the matrix (rates 1k, 5k, 10k, 20k, 50k updates/s × subscribers 1, 100, 1,000) with a 10-second discarded warmup followed by 30 measured seconds.
- [ ] **RPL-BEN-006**: For each benchmark cell, the benchmark shall report:
  - end-to-end p50, p99, p99.9, and max
  - internal latency p50, p99, and p99.9
  - event-loop delay p99
  - RSS
  - total GC pause
  - conflation ratio
  - persistence drops
- [ ] **RPL-BEN-007**: The benchmark shall report as the knee the lowest rate at which end-to-end p99 exceeds 1 ms, the conflation ratio exceeds 1%, or event-loop delay p99 exceeds 1 ms.
- [ ] **RPL-BEN-008**: The benchmark shall write results as JSON and Markdown, including the machine specification and the Node, Rust, and commit versions.
- [ ] **RPL-BEN-009**: Where `--summary` is passed, the benchmark shall append its Markdown report to `$GITHUB_STEP_SUMMARY`.
- [ ] **RPL-BEN-010**: If the benchmark runs on a platform other than Linux, then it shall warn and label its results as non-Linux.

## Decoder Microbenchmark

- [ ] **RPL-DBN-001**: When `pnpm bench:decoder` runs, the system shall measure frames per second over at least 5 seconds for both the native and reference decoders on the recorded fixture frames.
- [ ] **RPL-DBN-002**: When `pnpm bench:decoder` runs, the system shall record per-call decode latency in an HDR histogram for both decoders while a background loop churns the heap, and report the results side by side.

## Deferred

- [D] **RPL-BEN-020**: Where a profiling flag is passed, the benchmark shall capture a CPU flamegraph of the service.
- [D] **RPL-BEN-021**: The benchmark shall offer a soak mode running for 1 hour at 50% of the knee rate and reporting memory growth.
