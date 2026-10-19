# Service Runtime — EARS Specs

LLD: `docs/llds/service-runtime.md`

## Configuration

- [x] **RUN-CFG-001**: When the service starts, the system shall validate all environment configuration and the markets file against their schemas before opening any network connection.
- [x] **RUN-CFG-002**: If startup configuration validation fails, then the system shall print every validation error found (not only the first) and exit with code 2.
- [x] **RUN-CFG-003**: When an environment variable listed in the runtime configuration table is unset, the system shall use its documented default value.
- [x] **RUN-CFG-004**: If the markets file declares a market whose venue entry is neither a direct pool nor a route ending in the quote mint, then the system shall reject the configuration at startup.
- [x] **RUN-CFG-005**: If the markets file declares a route whose legs belong to a venue other than the route's own venue, then the system shall reject the configuration at startup.
- [x] **RUN-CFG-006**: If the markets file contains duplicate market symbols or duplicate market mints, or any mint or pool address that is not a base58 encoding of exactly 32 bytes, then the system shall reject the configuration at startup.
- [x] **RUN-CFG-007**: The system shall expose the validated configuration to components as a single frozen object that cannot be mutated at runtime.

## Dependency Injection

- [x] **RUN-DI-001**: The system shall construct all stateful components as singletons through one Awilix composition root, with each component receiving its dependencies as constructor parameters.
- [x] **RUN-DI-002**: When the service starts, the system shall resolve every registered singleton before listening, so that a wiring error fails startup.
- [x] **RUN-DI-004**: The system shall read monotonic and wall-clock time only through the injected `Clock`.
- [x] **RUN-DI-003**: The system shall allow the `PriceSource`, `FrameDecoder`, `LatestStore`, `HistorySink`, and `Clock` registrations to be replaced in tests without modifying component code.

## Decoder Selection

- [x] **RUN-DEC-001**: Where `DECODER` is `auto`, when the native decoder addon fails to load, the system shall log a warning with the load error and use the TypeScript reference decoder.
- [x] **RUN-DEC-002**: Where `DECODER` is `native`, if the native decoder addon fails to load, then the system shall exit with code 2.
- [x] **RUN-DEC-003**: Where `DECODER` is `ts`, the system shall use the TypeScript reference decoder without attempting to load the native addon.

## Startup

- [x] **RUN-LIFE-001**: When the service starts, the system shall connect Redis and Postgres clients in the background without waiting on, or failing startup because of, their availability.
- [x] **RUN-LIFE-002**: When the service starts, the system shall attempt a warm restore from Redis with a 500 ms deadline before starting source adapters.
- [x] **RUN-LIFE-003**: When the service starts, the system shall begin listening for HTTP and WebSocket connections before starting source adapters, and shall report `starting` health status until startup completes.
- [x] **RUN-LIFE-004**: If an on-chain pool fails mint or owner validation during startup, then the system shall log the pool and the mismatch and exit with code 2.
- [x] **RUN-LIFE-005**: If a source adapter cannot reach its source during startup validation, then the system shall continue startup with that adapter in its reconnect loop while other adapters proceed.
- [x] **RUN-LIFE-006**: When every configured market has a consolidated price, or 15 seconds after the server began listening (whichever is first), the system shall end the `starting` health status.

## Shutdown

- [x] **RUN-LIFE-010**: When the service receives SIGTERM or SIGINT, the system shall report `stopping` health status, stop accepting new HTTP connections and WebSocket upgrades, stop the reconciler (REC-LIFE-001), stop all source adapters, close WebSocket clients with code 1001, flush persistence with a 5-second deadline, close datastore clients, and exit with code 0.
- [x] **RUN-LIFE-011**: If a second SIGTERM or SIGINT arrives while shutdown is in progress, then the system shall exit immediately with code 1.
- [x] **RUN-LIFE-012**: When shutdown completes, the system shall leave no open timers, sockets, or handles held by its components.

## Process Error Policy

- [x] **RUN-ERR-001**: If an uncaught exception or unhandled promise rejection reaches the process, then the system shall log it at `fatal` level with its stack, attempt shutdown capped at 1 second, and exit with code 1.
- [x] **RUN-ERR-002**: The system shall represent expected failures from source data (malformed frames, failed requests, invalid values) as returned status values rather than thrown exceptions.
