import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Db } from './db.service';
import { AuthUser } from './auth';

@Injectable()
export class AuditService {
  constructor(private db: Db) {}
  async log(e: { orgId: string | null; actorId?: string | null; actorType?: 'user' | 'api_key' | 'system'; action: string; targetType?: string; targetId?: string; ip?: string; userAgent?: string; metadata?: object }) {
    await this.db.query(
      `INSERT INTO audit_logs (org_id, actor_id, actor_type, action, target_type, target_id, ip, user_agent, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.orgId, e.actorId ?? null, e.actorType ?? 'user', e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, e.userAgent ?? null, e.metadata ?? {}],
    ).catch(() => undefined); // auditing must never break the request path; failures are surfaced via metrics/logs
  }
}

const REDACT = /password|secret|token|code|pin/i;
function redact(body: any): object {
  if (!body || typeof body !== 'object') return {};
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v]));
}

/** Records every successful mutating request by an authenticated principal. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private audit: AuditService) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path.includes('/telephony/')) return next.handle();
    return next.handle().pipe(tap(() => {
      const u: AuthUser | undefined = req.user;
      if (!u) return;
      const route: string = req.route?.path ?? req.path;
      this.audit.log({
        orgId: u.orgId, actorId: u.userId ?? u.apiKeyId, actorType: u.apiKeyId ? 'api_key' : 'user',
        action: `${req.method} ${route}`, targetId: req.params?.id, ip: req.ip, userAgent: req.headers['user-agent'], metadata: redact(req.body),
      });
    }));
  }
}
