# Delivery — EARS Specs

LLD: `docs/llds/delivery.md`

## Code Quality

- [ ] **DLV-QA-001**: All TypeScript packages shall compile with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` enabled, as ESM.
- [ ] **DLV-QA-002**: All TypeScript code shall pass ESLint with typescript-eslint `strict-type-checked` and Prettier formatting.
- [ ] **DLV-QA-003**: The Rust crate shall pass `cargo fmt --check` and `cargo clippy -- -D warnings`, and forbid `unsafe` code outside napi-generated modules.

## Image

- [ ] **DLV-IMG-001**: The Dockerfile shall build the native addon, the TypeScript packages, and a production runtime image based on `node:24-bookworm-slim`, from source in multiple stages.
- [ ] **DLV-IMG-002**: The runtime image shall run as a non-root user and define a `HEALTHCHECK` against `/health`.
- [ ] **DLV-IMG-003**: The runtime image shall provide the service, the replay server, and the benchmark as separate commands of one image.
- [ ] **DLV-IMG-004**: The runtime image shall include the default markets file and the committed fixtures.

## Compose

- [ ] **DLV-CMP-001**: When `docker compose up` runs from a fresh clone, the system shall start the service against Solana mainnet together with Redis and Postgres, requiring no credentials.
- [ ] **DLV-CMP-002**: When `docker compose --profile replay up` runs, the system shall start the service against the replay server in `realtime` mode together with Redis and Postgres, requiring no network access beyond the image pull.
- [ ] **DLV-CMP-003**: When `docker compose --profile bench run --rm bench` runs, the system shall run the benchmark matrix inside the image and write results to the host's `./bench/results`.
- [ ] **DLV-CMP-004**: In both live and replay modes, the service shall be reachable on host port 8080.
- [ ] **DLV-CMP-005**: The compose file shall reference the GHCR image with a local build fallback, pulling the image when available and building from source otherwise.
- [ ] **DLV-CMP-006**: In replay mode, the replay server's control API shall be reachable from the host for fault injection.
- [ ] **DLV-CMP-007**: Where `JUPITER_API_KEY` is set in the host environment, the live-mode service shall receive it.

## Continuous Integration

- [ ] **DLV-CI-001**: On every push and pull request, CI shall run lint, typecheck, `pnpm fixtures:check`, and unit tests with both the native and reference decoders.
- [ ] **DLV-CI-002**: On every push and pull request, CI shall run Rust fmt, clippy, and tests, and build the native addon.
- [ ] **DLV-CI-003**: On every push and pull request, CI shall run each fuzz target for 60 seconds, and if a crash occurs, fail and upload the reproducer.
- [ ] **DLV-CI-004**: On every push and pull request, CI shall run the native-versus-reference decoder parity suite.
- [ ] **DLV-CI-005**: On every push and pull request, CI shall run the integration test suite against real Postgres and Redis via testcontainers, including fault-injection scenarios.
- [ ] **DLV-CI-006**: On every push and pull request, CI shall run `docker compose --profile replay up` and assert that:
  - `/health` becomes reachable
  - `GET /price/SOL` returns 200 with three sources
  - dropping the Orca venue via the control API makes health `degraded`
  - restoring it brings health back to `ok`
- [ ] **DLV-CI-007**: On every push and pull request, CI shall run a reduced benchmark (rates 1k and 10k, subscribers 1 and 100, 10 seconds each), publish its Markdown table to the job summary labelled as a noisy shared runner, and upload its raw results as artifacts.
- [ ] **DLV-CI-008**: If the reduced CI benchmark's p99 exceeds 5× the committed baseline, then CI shall fail the benchmark job.

## Image Publishing

- [ ] **DLV-PUB-001**: When commits are pushed to `main` or a `v*` tag is pushed, CI shall build `linux/amd64` and `linux/arm64` images on native runners of each architecture, and publish a multi-arch manifest to GHCR.
- [ ] **DLV-PUB-002**: CI shall tag published images `latest` for `main`, `sha-<short>` for every build, and the semantic version for `v*` tags.
- [ ] **DLV-PUB-003**: CI shall authenticate image publishing with the workflow's `GITHUB_TOKEN`, requiring no configured secrets.

## README

- [ ] **DLV-RDM-001**: The README shall present, in order:
  1. CI badge
  2. pitch
  3. architecture diagram
  4. quickstart
  5. offline mode
  6. fault-injection walkthrough
  7. latency results with machine specification and a link to the latest CI job summary
  8. benchmark instructions
- [ ] **DLV-RDM-002**: The README shall state the gateway's worst-case memory bound for slow WebSocket clients, and the meaning of the depth estimate.
