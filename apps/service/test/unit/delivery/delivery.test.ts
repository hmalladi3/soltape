import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { regressions } from '../../../../../bench/src/regress.js';

const root = new URL('../../../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const yaml = (p: string) => parse(read(p), { merge: true });

describe('code quality gates', () => {
  // @spec DLV-QA-001
  it('compiles every TypeScript package strict, with unchecked index access and exact optionals, as ESM', () => {
    const base = JSON.parse(read('tsconfig.base.json')).compilerOptions;
    expect(base).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, module: 'NodeNext' });
    for (const p of [
      'package.json',
      'apps/service/package.json',
      'apps/replay/package.json',
      'packages/shared/package.json',
      'packages/decoder/package.json',
      'bench/package.json',
    ]) {
      expect(JSON.parse(read(p)).type, p).toBe('module');
    }
  });

  // @spec DLV-QA-002
  it('lints with typescript-eslint strict-type-checked and Prettier', () => {
    const cfg = read('eslint.config.js');
    expect(cfg).toContain('tseslint.configs.strictTypeChecked');
    expect(cfg).toContain('eslint-config-prettier');
    expect(JSON.parse(read('package.json')).scripts.lint).toBe('eslint . && prettier --check .');
  });

  // @spec DLV-QA-003
  it('forbids unsafe in the decoder core and documents every unsafe in the napi boundary', () => {
    expect(read('packages/decoder/native/core/src/lib.rs')).toContain('#![forbid(unsafe_code)]');
    const napi = read('packages/decoder/native/napi/src/lib.rs').split('\n');
    const unsafeLines = napi.map((l, i) => [l, i] as const).filter(([l]) => /\bunsafe\b/.test(l) && !l.trim().startsWith('//'));
    expect(unsafeLines.length).toBeGreaterThan(0);
    for (const [, i] of unsafeLines) expect(napi.slice(Math.max(0, i - 3), i).join('\n')).toContain('SAFETY:');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('cargo fmt --check');
    expect(ci).toContain('cargo clippy --all-targets -- -D warnings');
  });
});

describe('image', () => {
  const df = read('docker/Dockerfile');
  // @spec DLV-IMG-001
  it('builds the addon, TypeScript and a node:24-bookworm-slim runtime in stages', () => {
    expect(df).toMatch(/FROM node:\$\{NODE_VERSION\}-bookworm AS build/);
    expect(df).toContain('build:native');
    expect(df).toContain('pnpm build');
    expect(df).toMatch(/FROM node:\$\{NODE_VERSION\}-bookworm-slim AS runtime/);
    expect(df).toMatch(/ARG NODE_VERSION=24/);
  });

  // @spec DLV-IMG-002
  it('runs as a non-root user with a /health healthcheck', () => {
    expect(df).toMatch(/^USER node$/m);
    expect(df).toMatch(/HEALTHCHECK[\s\S]*\/health/);
  });

  // @spec DLV-IMG-003
  it('provides service, replay and bench as commands of one image', () => {
    const ep = read('docker/entrypoint.sh');
    for (const c of ['service)', 'replay)', 'bench)']) expect(ep).toContain(c);
  });

  // @spec DLV-IMG-004
  it('includes the markets file and the committed fixtures', () => {
    expect(df).toContain('COPY --chown=node:node config config');
    expect(df).toContain('COPY --chown=node:node fixtures fixtures');
    expect(readdirSync(new URL('fixtures/', root)).some((f) => f.startsWith('session-'))).toBe(true);
  });
});

describe('compose', () => {
  const c = yaml('docker-compose.yml');
  const env = read('.env');
  // @spec DLV-CMP-001, DLV-CMP-004
  it('runs live mode by default with Redis and Postgres on host port 8080 (configurable), no credentials', () => {
    expect(env).toMatch(/^COMPOSE_PROFILES=live$/m);
    expect(c.services.app.profiles).toEqual(['live']);
    expect(c.services.app.ports).toEqual(['${SOLTAPE_PORT:-8080}:8080']);
    expect(c.services.app.environment.JUPITER_API_KEY).toBe('${JUPITER_API_KEY:-}');
    expect(c.services.redis.profiles).toBeUndefined();
    expect(c.services.postgres.profiles).toBeUndefined();
  });

  // @spec DLV-CMP-002, DLV-CMP-004, DLV-CMP-006
  it('replay profile points the app at the replay server, on the same host port, with the control API published', () => {
    const a = c.services['app-replay'];
    expect(a.profiles).toEqual(['replay']);
    expect(a.ports).toEqual(['${SOLTAPE_PORT:-8080}:8080']);
    expect(a.environment).toMatchObject({ RPC_WS_URL: 'ws://replay:8899', RPC_HTTP_URL: 'http://replay:8899', JUPITER_URL: 'http://replay:8899/price/v3' });
    expect(c.services.replay.command).toEqual(['replay', '--mode', 'realtime', '--port', '8899']);
    expect(c.services.replay.ports).toEqual(['${REPLAY_PORT:-8899}:8899']);
  });

  // @spec DLV-CMP-003
  it('bench profile runs the matrix in the image and writes results to the host', () => {
    expect(c.services.bench.profiles).toEqual(['bench']);
    expect(c.services.bench.command).toEqual(['bench']);
    expect(c.services.bench.volumes).toEqual(['./bench/results:/app/bench/results']);
  });

  // @spec DLV-CMP-005
  it('references the GHCR image with a local build fallback', () => {
    expect(c.services.app.image).toBe('ghcr.io/hmalladi3/soltape:latest');
    expect(c.services.app.build).toEqual({ context: '.', dockerfile: 'docker/Dockerfile' });
    expect(c.services.app.pull_policy).toBe('missing');
  });

  // @spec DLV-CMP-007
  it('passes JUPITER_API_KEY from the host to the live service', () => {
    expect(c.services.app.environment.JUPITER_API_KEY).toBe('${JUPITER_API_KEY:-}');
  });
});

