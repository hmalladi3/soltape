# TODO

## In progress

## Up next

- Phase 1: sketch 2–3 HLD trade-off options from the project brief, then draft `docs/high-level-design.md`
- Phase 2: draft LLDs in `docs/llds/` (likely: sources/ingest, normalization + reconciliation, storage/cache, API + WebSocket, observability + benchmark)
- Phase 3: EARS specs in `docs/specs/` per LLD

## Waiting on the user

- Confirm stack: Express 5, Postgres + Drizzle, Redis, Vitest, Awilix, pnpm, pino, prom-client (recommend: keep as proposed)
- Pick DEX source: Raydium or Orca (recommend: Orca Whirlpool, since its account layout is well documented, which helps the RPC-read source and the stretch order-book decode)
- `git init` this repo?

## Done

- 2026-10-19: LID bootstrap (Full mode): `CLAUDE.md`, `docs/high-level-design.md`, `docs/llds/`, `docs/specs/`, `docs/TODO.md`
