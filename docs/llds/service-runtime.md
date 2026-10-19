# Service Runtime

## Context and Design Philosophy

The runtime is the skeleton every other component hangs from: it covers configuration, dependency wiring, startup order, shutdown, and the process-level failure policy. It contains no domain logic. Two principles guide it:

- **Fail at startup, never at runtime, for anything that is knowable at startup.** Config, market definitions, pool identities, and decoder availability are all validated before the service listens.
- **Crash-only for genuine bugs.** Bad *source data* is an expected input. It is handled where it enters (the adapters, the decoder) and never reaches the process boundary. An exception that does reach the process boundary means the program state is unknown. The service then logs it at `fatal` level and exits, and the container restart policy brings it back. Trying to keep running in an unknown state is how a feed silently serves wrong prices.

HLD refs: KDD-1, KDD-11, KDD-12, Goal 4.

## Configuration

Configuration comes from two places. Both are validated with zod at boot, and the service refuses to start with a list of every error found, not just the first.

### Environment (`.env` / container env)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port |
| `RPC_HTTP_URL` | `https://api.mainnet-beta.solana.com` | JSON-RPC HTTP (snapshots, revalidation, mint decimals) |
| `RPC_WS_URL` | `wss://api.mainnet-beta.solana.com` | JSON-RPC WebSocket (subscriptions) |
| `RPC_COMMITMENT` | `processed` | Subscription/snapshot commitment (HLD KDD-7) |
| `JUPITER_API_KEY` | *(unset)* | Enables the Jupiter source. Unset → source `disabled` |
| `JUPITER_URL` | `https://api.jup.ag/price/v3` | Overridden to the replay server in replay mode |
| `REDIS_URL` | `redis://redis:6379` | Optional. Unreachable → feature degrades, service runs |
| `DATABASE_URL` | `postgres://soltape:soltape@postgres:5432/soltape` | Optional, same policy |
| `DECODER` | `auto` | `auto` (native, else TS), `native` (fail if missing), `ts` |
| `MARKETS_FILE` | `config/markets.json` | Market definitions |
| `LOG_LEVEL` | `info` | pino level |
| `HISTORY_RETENTION_DAYS` | `7` | Postgres partition retention |

Thresholds (liveness, outlier band, slow-consumer limits) also have env overrides with defaults defined in their owning LLDs. The runtime merges them all into a single frozen config object.

### Markets file (`config/markets.json`)

This file declares what the feed tracks. It is committed, and the Docker image bakes in a default copy.

```jsonc
{
  "quote": { "symbol": "USDC", "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  "markets": [
    {
      "symbol": "SOL",
      "mint": "So11111111111111111111111111111111111111112",
      "venues": {
        "orca":    { "pool": "<whirlpool address>" },
        "raydium": { "pool": "<clmm pool address>" },
        "jupiter": {}
      }
    },
    {
      "symbol": "JTO",
      "mint": "...",
      "venues": {
        "orca":    { "route": ["<JTO/SOL whirlpool>", "<SOL/USDC whirlpool>"] },
        "raydium": { "pool": "..." },
        "jupiter": {}
      }
    }
  ]
}
```

- **Shape checks.** Every pool or route must be priced in the quote unit, either directly or through a declared route (see `reconciliation.md`). Symbols must be unique. Mints and pools must be valid base58 32-byte keys.
- **Cross-check against the chain.** Ingest checks that each pool's on-chain mints match the declared market. A mismatch is a startup error naming the pool. A typo in a pool address must never become a silently wrong price.

## Dependency Injection

Awilix container, `InjectionMode.PROXY`, with a single composition root at `apps/service/src/container.ts`.

