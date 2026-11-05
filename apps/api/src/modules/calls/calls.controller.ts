import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, can, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { page } from '../../common/validation';
import { TelephonyService } from '../telephony/telephony.service';

const CALL_COLS = `c.id, c.direction, c.status, c.from_number "from", c.to_number "to", c.user_id "userId", c.started_at "startedAt", c.answered_at "answeredAt", c.ended_at "endedAt",
  c.duration_seconds "durationSeconds", c.cost_cents "costCents", c.country, c.mos_score "mosScore", c.spam_score "spamScore", c.tags, c.routing_path "routingPath"`;

@ApiTags('calls')
@Controller('v1')
export class CallsController {
  constructor(private db: Db, private tel: TelephonyService) {}

  /** Call log. Users see their own calls unless they hold calls:read:all. */
  @RequirePermissions('calls:read:own') @Get('calls')
  async list(@CurrentUser() u: AuthUser, @Query() q: { direction?: string; status?: string; from?: string; to?: string; userId?: string; q?: string; limit?: string; offset?: string }) {
    const { limit, offset } = page(q);
    const all = can(u, 'calls:read:all');
    const rows = await this.db.query(
      `SELECT ${CALL_COLS}, u.first_name || ' ' || u.last_name "userName", i.sentiment, i.call_score "callScore", (r.id IS NOT NULL) "hasRecording", count(*) OVER() total
       FROM calls c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN ai_insights i ON i.source_type='call' AND i.source_id=c.id
       LEFT JOIN LATERAL (SELECT id FROM recordings WHERE call_id=c.id AND status='ready' LIMIT 1) r ON true
       WHERE c.org_id=$1 AND ($2::boolean OR c.user_id=$3) AND ($4::text IS NULL OR c.direction::text=$4) AND ($5::text IS NULL OR c.status::text=$5)
         AND ($6::timestamptz IS NULL OR c.started_at >= $6) AND ($7::timestamptz IS NULL OR c.started_at < $7) AND ($8::uuid IS NULL OR c.user_id=$8)
         AND ($9::text IS NULL OR c.from_number LIKE '%' || $9 || '%' OR c.to_number LIKE '%' || $9 || '%')
       ORDER BY c.started_at DESC LIMIT $10 OFFSET $11`,
      [u.orgId, all, u.userId, q.direction ?? null, q.status ?? null, q.from ?? null, q.to ?? null, all ? q.userId ?? null : null, q.q ?? null, limit, offset]);
    return { data: rows.map(({ total, ...r }) => r), total: Number(rows[0]?.total ?? 0), limit, offset };
  }

  /** Live calls for the supervisor wallboard. */
  @RequirePermissions('calls:monitor') @Get('calls/active')
  active(@CurrentUser() u: AuthUser) {
    return this.db.query(`SELECT ${CALL_COLS}, u.first_name || ' ' || u.last_name "userName", EXTRACT(EPOCH FROM now() - c.started_at)::int "elapsedSeconds"
      FROM calls c LEFT JOIN users u ON u.id=c.user_id WHERE c.org_id=$1 AND c.status IN ('ringing','in_progress','on_hold') AND c.started_at > now() - interval '12 hours' ORDER BY c.started_at`, [u.orgId]);
  }