describe('CI', () => {
  const ci = yaml('.github/workflows/ci.yml');
  const steps = (job: string) => (ci.jobs[job].steps as { run?: string }[]).map((s) => s.run ?? '').join('\n');
  // @spec DLV-CI-001
  it('runs lint, typecheck, fixture coverage and unit tests with the native addon present', () => {
    expect(ci.on).toHaveProperty('push');
    expect(ci.on).toHaveProperty('pull_request');
    const s = steps('ts');
    for (const cmd of ['pnpm lint', 'pnpm typecheck', 'node apps/replay/dist/main.js check', 'pnpm vitest run --project unit']) expect(s).toContain(cmd);
    expect(ci.jobs.ts.needs).toBe('rust');
  });

  // @spec DLV-CI-002
  it('runs Rust fmt, clippy and tests and builds the addon', () => {
    const s = steps('rust');
    for (const cmd of ['cargo fmt --check', 'cargo clippy', 'cargo test', 'build:native']) expect(s).toContain(cmd);
  });

  // @spec DLV-CI-003
  it('fuzzes each target for 60 s and uploads reproducers on failure', () => {
    expect(steps('fuzz')).toContain('-max_total_time=60');
    expect(steps('fuzz')).toMatch(/decode_notification decode_account/);
    expect(JSON.stringify(ci.jobs.fuzz.steps)).toContain('fuzz-reproducers');
  });

  // @spec DLV-CI-004, DLV-CI-005
  it('runs the parity suite and the testcontainers integration suite', () => {
    expect(steps('parity')).toContain('parity.test.ts');
    expect(steps('integration')).toContain('--project integration');
  });

  // @spec DLV-CI-006
  it('runs the README offline command and checks health, three sources, degrade and recovery', () => {
    expect(steps('compose-smoke')).toContain('./scripts/compose-smoke.sh');
    const smoke = read('scripts/compose-smoke.sh');
    for (const s of ['docker compose --profile replay up', 'health ok', 'SOL priced by three sources', '"op":"drop","venue":"orca"', 'health degraded', 'health ok after restore'])
      expect(smoke).toContain(s);
    expect(smoke).toMatch(/wait_for 60 "health ok after restore"/);
  });

  // @spec DLV-CI-007
  it('runs a reduced benchmark into the job summary and uploads raw results', () => {
    const s = steps('bench-smoke');
    expect(s).toContain('bench/dist/run.js --quick --summary');
    expect(JSON.stringify(ci.jobs['bench-smoke'].steps)).toContain('bench-results');
    expect(read('bench/src/run.ts')).toContain("quick ? '1000,10000'");
    expect(read('bench/src/run.ts')).toContain("quick ? '1,100'");
  });

  // @spec DLV-CI-008
  it('fails the benchmark job when p99 exceeds 5x the committed baseline', () => {
    expect(steps('bench-smoke')).toContain('bench/dist/regress.js');
    const cell = (p99: number) => ({
      rate: 1000,
      subscribers: 1,
      e2e: { p50: 1, p99, p999: 1, max: 1, samples: 1, conflationRatio: 0, measuredInputs: 1 },
      internal: { p50: 1, p99: 1, p999: 1 },
      eventLoopP99Ms: 0,
      rssMb: 0,
      gcPauseMs: 0,
      persistDrops: 0,
      persistence: '',
    });
    expect(regressions([cell(4999)], { '1000x1': 1000 })).toEqual([]);
    expect(regressions([cell(5001)], { '1000x1': 1000 })).toHaveLength(1);
    expect(regressions([cell(1e9)], { '1000x1': null })).toEqual([]);
  });
});

describe('image publishing', () => {
  const img = yaml('.github/workflows/image.yml');
  // @spec DLV-PUB-001
  it('builds amd64 and arm64 on native runners and merges a multi-arch manifest', () => {
    expect(img.on.push.branches).toEqual(['main']);
    expect(img.on.push.tags).toEqual(['v*']);
    expect(img.jobs.build.strategy.matrix.include).toEqual([
      { platform: 'linux/amd64', runner: 'ubuntu-24.04' },
      { platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    expect(read('.github/workflows/image.yml')).toContain('docker buildx imagetools create');
  });

  // @spec DLV-PUB-002
  it('tags latest on main, sha-<short> always, and semver on tags', () => {
    const tags = read('.github/workflows/image.yml');
    expect(tags).toContain('type=raw,value=latest,enable={{is_default_branch}}');
    expect(tags).toContain('type=sha,prefix=sha-,format=short');
    expect(tags).toContain('type=semver,pattern={{version}}');
  });

  // @spec DLV-PUB-003
  it('authenticates with GITHUB_TOKEN only', () => {
    expect(img.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect((read('.github/workflows/image.yml').match(/secrets\.[A-Z_]+/g) ?? []).every((s) => s === 'secrets.GITHUB_TOKEN')).toBe(true);
  });
});

describe('README', () => {
  // @spec DLV-RDM-001
  it('presents the sections in the required order', () => {
    const r = read('README.md');
    const order = ['actions/workflows/ci.yml/badge.svg', '```mermaid', '## Quickstart', '## Offline mode', '## Break it', '## Latency', '## Run the benchmark'];
    const at = order.map((s) => r.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  // @spec DLV-RDM-002
  it('states the slow-client memory bound and what the depth estimate means', () => {
    const r = read('README.md');
    expect(r).toMatch(/256 KiB/);
    expect(r).toMatch(/depth/i);
    expect(r).toMatch(/active liquidity/i);
  });
});
