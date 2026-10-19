# TODO

## In progress

- Phase 1: HLD drafted (`docs/high-level-design.md`, option A); in user review

## Up next

- Phase 2: draft LLDs in `docs/llds/` plus an edge-case probe per LLD
- Phase 3: EARS specs in `docs/specs/` per LLD

## Waiting on the user

- Review the HLD, especially KDD-4 (staleness = liveness), KDD-6 (USDC numeraire), KDD-7 (`processed` commitment)

## Done

- 2026-10-19: HLD gains KDD-12 (reviewable locally via Docker + GH Actions; no hosting, no credentials, optional Jupiter key, replay mode, GHCR image, live page)
- 2026-10-19: Architecture option A chosen (Node orchestration + in-process napi-rs decoder)
- 2026-10-19: Stack and venue choices delegated to Claude; must be defensible in the HLD
- 2026-10-19: git repo initialized; commits credit hmalladi3 only
- 2026-10-19: LID bootstrap (Full mode): `CLAUDE.md`, `docs/high-level-design.md`, `docs/llds/`, `docs/specs/`, `docs/TODO.md`
