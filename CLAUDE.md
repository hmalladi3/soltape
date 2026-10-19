# soltape

Real-time Solana market-data aggregation service (Node/TS): ingests prices from several on-chain sources and serves one reconciled, reliable feed over REST and WebSocket. Read-only — no trading, wallets, or keys.

## LID Mode: Full

## Linked-Intent Development (MANDATORY)

**Consult the `linked-intent-dev` skill for ALL code changes.** All changes flow through the arrow of intent in one direction:

```
HLD → LLDs → EARS → Tests → Code
```

- **New features and refactors**: full seven-phase workflow (HLD check → LLD check/draft → EARS → intent-narrowing edge audit → tests-first → code → optimization loop where performance targets apply).
- **Bug fixes**: walk the arrow like any other change — find where behavior diverged from intent and cascade from there. No short-circuit.
- **If unsure**: use the full workflow.

Keep `docs/TODO.md` current: add every request and pending decision as it arises, and update items the moment their state changes.

Stop after each phase for user review. Mutation, not accumulation — docs reflect current intent, not history.

### Navigation

| What you need | Where to look |
|---|---|
| High-level design | `docs/high-level-design.md` |
| Low-level designs | `docs/llds/` |
| EARS specs | `docs/specs/` |
| Open tasks and pending decisions | `docs/TODO.md`: read at session start, update the moment anything changes |

### Terminology

- **HLD**: High-Level Design — single project-level doc at `docs/high-level-design.md`.
- **LLD**: Low-Level Design — detailed component design doc in `docs/llds/`. One per intent component.
- **EARS**: Easy Approach to Requirements Syntax — structured one-line requirements with globally unique IDs in `docs/specs/`. Markers: `[x]` implemented, `[ ]` active gap, `[D]` deferred.
- **Arrow**: the unidirectional chain from vision to code (HLD → LLDs → EARS → Tests → Code). Strictly a DAG of intent.
- **Arrow segment**: the territory owned by one LLD — the LLD itself plus the specs, tests, and code that cite its EARS IDs. Within-segment cascade is free; across-segment cascade pauses.
- **Cascade**: propagating a change downstream through the arrow so adjacent levels stay coherent.

### Code annotations

Annotate code and tests with `@spec` comments citing EARS IDs:

```
// @spec INGEST-001, RECON-002
```

Place the annotation at the *entry point of the behavior's implementation graph* — the topmost function or module owning the specified behavior, not every helper. When a behavior spans multiple subsystems (UI + API + database, for example), annotate at the entry point in each subsystem. Tests follow the same rule: annotate the test that directly exercises the spec, not every inner assertion.

## LID Tooling

- **Coherence check**: `node bin/coherence-check.mjs [--prefix DEC,REC]`. It lists dangling `@spec` references (and exits 1 if there are any), active specs without a test, and active specs without a code annotation.
