# TODO

## In progress

- Wave 1 complete; waiting on user review before wave 2 (ingest adapters)

## Up next

- Wave 2: ingest adapters + composition root (RUN-DI-*, RUN-LIFE-*, RUN-ERR-* still have no tests) (fake RPC WS server, fake Jupiter); wave 3: API gateway + live page; wave 4: persistence (testcontainers); wave 5: telemetry; wave 6: replay + bench; wave 7: delivery (Docker, compose, CI)
- Record the first mainnet session fixture (`pnpm record`) once the recorder exists (wave 6)

## Waiting on the user


## Done

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