- **Every component is a class or factory** that takes its dependencies as a destructured object, e.g. `constructor({ config, logger, decoder })`. There are no decorators, no `reflect-metadata`, and no service locator calls outside the composition root.
- **Lifetimes:** everything stateful is a `singleton`. Awilix scoped containers are not used per request, because nothing in the request path is request-scoped.
- **Interfaces at the seams:** `PriceSource`, `FrameDecoder`, `LatestStore`, `HistorySink`, `Clock`. Integration tests build the same container and replace only the seams they fake, for example `asValue(fakeClock)` or a replay-backed source.
- **Fatal wiring errors:** `container.resolve` of every singleton happens at boot, so a wiring error is a startup failure, not a 3 a.m. surprise.

## Lifecycle

### Startup order

1. Load and validate config and markets. Any error → print all errors and exit 2.
2. Create the logger and metrics registry.
3. Load the decoder per `DECODER`. With `auto`, a native load failure logs `warn` with the reason and falls back to TS. With `native`, it fails startup. The selected implementation is exposed on `/health`.
4. Start persistence clients in the background. A connect failure is logged and leaves the sink `down`. It never blocks or fails startup.
5. Warm restore: read the last snapshot from Redis, with a 500 ms deadline. Restored values are marked `restored: true` and are never eligible for consolidation (see `persistence.md`).
6. Construct the reconciler and latest state.
7. Start the HTTP + WebSocket server and listen. `/health` reports `starting`.
8. Start the source adapters. Each adapter validates its pools (mint cross-check, decimals) before subscribing. A pool that fails validation is a startup error that exits 2. A *network* failure during validation is not a startup error: that adapter enters its reconnect loop and the others proceed.
9. Leave `starting` for `ok` or `degraded` once the first consolidated price exists for every market, or after a 15 s startup grace period, whichever comes first.

### Shutdown (SIGTERM / SIGINT)

1. Mark `/health` as `stopping` and stop accepting new HTTP connections and WebSocket upgrades.
2. Stop the source adapters, closing their sockets and clearing their timers.
3. Close WebSocket clients with code `1001 Going Away`.
4. Flush persistence with a 5 s deadline. Whatever remains unflushed is counted and logged.
5. Close the Redis and Postgres clients, then exit 0.

A second signal during shutdown forces an immediate exit 1. Every timer and socket is owned by a component with a `stop()` method, so a clean shutdown leaves no open handles. Tests assert this.

### Process-level error policy

- **`uncaughtException` and `unhandledRejection`:** log `fatal` with the stack, attempt a best-effort shutdown (1 s cap), then exit 1. Docker `restart: unless-stopped` restarts the service.
- **No catch-all `try` that swallows exceptions** anywhere in the service. Expected failures are modelled as values (status codes from the decoder, typed result unions from adapters), not exceptions.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Config validation | zod, all errors at once, exit 2 | Fail on first error, runtime lazy reads | Reporting every error lets a reviewer fix their config in one pass. Exit 2 (usage error) is distinct from exit 1 (crash). |
| Market definitions | Committed JSON file, cross-checked on-chain at boot | Env vars, DB table | Pool/route structure doesn't fit flat env vars. A file is easy to review in diffs. The on-chain cross-check makes a typo a loud error instead of a wrong price. |
| DI container | Awilix PROXY mode, single composition root | tsyringe (needs decorators and reflect-metadata), manual wiring | Plain constructors stay testable without the container. A seam swap is one line in tests. |
| Unknown exceptions | Log fatal, exit, container restarts | Log and continue | After an unexpected throw, the state is unknown, and continuing risks serving wrong prices silently. Expected bad input never throws (see decoder and ingest). |
| Persistence at startup | Non-blocking, best effort | Block until DB is up | The live feed must not depend on history (HLD Goal 3). |

## Open Questions & Future Decisions

### Resolved
1. ✅ Persistence is never a startup dependency: the feed runs without Redis or Postgres.
2. ✅ Pool validation failure (wrong mints) is fatal at startup. A network failure during validation is not.

### Deferred
1. Hot-reload of `markets.json` without restart. Not needed for scope.

## References

- HLD: KDD-1, KDD-11, KDD-12
- Awilix: https://github.com/jeffijoe/awilix
