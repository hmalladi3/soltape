# Delivery

## Context and Design Philosophy

This LLD covers how the code becomes something a reviewer can run, and how GitHub proves it works: workspace layout, build, container image, compose profiles, CI, and image publishing. HLD KDD-12 sets the bar. With only Docker, a reviewer sees live prices within five minutes, with no credentials and no Rust compile. GitHub Actions is the only remote compute. There is no hosting.

Principles:
- **The prebuilt image is the fast path, and building from source is the guarantee.** Both use the same Dockerfile.
- **CI exercises exactly what the README tells reviewers to run.** If `docker compose --profile replay up` breaks, CI goes red.

## Workspace Layout (pnpm)

```
soltape/
  apps/
    service/          Node service (Express 5, ws, reconciler, adapters, persistence, telemetry)
      public/         live page (index.html)
      src/
    replay/           recorder + replay server
  packages/
    decoder/          napi-rs crate (native/) + TS contract, reference decoder, loader
    shared/           schema types, market config types, zod schemas shared by service and replay
  bench/              benchmark orchestrator, load clients, results/
  config/             markets.json (default), markets.bench.json is generated
  fixtures/           recorded session(s), committed
  docker/             Dockerfile, compose files
  docs/               HLD, LLDs, specs, TODO
```

- **TypeScript** runs with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM, project references per package, and is built with `tsc -b`.
- **Lint** is ESLint (typescript-eslint, strict-type-checked) plus Prettier.
- **Rust** uses the stable toolchain pinned in `rust-toolchain.toml`, with `cargo fmt`, `clippy -D warnings`, and `#![forbid(unsafe_code)]` in non-generated modules.

## Dockerfile (multi-stage, multi-arch)

| Stage | Base | Does |
|---|---|---|
| `rust-builder` | `rust:<pinned>-bookworm` + Node 24 + pnpm | `napi build --release` for the target platform's GNU triple |
| `ts-builder` | `node:24-bookworm-slim` | `pnpm install --frozen-lockfile`, `tsc -b`, copy the `.node` artifact in, `pnpm deploy --prod` for the service and replay apps |
| `runtime` | `node:24-bookworm-slim` | Copies the deployed apps, config, and fixtures. Runs as non-root `node`. `HEALTHCHECK` curls `/health`. `CMD ["node", "apps/service/dist/main.js"]` |

- **One image, several commands.** The replay server and benchmark live in the same image, run as different commands (`node apps/replay/dist/main.js`, `node bench/dist/run.js`). Reviewers pull one image.
- **glibc (`bookworm-slim`), not Alpine.** That avoids maintaining a musl target and the musl allocator's slowdown for allocation-heavy Node workloads.
- **Cache-friendly layer order:** lockfile and manifests come before sources, and the Cargo registry cache is mounted with `--mount=type=cache`.

## Compose

`docker-compose.yml` sits at the repo root, so `docker compose up` works from a fresh clone.

Profiles pick which app variant runs. A committed `.env` sets `COMPOSE_PROFILES=live`, and a `--profile` flag on the command line overrides it. So every README command is one line:

| Command | Runs |
|---|---|
| `docker compose up` | `app` (live mainnet) + redis + postgres |
| `docker compose --profile replay up` | `app-replay` + `replay` + redis + postgres. No internet needed after the image pull |
| `docker compose --profile bench run --rm bench` | The benchmark matrix (it starts its own service and replay processes inside the container) |

| Service | Image | Profiles | Notes |
|---|---|---|---|
| `app` | `ghcr.io/hmalladi3/soltape:latest` (with `build:` fallback) | `live` | Port `8080`, mainnet defaults, `JUPITER_API_KEY` passed through from the host env if set. `depends_on` redis/postgres with `service_started` (not `healthy`, since the app tolerates their absence). `restart: unless-stopped` |
| `app-replay` | same image | `replay` | Same as `app` (YAML anchor) but with `RPC_WS_URL=ws://replay:8899`, `RPC_HTTP_URL=http://replay:8899`, `JUPITER_URL=http://replay:8899/price/v3`, `JUPITER_API_KEY=replay`. Port `8080` |
| `replay` | same image, `command: replay` | `replay` | Replay server in `realtime` mode, looping the committed fixture. Control API on `8899/control`, published to the host for the "break it" demo |
| `bench` | same image, `command: bench` | `bench` | Bind-mounts `./bench/results` |
| `redis` | `redis:7-alpine` | *(always)* | No persistence (`--save ""`), because it is a cache |
| `postgres` | `postgres:17-alpine` | *(always)* | Named volume, healthcheck |

`app` and `app-replay` never run together, because their profiles are mutually exclusive in every documented command. Both bind `8080`, so the reviewer's URL is the same in either mode.

