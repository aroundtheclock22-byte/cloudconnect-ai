import { Controller, Get, Header, NotFoundException, Req, ServiceUnavailableException } from '@nestjs/common';
import { Request } from 'express';
import { safeEqual } from '../../common/crypto';
import { isPrivateAddress } from '../platform/webhooks.service';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { Public } from '../../common/auth';
import { Db } from '../../common/db.service';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'cc_' });
export const httpDuration = new Histogram({ name: 'cc_http_request_duration_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry] });
export const httpErrors = new Counter({ name: 'cc_http_errors_total', help: 'HTTP 5xx responses', labelNames: ['route'], registers: [registry] });

@ApiExcludeController() @Public() @SkipThrottle()
@Controller()
export class HealthController {
  constructor(private db: Db) {}
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') async ready() {
    try { await this.db.query('SELECT 1'); return { status: 'ok', db: 'ok' }; } catch { throw new ServiceUnavailableException({ status: 'degraded', db: 'down' }); }
  }
  /** Prometheus scrape: allowed with METRICS_TOKEN bearer, or from private networks (in-cluster scrapers). */
  @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(@Req() req: Request) {
    const token = process.env.METRICS_TOKEN;
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const ip = (req.ip ?? '').replace(/^::ffff:/, '');
    const allowed = (token && safeEqual(bearer, token)) || isPrivateAddress(ip) || (!token && process.env.NODE_ENV !== 'production');
    if (!allowed) throw new NotFoundException();
    return registry.metrics();
  }
}
