import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, can, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';

function range(q: { from?: string; to?: string; days?: string }) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - (Number(q.days) || 30) * 86400_000);
  return { from, to };
}

/**
 * Real-time and historical analytics. Heavy aggregations run against a read replica in production;
 * long-range reports are served from the ClickHouse/warehouse pipeline (see docs/ARCHITECTURE.md).
 */
@ApiTags('analytics')
@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private db: Db) {}

  /** Dashboard widgets: active calls, missed, SMS, user activity, AI insights, call quality, top agents, CSAT proxy. */
  @RequirePermissions('analytics:read:team') @Get('dashboard')
  async dashboard(@CurrentUser() u: AuthUser) {
    const [live, today, sms, users, ai, quality, top, revenue] = await Promise.all([
      this.db.one(`SELECT count(*) FILTER (WHERE status IN ('in_progress','on_hold'))::int "activeCalls", count(*) FILTER (WHERE status='ringing')::int ringing FROM calls WHERE org_id=$1 AND started_at > now() - interval '12 hours'`, [u.orgId]),
      this.db.one(`SELECT count(*)::int total, count(*) FILTER (WHERE direction='inbound' AND answered_at IS NULL AND status NOT IN ('rejected','ringing','in_progress'))::int missed,
          count(*) FILTER (WHERE answered_at IS NOT NULL)::int answered, COALESCE(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL),0)::int "avgDuration",
          count(*) FILTER (WHERE status='voicemail')::int voicemails FROM calls WHERE org_id=$1 AND started_at >= date_trunc('day', now())`, [u.orgId]),
      this.db.one(`SELECT count(*) FILTER (WHERE direction='outbound')::int sent, count(*) FILTER (WHERE direction='inbound')::int received FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.org_id=$1 AND c.kind IN ('sms','group_sms') AND m.created_at >= date_trunc('day', now())`, [u.orgId]),
      this.db.one(`SELECT count(*)::int total, count(*) FILTER (WHERE presence NOT IN ('offline'))::int online, count(*) FILTER (WHERE presence='on_call')::int "onCall" FROM users WHERE org_id=$1 AND deleted_at IS NULL`, [u.orgId]),
      this.db.one(`SELECT count(*)::int analyzed, COALESCE(avg(call_score),0)::int "avgScore", count(*) FILTER (WHERE sentiment='positive')::int positive, count(*) FILTER (WHERE sentiment='negative')::int negative,
          COALESCE(avg((sentiment_score + 1) * 2 + 1), 0)::numeric(3,2) csat FROM ai_insights WHERE org_id=$1 AND source_type='call' AND created_at > now() - interval '7 days'`, [u.orgId]),
      this.db.one(`SELECT COALESCE(avg(mos_score),0)::numeric(3,2) mos, COALESCE(avg(jitter_ms),0)::int jitter, COALESCE(avg(packet_loss_pct),0)::numeric(5,2) "packetLoss" FROM calls WHERE org_id=$1 AND started_at > now() - interval '24 hours' AND mos_score IS NOT NULL`, [u.orgId]),
      this.db.query(`SELECT u.id, u.first_name || ' ' || u.last_name name, count(c.id)::int calls, COALESCE(sum(c.duration_seconds),0)::int "talkSeconds", COALESCE(avg(i.call_score),0)::int "avgScore"
          FROM calls c JOIN users u ON u.id=c.user_id LEFT JOIN ai_insights i ON i.source_type='call' AND i.source_id=c.id
          WHERE c.org_id=$1 AND c.started_at > now() - interval '7 days' AND c.answered_at IS NOT NULL GROUP BY u.id ORDER BY calls DESC, "talkSeconds" DESC LIMIT 5`, [u.orgId]),
      can(u, 'billing:read') ? this.db.one(`SELECT COALESCE(sum(cost_cents),0)::int "usageCents" FROM usage_records WHERE org_id=$1 AND occurred_at >= date_trunc('month', now())`, [u.orgId]) : Promise.resolve(null),
    ]);
    const answerRate = today.total ? Math.round((today.answered / today.total) * 100) : 0;
    return { live, today: { ...today, answerRate }, sms, users, ai, quality, topAgents: top, revenue, networkStatus: { api: 'operational', voice: 'operational', sms: 'operational', video: 'operational' } };
  }

  @RequirePermissions('analytics:read:team') @Get('calls')
  async calls(@CurrentUser() u: AuthUser, @Query() q: { from?: string; to?: string; days?: string; userId?: string }) {
    const { from, to } = range(q);
    const [totals, series, hourly, byCountry, queues] = await Promise.all([
      this.db.one(`SELECT count(*)::int total, count(*) FILTER (WHERE direction='inbound')::int inbound, count(*) FILTER (WHERE direction='outbound')::int outbound,
          count(*) FILTER (WHERE answered_at IS NOT NULL)::int answered, count(*) FILTER (WHERE direction='inbound' AND answered_at IS NULL AND status <> 'rejected')::int missed,
          COALESCE(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL),0)::int "avgDuration", COALESCE(sum(duration_seconds),0)::int "totalSeconds",
          COALESCE(avg(EXTRACT(EPOCH FROM answered_at - started_at)) FILTER (WHERE answered_at IS NOT NULL AND direction='inbound'),0)::int "avgSpeedToAnswer", COALESCE(sum(cost_cents),0)::int "costCents"
        FROM calls WHERE org_id=$1 AND started_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR user_id=$4)`, [u.orgId, from, to, q.userId ?? null]),
      this.db.query(`SELECT date_trunc('day', started_at)::date AS day, count(*)::int total, count(*) FILTER (WHERE answered_at IS NOT NULL)::int answered, count(*) FILTER (WHERE direction='inbound' AND answered_at IS NULL AND status <> 'rejected')::int missed
        FROM calls WHERE org_id=$1 AND started_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR user_id=$4) GROUP BY 1 ORDER BY 1`, [u.orgId, from, to, q.userId ?? null]),
      this.db.query(`SELECT EXTRACT(HOUR FROM started_at AT TIME ZONE o.timezone)::int AS hour, count(*)::int calls FROM calls c JOIN organizations o ON o.id=c.org_id WHERE c.org_id=$1 AND started_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [u.orgId, from, to]),
      this.db.query(`SELECT COALESCE(country,'??') country, count(*)::int calls, COALESCE(sum(duration_seconds),0)::int seconds, COALESCE(sum(cost_cents),0)::int "costCents" FROM calls WHERE org_id=$1 AND started_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 50`, [u.orgId, from, to]),
      this.db.query(`SELECT routing_path->>-1 node, count(*)::int calls, count(*) FILTER (WHERE answered_at IS NOT NULL)::int answered, COALESCE(avg(EXTRACT(EPOCH FROM answered_at - started_at)) FILTER (WHERE answered_at IS NOT NULL),0)::int "avgWait"
        FROM calls WHERE org_id=$1 AND direction='inbound' AND started_at BETWEEN $2 AND $3 AND jsonb_array_length(routing_path) > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [u.orgId, from, to]),
    ]);
    return { from, to, totals: { ...totals, answerRate: totals.total ? Math.round((totals.answered / totals.total) * 1000) / 10 : 0 }, series, hourly, byCountry, queues };
  }

  @RequirePermissions('analytics:read:team') @Get('messaging')
  async messaging(@CurrentUser() u: AuthUser, @Query() q: { from?: string; to?: string; days?: string }) {
    const { from, to } = range(q);
    return this.db.query(`SELECT date_trunc('day', m.created_at)::date AS day, c.kind, count(*) FILTER (WHERE direction='outbound')::int sent, count(*) FILTER (WHERE direction='inbound')::int received,
      count(*) FILTER (WHERE status='failed')::int failed, COALESCE(sum(cost_cents),0)::int "costCents" FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.org_id=$1 AND m.created_at BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1`, [u.orgId, from, to]);
  }

  @RequirePermissions('analytics:read:org') @Get('users')
  async users(@CurrentUser() u: AuthUser, @Query() q: { from?: string; to?: string; days?: string }) {
    const { from, to } = range(q);
    return this.db.query(`SELECT u.id, u.first_name || ' ' || u.last_name name, u.department, u.last_login_at "lastLoginAt",
        (SELECT count(*)::int FROM calls c WHERE c.user_id=u.id AND c.started_at BETWEEN $2 AND $3) calls,
        (SELECT COALESCE(sum(duration_seconds),0)::int FROM calls c WHERE c.user_id=u.id AND c.started_at BETWEEN $2 AND $3) "talkSeconds",
        (SELECT count(*)::int FROM messages m WHERE m.sender_user_id=u.id AND m.created_at BETWEEN $2 AND $3) messages,
        (SELECT COALESCE(avg(i.call_score),0)::int FROM ai_insights i JOIN calls c ON c.id=i.source_id WHERE c.user_id=u.id AND c.started_at BETWEEN $2 AND $3) "avgScore"
      FROM users u WHERE u.org_id=$1 AND u.deleted_at IS NULL ORDER BY calls DESC`, [u.orgId, from, to]);
  }

  @RequirePermissions('analytics:read:team') @Get('ai')
  async ai(@CurrentUser() u: AuthUser, @Query() q: { from?: string; to?: string; days?: string }) {
    const { from, to } = range(q);
    const [sentiment, keywords, coaching] = await Promise.all([
      this.db.query(`SELECT date_trunc('day', created_at)::date AS day, sentiment, count(*)::int n FROM ai_insights WHERE org_id=$1 AND created_at BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY 1`, [u.orgId, from, to]),
      this.db.query(`SELECT k keyword, count(*)::int n FROM ai_insights, unnest(keywords) k WHERE org_id=$1 AND created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 25`, [u.orgId, from, to]),
      this.db.query(`SELECT t tip, count(*)::int n FROM ai_insights, jsonb_array_elements_text(coaching) t WHERE org_id=$1 AND created_at BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [u.orgId, from, to]),
    ]);
    return { sentiment, keywords, coaching };
  }
}