**Image source:** `pull_policy: missing` with both `image:` and `build:`. Compose pulls the GHCR image if it is available and builds locally otherwise. A reviewer who wants to build from source runs `docker compose build`.

## CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every push and pull request. Jobs run in parallel where independent:

| Job | Runs |
|---|---|
| `ts` | `pnpm install --frozen-lockfile`, lint, typecheck, Vitest unit tests (decoder runs as reference **and** native, via a prebuilt artifact from `rust`) |
| `rust` | fmt, clippy, `cargo test`, `napi build` → uploads the `.node` artifact |
| `fuzz` | `cargo +nightly fuzz run` for each target, 60 s each, using the committed corpus. A crash uploads the reproducer and fails the job |
| `parity` | Native vs reference over fixtures + corpus + fast-check (needs `rust` artifact) |
| `integration` | Vitest integration suite with testcontainers (Postgres, Redis), service + replay server in-process or child process, plus the fault-injection scenarios |
| `compose-smoke` | `docker compose --profile replay up -d --build`, wait for `/health`, then assert `GET /price/SOL` → 200 with 3 sources. Kill `orca` via `/control`, assert `degraded`. Restore, assert recovery. Then tear down |
| `bench-smoke` | Builds the image, runs the bench matrix reduced to `R ∈ {1k, 10k}` and `S ∈ {1, 100}` for 10 s each, writes the Markdown table to `$GITHUB_STEP_SUMMARY`, uploads JSON + HDR logs as artifacts |

- **Benchmark noise:** `bench-smoke` numbers are labelled *"GitHub-hosted runner (shared, noisy): regression signal only"*. A regression fails the job only if p99 exceeds 5× the committed baseline, and the threshold is deliberately loose for noisy runners.
- **Speed:** `ts` and `rust` together take under 5 minutes. The workflow uses pnpm store caching and `Swatinem/rust-cache`.

### Image publishing (`.github/workflows/image.yml`)

This workflow runs on pushes to `main` and on `v*` tags.

- **Native builds per architecture:** a matrix builds `linux/amd64` on `ubuntu-24.04` and `linux/arm64` on `ubuntu-24.04-arm`, both GitHub-hosted runners that are free for public repos. Each builds natively, pushes by digest, and a final job merges the digests into a multi-arch manifest (`docker buildx imagetools create`).
- **Tags:** `latest` (main), `sha-<short>`, and semver on tags.
- **Auth:** pushes to GHCR authenticate with the workflow's `GITHUB_TOKEN` (`packages: write`), so no secrets need configuring. The package is set to public once, by hand. The README notes this as the only manual repository setting.

## README Contract

The README is a delivery artifact: its commands are tested by `compose-smoke`. Its top section is, in order:

1. CI badge
2. A one-paragraph pitch
3. The architecture diagram (from the HLD)
4. **Quickstart** (`docker compose up`, then open `localhost:8080`, or `curl localhost:8080/price/SOL`)
5. **Offline mode** (`--profile replay`)
6. **Break it** (fault injection curl commands)
7. **Latency results** table: headline numbers from a documented local Linux machine, with the machine spec, plus a link to the latest CI job summary
8. **Run the benchmark yourself**

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Repo shape | pnpm workspace: apps + packages | Single package; Nx/Turborepo | Gives the native addon a clean boundary. pnpm workspaces are enough, and a build orchestrator adds config for no benefit at this size. |
| Base image | `node:24-bookworm-slim` | Alpine; distroless | Avoids musl's allocator and target issues. Distroless complicates healthchecks and debugging for little gain here. |
| One image for app/replay/bench | Yes | Separate images | One pull for reviewers, and the replay and bench are always the same version as the service. |
| arm64 builds | Native `ubuntu-24.04-arm` runners | QEMU emulation | Compiling Rust under QEMU takes many times longer. Native arm runners are free for public repos. |
| Compose image fallback | `image` + `build`, `pull_policy: missing` | Build-only; image-only | Fast for reviewers when the image exists, and still works on forks or before the first publish. |
| CI benchmark gating | Loose 5× threshold, labelled noisy | Strict gating; no CI bench | Shared runners are too noisy for strict gates, but a 5× regression is still a real signal. |
| Compose smoke test | CI runs the README's own commands | Trust the README | Keeps the "one command" claim true over time. |

## Open Questions & Future Decisions

### Resolved
1. ✅ No hosting, no Pages: Actions + GHCR only (HLD non-goals).
2. ✅ Making the GHCR package public is the single documented manual step.

### Deferred
1. Release notes or changelog automation (not needed for scope).

## References

- HLD: KDD-12
- GitHub-hosted arm64 runners (`ubuntu-24.04-arm`)
- napi-rs cross-build docs; `docker buildx imagetools`