  @RequirePermissions('calls:read:own') @Get('calls/:id')
  async get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const c = await this.db.one(`SELECT ${CALL_COLS} FROM calls c WHERE c.id=$1 AND c.org_id=$2`, [id, u.orgId]);
    if (!c || (c.userId !== u.userId && !can(u, 'calls:read:all'))) throw new NotFoundException();
    const [events, recordings, transcript, insights] = await Promise.all([
      this.db.query(`SELECT type, actor_id "actorId", data, created_at "createdAt" FROM call_events WHERE call_id=$1 AND type <> 'ai_turn' ORDER BY id`, [id]),
      this.db.query(`SELECT id, duration_seconds "durationSeconds", status, created_at "createdAt" FROM recordings WHERE call_id=$1 AND status <> 'deleted'`, [id]),
      this.db.one(`SELECT full_text "text", segments, language FROM transcripts WHERE source_type='call' AND source_id=$1`, [id]),
      this.db.one(`SELECT summary, sentiment, sentiment_score "sentimentScore", action_items "actionItems", keywords, call_score "callScore", coaching, model FROM ai_insights WHERE source_type='call' AND source_id=$1`, [id]),
    ]);
    return { ...c, events, recordings, transcript, insights };
  }

  @RequirePermissions('calls:read:own') @Patch('calls/:id/tags')
  async tags(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { tags: string[] }) {
    const r = await this.db.one(`UPDATE calls SET tags=$3 WHERE id=$1 AND org_id=$2 AND (user_id=$4 OR $5) RETURNING tags`, [id, u.orgId, (b.tags ?? []).slice(0, 20).map(String), u.userId, can(u, 'calls:read:all')]);
    if (!r) throw new NotFoundException();
    return r;
  }

  /** Re-run AI analysis (summary, sentiment, action items, keywords, score, coaching) from a transcript. */
  @RequirePermissions('ai:use') @HttpCode(200) @Post('calls/:id/analyze')
  async analyze(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { transcript?: string }) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1 AND org_id=$2`, [id, u.orgId]);
    if (!call || (call.user_id !== u.userId && !can(u, 'calls:read:all'))) throw new NotFoundException();
    const existing = await this.db.one(`SELECT full_text FROM transcripts WHERE source_type='call' AND source_id=$1`, [id]);
    const text = b?.transcript ?? existing?.full_text;
    if (!text) throw new NotFoundException('No transcript available for this call');
    return this.tel.analyzeCall(call, undefined, text);
  }

  @RequirePermissions('recordings:read:own') @Get('recordings/:id')
  async recording(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.db.one(`SELECT r.*, c.user_id FROM recordings r LEFT JOIN calls c ON c.id=r.call_id WHERE r.id=$1 AND r.org_id=$2 AND r.status='ready'`, [id, u.orgId]);
    if (!r || (r.user_id !== u.userId && !can(u, 'recordings:read:all'))) throw new NotFoundException();
    // Production: return a 5-minute presigned S3 GET URL for r.storage_key (SSE-KMS). Dev: carrier URL.
    return { id: r.id, url: r.storage_key, expiresIn: 300, durationSeconds: r.duration_seconds };
  }

  @RequirePermissions('recordings:delete') @HttpCode(204) @Delete('recordings/:id')
  async deleteRecording(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.db.query(`UPDATE recordings SET status='deleted' WHERE id=$1 AND org_id=$2`, [id, u.orgId]);
  }

  // ───── Voicemail ─────
  @RequirePermissions('voicemail:read:own') @Get('voicemails')
  voicemails(@CurrentUser() u: AuthUser, @Query() q: { unread?: string; limit?: string; offset?: string }) {
    const { limit, offset } = page(q);
    return this.db.query(`SELECT v.id, v.from_number "from", v.duration_seconds "durationSeconds", v.transcript, v.ai_summary "aiSummary", v.is_read "isRead", v.created_at "createdAt", b.name mailbox,
        ct.first_name || ' ' || ct.last_name "contactName"
      FROM voicemails v JOIN voicemail_boxes b ON b.id=v.mailbox_id LEFT JOIN LATERAL (SELECT first_name, last_name FROM contacts WHERE org_id=v.org_id AND v.from_number = ANY(phones) LIMIT 1) ct ON true
      WHERE v.org_id=$1 AND (b.user_id=$2 OR $3::boolean OR b.user_id IS NULL) AND ($4::boolean IS NOT TRUE OR NOT v.is_read)
      ORDER BY v.created_at DESC LIMIT $5 OFFSET $6`, [u.orgId, u.userId, can(u, 'voicemail:read:all'), q.unread === 'true', limit, offset]);
  }

  @RequirePermissions('voicemail:read:own') @Get('voicemails/:id/audio')
  async voicemailAudio(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const v = await this.db.one(`SELECT v.storage_key, b.user_id FROM voicemails v JOIN voicemail_boxes b ON b.id=v.mailbox_id WHERE v.id=$1 AND v.org_id=$2`, [id, u.orgId]);
    if (!v || (v.user_id && v.user_id !== u.userId && !can(u, 'voicemail:read:all'))) throw new NotFoundException();
    return { url: v.storage_key, expiresIn: 300 };
  }

  @RequirePermissions('voicemail:read:own') @Patch('voicemails/:id')
  async markVoicemail(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { isRead: boolean }) {
    const r = await this.db.one(`UPDATE voicemails v SET is_read=$3 FROM voicemail_boxes b WHERE b.id=v.mailbox_id AND v.id=$1 AND v.org_id=$2 AND (b.user_id=$4 OR $5::boolean OR b.user_id IS NULL) RETURNING v.id, v.is_read "isRead"`,
      [id, u.orgId, !!b.isRead, u.userId, can(u, 'voicemail:read:all')]);
    if (!r) throw new ForbiddenException();
    return r;
  }

  @RequirePermissions('voicemail:read:own') @HttpCode(204) @Delete('voicemails/:id')
  async deleteVoicemail(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.db.query(`DELETE FROM voicemails v USING voicemail_boxes b WHERE b.id=v.mailbox_id AND v.id=$1 AND v.org_id=$2 AND (b.user_id=$3 OR $4::boolean)`, [id, u.orgId, u.userId, can(u, 'voicemail:read:all')]);
  }
}
