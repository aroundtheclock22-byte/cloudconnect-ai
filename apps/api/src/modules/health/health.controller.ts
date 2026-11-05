import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
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
  @Get('metrics') @Header('Content-Type', 'text/plain; version=0.0.4') metrics() { return registry.metrics(); }
}
