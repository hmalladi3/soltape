import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Clock } from '@soltape/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import type { MarketModel } from '../markets/model.js';
import type { Reconciler } from '../reconcile/reconciler.js';
import type { PhaseHolder, ServerLifecycle } from '../runtime/runtime.js';
import type { LatencyWindow } from '../telemetry/latency.js';
import type { Logger } from '../telemetry/logger.js';
import { ApiError } from './errors.js';
import type { WsGateway } from './gateway.js';
import { computeHealth, type DependencyStatus } from './health.js';
import { parseHistoryQuery, type HistoryReader } from './history.js';
import { resolveMintOrThrow } from './mint.js';
import { restConsolidated, restObservation } from './views.js';

export interface ApiServerDeps {
  port: number;
  host?: string;
  model: MarketModel;
  reconciler: Reconciler;
  gateway: WsGateway;
  phase: PhaseHolder;
  clock: Clock;
  logger: Logger;
  decoderImpl: 'native' | 'reference';
  dependencies: DependencyStatus;
  latency: LatencyWindow;
  history?: HistoryReader;
  /** Prometheus text exposition (wave 5 telemetry); empty until wired. */
  metrics?: () => Promise<{ contentType: string; body: string }>;
  /** HTTP request metrics (soltape_http_requests_total, soltape_http_request_seconds). */
  httpMetrics?: { httpRequests: { inc(labels: { route: string; status: string }): void }; httpSeconds: { observe(labels: { route: string }, v: number): void } };
  maxPayload?: number;
}

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

/**
 * One HTTP server for REST, the live page and WebSocket upgrades on `/ws`.
 * @spec API-HTTP-001, API-HTTP-007
 */
export class ApiServer implements ServerLifecycle {
  readonly http: Server;
  private readonly wss: WebSocketServer;
  private accepting = true;
  private readonly startedAt: number;
  private readonly log: Logger;

  constructor(private readonly d: ApiServerDeps) {
    this.startedAt = d.clock.mono();
    this.log = d.logger.child({ component: 'api' });
    this.http = createServer(this.app());
    // @spec API-WS-009, API-WS-020
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: d.maxPayload ?? 4096 });
    this.http.on('upgrade', (req, socket, head) => {
      if (!this.accepting || new URL(req.url ?? '/', 'http://x').pathname !== '/ws') {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.d.gateway.accept(ws));
    });
  }

  get port(): number {
    return (this.http.address() as AddressInfo).port;
  }

  async listen(): Promise<void> {
    this.d.gateway.start();
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.d.port, this.d.host ?? '0.0.0.0', () => resolve());
    });
  }

  stopAccepting(): Promise<void> {
    this.accepting = false;
    this.http.close();
    this.http.closeIdleConnections();
    return Promise.resolve();
  }

  async closeClients(code: number): Promise<void> {
    this.d.gateway.stop();
    await this.d.gateway.closeAll(code);
    this.http.closeAllConnections();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  private app(): express.Express {
    const d = this.d;
    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false);
    app.use((req, res, next) => {
      res.locals['requestId'] = randomUUID();
      const t0 = d.clock.mono();
      res.on('finish', () => {
        if (!d.httpMetrics) return;
        // Route templates only (e.g. /price/:mint): label values stay bounded (OBS-MET-007).
        const route = (req.route as { path?: string } | undefined)?.path ?? (res.statusCode === 404 ? 'unmatched' : 'static');
        d.httpMetrics.httpRequests.inc({ route, status: String(res.statusCode) });
        d.httpMetrics.httpSeconds.observe({ route }, (d.clock.mono() - t0) / 1000);
      });
      next();
    });

    // @spec API-REST-001, API-REST-002
    app.get('/price/:mint', (req, res) => {
      const m = resolveMintOrThrow(d.model, req.params.mint);
      const c = d.reconciler.consolidated(m);
      if (d.reconciler.available(m) && c) return void res.json(restConsolidated(c));
      throw new ApiError(503, 'NO_ELIGIBLE_SOURCES', `No eligible source for ${d.model.markets[m]!.symbol}`, { lastKnown: c ? restConsolidated(c) : null });
    });

    // @spec API-REST-003
    app.get('/sources/:mint', (req, res) => {
      const m = resolveMintOrThrow(d.model, req.params.mint);
      const market = d.model.markets[m]!;
      res.json({ mint: market.mint, symbol: market.symbol, sources: d.reconciler.observations(m).map(restObservation) });
    });

    // @spec API-REST-004
    app.get('/mints', (_req, res) => {
      res.json({
        quote: d.model.quote,
        markets: d.model.markets.map((m) => ({ mint: m.mint, symbol: m.symbol, venues: m.venues.map((v) => ({ venue: v.venue, kind: v.kind, source: v.sourceId })) })),
      });
    });

    // @spec API-REST-005, API-REST-006, API-REST-007, API-REST-008
    app.get('/history/:mint', async (req, res) => {
      const m = resolveMintOrThrow(d.model, req.params.mint);
      if (!d.history?.available()) throw new ApiError(503, 'HISTORY_UNAVAILABLE', 'History storage is unavailable');
      const q = parseHistoryQuery(req.query, d.clock.wall(), d.history.retentionStartMs());
      const market = d.model.markets[m]!;
      let buckets;
      try {
        buckets = await d.history.query(market.mint, q.fromMs, q.toMs, q.bucket);
      } catch (err) {
        this.log.warn({ err }, 'history query failed');
        throw new ApiError(503, 'HISTORY_UNAVAILABLE', 'History query failed or timed out');
      }
      res.json({
        mint: market.mint,
        symbol: market.symbol,
        from: new Date(q.fromMs).toISOString(),
        to: new Date(q.toMs).toISOString(),
        bucket: q.bucket,
        clamped: q.clamped,
        buckets,
      });
    });

    app.get('/health', (_req, res) => {
      const h = computeHealth({
        model: d.model,
        reconciler: d.reconciler,
        phase: d.phase,
        clock: d.clock,
        startedAt: this.startedAt,
        decoderImpl: d.decoderImpl,
        dependencies: d.dependencies,
      });
      res.status(h.http).json(h.body);
    });

    // @spec API-REST-009
    app.get('/stats', (_req, res) => {
      const s = d.latency.summary();
      res.json({
        latencyUs: { p50: s.p50, p99: s.p99, p999: s.p999, max: s.max },
        samples: s.count,
        updatesPerSec: Math.round(s.ratePerSec * 10) / 10,
        windowMs: Math.round(s.windowMs),
        sources: (['orca', 'raydium', 'jupiter'] as const).map((id) => ({ id, state: d.reconciler.sourceStatus(id).state })),
        decoder: d.decoderImpl,
        clients: d.gateway.stats.clients,
      });
    });

    // @spec API-REST-010
    app.get('/metrics', async (_req, res) => {
      const m = (await d.metrics?.()) ?? { contentType: 'text/plain; version=0.0.4; charset=utf-8', body: '' };
      res.type(m.contentType).send(m.body);
    });

    // @spec API-UI-001
    app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

    app.use((_req: Request, _res: Response) => {
      throw new ApiError(404, 'NOT_FOUND', 'No such endpoint');
    });

    // @spec API-HTTP-005, API-HTTP-006
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const requestId = String(res.locals['requestId']);
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message, requestId }, ...err.extra });
        return;
      }
      this.log.error({ err, requestId }, 'unhandled request error');
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error', requestId } });
    });
    return app;
  }
}
