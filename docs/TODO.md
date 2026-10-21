# TODO

## In progress


## Up next

- Full matrix on the runner with persistence up after iteration 2 (bench workflow); fill README latency table with it
- Phase 7 next (design changes; walk the arrow first): shard WebSocket subscribers across processes to pass the single-core ceiling (~92% of a core at 10k updates/s × 100 subs on a 4-vCPU runner); optional binary frame encoding; run the full matrix via the `bench` workflow (Actions → bench) for a complete table

## Waiting on the user

- After the first image publish: make the GHCR package `soltape` public (GitHub → Packages → soltape → Package settings → Change visibility), so `docker compose up` can pull without login

## Done

- 2026-10-21: Phase 7 iteration 2: history writes via `unnest` instead of Drizzle multi-row INSERT (event-loop CPU per 2,000 rows 34 ms → 2.7 ms; local event-loop p99 at 10k/s 34 ms → 1.4 ms); bench watchdog + cooldown, job limit 150 min; COPY measured and not shipped (PER-PG-020 removed)
- 2026-10-20: Phase 7 iteration 1: fan-out frame-once + cork-per-turn; runner: 1k/s × 100 subs went from collapse (p50 2.7 s) to p50 482 µs / p99 1.19 ms with 0% conflation; CI gate re-armed; README latency section filled from the runner; DLV-* [x]; CI green on github.com/hmalladi3/soltape (image published to GHCR)
- 2026-10-19: Wave 7 (ESLint strict-type-checked + Prettier, TS 6 for typescript-eslint, Dockerfile, compose live/replay/bench, compose smoke script verified locally, CI + image workflows, cargo-fuzz targets run clean locally, README, delivery tests): 444 unit tests; coherence clean across all 267 active specs. Local Linux-VM bench (Docker Desktop, persistence up) showed heavy tails; headline numbers moved to GitHub Actions
- 2026-10-19: Wave 6 (recorder with SDK verification, replay server realtime/rate/faults, synthetic bench markets, benchmark orchestrator + load clients + HDR join, decoder microbench): 421 unit tests; RPL-* [x]; first mainnet fixture recorded (414 verified frames); first quick bench on M4: 1 sub no knee to 10k/s (e2e p50 38 µs, internal p99 16 µs), 100 subs knee at 10k/s; fixed event-loop metric (default included the sampling interval)
- 2026-10-19: Wave 5 (Prometheus metric set with scrape-time counters and gauges, stage histograms, HTTP metrics, rate-limited logs, component on every line, structured config errors): 392 unit tests; OBS-* specs [x]
- 2026-10-19: Wave 4 (Redis latest snapshot, Postgres partitioned history, migrator, DEFAULT-partition move, bounded writer, read pool): 378 unit + 17 integration tests (real Postgres 17 + Redis 7 via testcontainers); PER-* specs [x]; e2e against mainnet: dependencies up, history buckets served, warm restore serves lastKnown 0.7 s after restart
- 2026-10-19: Wave 3 (REST, health, stats, WebSocket gateway with conflation and slow-client eviction, live page with per-source deviation strip): 378 tests green; API-* specs [x]; live page verified in Chrome against mainnet
- 2026-10-19: Wave 2 (ingest adapters, RPC HTTP client, two-phase market model, runtime lifecycle, Awilix composition root, main): 330 tests green; ING-* and RUN-* specs [x]; live mainnet smoke: all 5 markets priced 1.0 s after cold start, SOL spread 0.7 bps across venues
- 2026-10-19: Fixed SOL/USDC pools (were low-TVL picks from memory): Orca Czfq3x… ($28.7M TVL), Raydium 3ucNos… ($7.6M TVL); fixtures refetched
- 2026-10-19: Wave 1 (decoder, reconciliation, config, market model): 263 TS + 7 Rust tests green; DEC/REC/RUN-CFG/RUN-DEC specs marked [x]; informal decoder microbench on M4: native 1.09M frames/s p99.9 1.37us vs reference 279k/s p99.9 9.0us
- 2026-10-19: Phase 4 resolutions approved
- 2026-10-19: Workspace scaffolded (pnpm 10, TS 7, Vitest 5, napi-rs 3, Rust 1.99); pnpm installed globally via npm
- 2026-10-19: `config/markets.json` pools chosen by the highest-TVL-path rule and verified on-chain (owner, mints, layout size)
- 2026-10-19: EARS specs approved
- 2026-10-19: LLD edge-case probe: all 19 resolutions applied
- 2026-10-19: HLD approved
- 2026-10-19: HLD gains KDD-12 (reviewable locally via Docker + GH Actions; no hosting, no credentials, optional Jupiter key, replay mode, GHCR image, live page)
- 2026-10-19: Architecture option A chosen (Node orchestration + in-process napi-rs decoder)
- 2026-10-19: Stack and venue choices delegated to Claude; must be defensible in the HLD
- 2026-10-19: git repo initialized; commits credit hmalladi3 only
- 2026-10-19: LID bootstrap (Full mode): `CLAUDE.md`, `docs/high-level-design.md`, `docs/llds/`, `docs/specs/`, `docs/TODO.md`
