# TODO

## In progress

- Wave 6: replay server, recorder, fault injection, benchmark harness, decoder microbenchmark

## Up next

- Phase 7 candidate: internal p50 ≈ 450 µs on live frames: one SOL/USDC update fans out to 5 markets (every route uses that leg); profile the per-emission cost (JSON serialization, observation views) before optimizing
- Wave 7: compose host port must be configurable (port 8080 is taken by another container on this machine)
- Wave 7: delivery (Docker, compose, CI)
- Record the first mainnet session fixture (`pnpm record`) once the recorder exists (wave 6)

## Waiting on the user


## Done

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
