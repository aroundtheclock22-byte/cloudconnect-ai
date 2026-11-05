import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Db } from '../../common/db.service';
import { EventBus, EventEnvelope } from '../../common/events';
import { hmacHex } from '../../common/crypto';

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:') && isPrivateAddress(ip.slice(7));
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** SSRF guard for customer-supplied webhook URLs. */
export async function assertPublicHttpsUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('Webhook URL must use https');
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('Webhook URL resolves to a private address');
}

export function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${hmacHex(secret, `${ts}.${body}`)}`;
}

const BACKOFF_SECONDS = [30, 120, 600, 3600, 6 * 3600];

/** Delivers domain events to customer webhooks with HMAC signatures and exponential retry. */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  constructor(private db: Db, private bus: EventBus) {}

  onModuleInit() {
    this.bus.on('event', (e: EventEnvelope) => this.enqueue(e).catch((err) => this.log.error(err)));
    if (process.env.NODE_ENV !== 'test') this.timer = setInterval(() => this.retryDue().catch(() => undefined), 15_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async enqueue(e: EventEnvelope) {
    const hooks = await this.db.query(`SELECT id, url, secret FROM webhooks WHERE org_id=$1 AND enabled AND ($2 = ANY(events) OR '*' = ANY(events))`, [e.orgId, e.type]);
    for (const h of hooks) {
      const payload = { id: e.id, type: e.type, created_at: e.createdAt, data: e.data };
      const d = await this.db.one(`INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES ($1,$2,$3) RETURNING id`, [h.id, e.type, payload]);
      await this.deliver(d.id, h, payload, 1);
    }
  }

  async deliver(deliveryId: number, hook: { url: string; secret: string }, payload: object, attempt: number) {
    const body = JSON.stringify(payload);
    let status = 0;
    try {
      await assertPublicHttpsUrl(hook.url);
      const res = await fetch(hook.url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'CloudConnect-Webhooks/1.0', 'X-CloudConnect-Signature': signPayload(hook.secret, body) } });
      status = res.status;
    } catch { status = 0; }
    const ok = status >= 200 && status < 300;
    const next = !ok && attempt <= BACKOFF_SECONDS.length ? new Date(Date.now() + BACKOFF_SECONDS[attempt - 1] * 1000) : null;
    await this.db.query(`UPDATE webhook_deliveries SET status_code=$2, attempt=$3, delivered_at=$4, next_retry_at=$5 WHERE id=$1`,
      [deliveryId, status || null, attempt, ok ? new Date() : null, next]);
  }

  async retryDue() {
    const due = await this.db.query(`SELECT d.id, d.payload, d.attempt, w.url, w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
      WHERE d.delivered_at IS NULL AND d.next_retry_at <= now() AND w.enabled ORDER BY d.next_retry_at LIMIT 100`);
    for (const d of due) await this.deliver(d.id, d, d.payload, d.attempt + 1);
  }
}
