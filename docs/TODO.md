# TODO

## In progress

- Phase 4: cross-segment audit done, 15 resolutions applied to specs and LLDs; in user review

## Up next

- Phase 5: scaffold workspace (pnpm, tsconfig, Vitest, Cargo/napi), then write failing tests per segment, starting with decoder + reconciliation
- Record the first mainnet fixture (`pnpm record`) once the recorder exists; choose pool addresses for `markets.json`

## Waiting on the user

- Review Phase 4 resolutions before tests are written

## Done

- 2026-10-19: EARS specs approved
- 2026-10-19: LLD edge-case probe: all 19 resolutions applied
- 2026-10-19: HLD approved
- 2026-10-19: HLD gains KDD-12 (reviewable locally via Docker + GH Actions; no hosting, no credentials, optional Jupiter key, replay mode, GHCR image, live page)
- 2026-10-19: Architecture option A chosen (Node orchestration + in-process napi-rs decoder)
- 2026-10-19: Stack and venue choices delegated to Claude; must be defensible in the HLD
- 2026-10-19: git repo initialized; commits credit hmalladi3 only
- 2026-10-19: LID bootstrap (Full mode): `CLAUDE.md`, `docs/high-level-design.md`, `docs/llds/`, `docs/specs/`, `docs/TODO.md`
