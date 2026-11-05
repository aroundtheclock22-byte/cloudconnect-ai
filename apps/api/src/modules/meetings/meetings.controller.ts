import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { EventBus } from '../../common/events';
import { z$ } from '../../common/validation';
import { config } from '../../config';
import { AiService } from '../ai/ai.service';

const Meeting = z.object({ title: z.string().min(1).max(200), mode: z.enum(['meeting', 'webinar']).default('meeting'), scheduledStart: z.string().datetime().optional(), scheduledEnd: z.string().datetime().optional(),
  timezone: z.string().optional(), passcode: z.string().min(4).max(20).optional(), waitingRoom: z.boolean().default(true), autoRecord: z.boolean().default(false), liveCaptions: z.boolean().default(true),
  invitees: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).max(500).default([]) });
const Join = z.object({ displayName: z.string().min(1).max(80), email: z.string().email().optional(), passcode: z.string().optional() });

const COLS = `m.id, m.title, m.join_code "joinCode", m.mode, m.scheduled_start "scheduledStart", m.scheduled_end "scheduledEnd", m.timezone, m.waiting_room "waitingRoom", m.auto_record "autoRecord",
  m.live_captions "liveCaptions", m.started_at "startedAt", m.ended_at "endedAt", m.host_id "hostId", (m.passcode_hash IS NOT NULL) "hasPasscode"`;

/**
 * LiveKit access token (SFU for HD video, simulcast, screen share, recording/egress).
 * Grants follow https://docs.livekit.io/home/get-started/authentication/
 */
export function livekitToken(p: { identity: string; name: string; room: string; canPublish: boolean; admin?: boolean; ttl?: number; metadata?: object }) {
  const c = config();
  return jwt.sign({ name: p.name, metadata: JSON.stringify(p.metadata ?? {}),
    video: { room: p.room, roomJoin: true, canPublish: p.canPublish, canSubscribe: true, canPublishData: true, roomAdmin: !!p.admin, roomRecord: !!p.admin } },
    c.LIVEKIT_API_SECRET, { issuer: c.LIVEKIT_API_KEY, subject: p.identity, expiresIn: p.ttl ?? 6 * 3600, jwtid: p.identity + Date.now() });
}

function ics(m: any, url: string) {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = m.scheduledStart ? new Date(m.scheduledStart) : new Date();
  const end = m.scheduledEnd ? new Date(m.scheduledEnd) : new Date(start.getTime() + 3600_000);
  const e = (s: string) => s.replace(/[\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CloudConnect AI//Meetings//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${m.id}@cloudconnect.ai`, `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${e(m.title)}`, `LOCATION:${url}`, `DESCRIPTION:${e(`Join: ${url}\nMeeting code: ${m.joinCode}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

@ApiTags('meetings')
@Controller('v1/meetings')
export class MeetingsController {
  constructor(private db: Db, private bus: EventBus, private ai: AiService) {}

  @RequirePermissions('meetings:join') @Get()
  list(@CurrentUser() u: AuthUser, @Query('upcoming') upcoming?: string) {
    return this.db.query(`SELECT ${COLS}, (SELECT count(*)::int FROM meeting_participants p WHERE p.meeting_id=m.id) participants FROM meetings m
      WHERE m.org_id=$1 AND (m.host_id=$2 OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id=m.id AND p.user_id=$2))
        AND ($3::boolean IS NOT TRUE OR (m.ended_at IS NULL AND (m.scheduled_start IS NULL OR m.scheduled_start > now() - interval '2 hours')))
      ORDER BY COALESCE(m.scheduled_start, m.created_at) DESC LIMIT 200`, [u.orgId, u.userId, upcoming === 'true']);
  }

  @RequirePermissions('meetings:host') @Post()
  async create(@CurrentUser() u: AuthUser, @Body(z$(Meeting)) b: z.infer<typeof Meeting>) {
    if (b.scheduledStart && b.scheduledEnd && new Date(b.scheduledEnd) <= new Date(b.scheduledStart)) throw new BadRequestException('scheduledEnd must be after scheduledStart');
    const code = Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join('');
    return this.db.tx(u.orgId, async (c) => {
      const m = (await c.query(`INSERT INTO meetings AS m (org_id, host_id, title, join_code, passcode_hash, mode, scheduled_start, scheduled_end, timezone, waiting_room, auto_record, live_captions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLS}`,
        [u.orgId, u.userId, b.title, code, b.passcode ? await bcrypt.hash(b.passcode, 10) : null, b.mode, b.scheduledStart ?? null, b.scheduledEnd ?? null, b.timezone ?? null, b.waitingRoom, b.autoRecord, b.liveCaptions])).rows[0];
      for (const i of b.invitees) {
        const user = (await c.query(`SELECT id, first_name FROM users WHERE org_id=$1 AND email=$2`, [u.orgId, i.email])).rows[0];
        await c.query(`INSERT INTO meeting_participants (meeting_id, user_id, display_name, email, role) VALUES ($1,$2,$3,$4,$5)`, [m.id, user?.id ?? null, i.name ?? user?.first_name ?? i.email, i.email, b.mode === 'webinar' ? 'attendee' : 'attendee']);
      }
      return { ...m, joinUrl: `${config().WEB_URL}/meet/${m.joinCode}` };
    });
  }

  @RequirePermissions('meetings:host') @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(Meeting.partial())) b: Partial<z.infer<typeof Meeting>>) {
    const r = await this.db.one(`UPDATE meetings m SET title=COALESCE($3,title), scheduled_start=COALESCE($4,scheduled_start), scheduled_end=COALESCE($5,scheduled_end), waiting_room=COALESCE($6,waiting_room), auto_record=COALESCE($7,auto_record)
      WHERE id=$1 AND org_id=$2 AND host_id=$8 RETURNING ${COLS}`, [id, u.orgId, b.title ?? null, b.scheduledStart ?? null, b.scheduledEnd ?? null, b.waitingRoom ?? null, b.autoRecord ?? null, u.userId]);
    if (!r) throw new NotFoundException();
    return r;
  }

  @RequirePermissions('meetings:host') @HttpCode(204) @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM meetings WHERE id=$1 AND org_id=$2 AND host_id=$3`, [id, u.orgId, u.userId]); }

  @Public() @Get(':code/ics') @Header('Content-Type', 'text/calendar; charset=utf-8')
  async icsFile(@Param('code') code: string) {
    const m = await this.db.one(`SELECT ${COLS} FROM meetings m WHERE join_code=$1`, [code]);
    if (!m) throw new NotFoundException();
    return ics(m, `${config().WEB_URL}/meet/${m.joinCode}`);
  }

  /** Join by code. Authenticated org members join directly; guests go to the waiting room if enabled. */
  @Public() @HttpCode(200) @Post(':code/join')
  async join(@Param('code') code: string, @Body(z$(Join)) b: z.infer<typeof Join>, @CurrentUser() u?: AuthUser) {
    const m = await this.db.one(`SELECT m.*, (m.passcode_hash IS NOT NULL) has_pass FROM meetings m WHERE join_code=$1 AND ended_at IS NULL`, [code]);
    if (!m) throw new NotFoundException('Meeting not found or has ended');
    const member = u && u.orgId === m.org_id;
    if (m.has_pass && !member && !(b.passcode && (await bcrypt.compare(b.passcode, m.passcode_hash)))) throw new ForbiddenException('Invalid passcode');
    const isHost = !!u && u.userId === m.host_id;
    const role = isHost ? 'host' : 'attendee';
    const p = await this.db.one(`INSERT INTO meeting_participants (meeting_id, user_id, display_name, email, role, joined_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END) RETURNING id`,
      [m.id, u?.userId ?? null, b.displayName, b.email ?? null, role, isHost || !m.waiting_room || member]);
    if (isHost && !m.started_at) {
      await this.db.query(`UPDATE meetings SET started_at=now() WHERE id=$1`, [m.id]);
      this.bus.publish('meeting.started', m.org_id, { meetingId: m.id });
    }
    if (m.waiting_room && !isHost && !member) {
      this.bus.publish('meeting.waiting', m.org_id, { meetingId: m.id, participantId: p.id, displayName: b.displayName }, [m.host_id]);
      return { status: 'waiting', participantId: p.id };
    }
    return this.admitted(m, p.id, b.displayName, role, isHost);
  }

  private admitted(m: any, participantId: string, name: string, role: string, isHost: boolean) {
    const canPublish = m.mode !== 'webinar' || isHost || role === 'panelist' || role === 'cohost';
    return { status: 'admitted', participantId, livekitUrl: config().LIVEKIT_URL, room: `${m.org_id}:${m.join_code}`,
      token: livekitToken({ identity: participantId, name, room: `${m.org_id}:${m.join_code}`, canPublish, admin: isHost, metadata: { role } }),
      features: { recording: m.auto_record, liveCaptions: m.live_captions, whiteboard: true, virtualBackgrounds: true, screenShare: canPublish } };
  }

  /** Waiting-room poll for guests (also pushed via websocket when admitted). */
  @Public() @Get(':code/participants/:pid/status')
  async waitStatus(@Param('code') code: string, @Param('pid') pid: string) {
    const r = await this.db.one(`SELECT p.*, m.* , p.id pid, p.role prole FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id WHERE m.join_code=$1 AND p.id=$2`, [code, pid]);
    if (!r) throw new NotFoundException();
    if (!r.joined_at) return { status: r.left_at ? 'denied' : 'waiting' };
    return this.admitted(r, r.pid, r.display_name, r.prole, false);
  }

  @RequirePermissions('meetings:host') @HttpCode(200) @Post(':id/participants/:pid/:decision')
  async admit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('pid') pid: string, @Param('decision') decision: string) {
    if (!['admit', 'deny', 'promote'].includes(decision)) throw new BadRequestException();
    const m = await this.db.one(`SELECT id FROM meetings WHERE id=$1 AND host_id=$2`, [id, u.userId]);
    if (!m) throw new NotFoundException();
    const sql = decision === 'admit' ? `joined_at=now()` : decision === 'deny' ? `left_at=now()` : `role='panelist'`;
    await this.db.query(`UPDATE meeting_participants SET ${sql} WHERE id=$1 AND meeting_id=$2`, [pid, id]);
    return { ok: true };
  }

  /** Breakout rooms: returns per-room tokens for the host to distribute. */
  @RequirePermissions('meetings:host') @HttpCode(200) @Post(':id/breakouts')
  async breakouts(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { rooms: { name: string; participantIds: string[] }[] }) {
    const m = await this.db.one(`SELECT * FROM meetings WHERE id=$1 AND host_id=$2`, [id, u.userId]);
    if (!m) throw new NotFoundException();
    const out = [];
    for (const [i, r] of (b.rooms ?? []).slice(0, 50).entries()) {
      const room = `${m.org_id}:${m.join_code}:br${i + 1}`;
      await this.db.query(`UPDATE meeting_participants SET breakout_room=$3 WHERE meeting_id=$1 AND id = ANY($2::uuid[])`, [id, r.participantIds, r.name]);
      out.push({ name: r.name, room, participants: r.participantIds.map((pid) => ({ participantId: pid, token: livekitToken({ identity: pid, name: pid, room, canPublish: true }) })) });
    }
    return { rooms: out };
  }

  @RequirePermissions('meetings:host') @HttpCode(200) @Post(':id/end')
  async end(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { transcript?: string }) {
    const m = await this.db.one(`UPDATE meetings SET ended_at=now() WHERE id=$1 AND host_id=$2 AND ended_at IS NULL RETURNING *`, [id, u.userId]);
    if (!m) throw new NotFoundException();
    await this.db.query(`UPDATE meeting_participants SET left_at=COALESCE(left_at, now()) WHERE meeting_id=$1`, [id]);
    this.bus.publish('meeting.ended', m.org_id, { meetingId: id });
    if (b?.transcript) await this.notes(u, id, { transcript: b.transcript });
    return { ok: true };
  }

  /** AI meeting notes: summary, action items, keywords from the meeting transcript. */
  @RequirePermissions('ai:use') @HttpCode(200) @Post(':id/notes')
  async notes(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { transcript?: string }) {
    const m = await this.db.one(`SELECT id, org_id FROM meetings WHERE id=$1 AND org_id=$2`, [id, u.orgId]);
    if (!m) throw new NotFoundException();
    if (b?.transcript) await this.db.query(`INSERT INTO transcripts (org_id, source_type, source_id, full_text) VALUES ($1,'meeting',$2,$3) ON CONFLICT (source_type, source_id) DO UPDATE SET full_text=EXCLUDED.full_text`, [m.org_id, id, b.transcript]);
    const t = await this.db.one(`SELECT full_text FROM transcripts WHERE source_type='meeting' AND source_id=$1`, [id]);
    if (!t) throw new NotFoundException('No transcript yet');
    const a = await this.ai.analyze(t.full_text, 'meeting');
    await this.db.query(`INSERT INTO ai_insights (org_id, source_type, source_id, summary, sentiment, sentiment_score, action_items, keywords, model) VALUES ($1,'meeting',$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (source_type, source_id) DO UPDATE SET summary=EXCLUDED.summary, action_items=EXCLUDED.action_items, keywords=EXCLUDED.keywords, sentiment=EXCLUDED.sentiment`,
      [m.org_id, id, a.summary, a.sentiment, a.sentimentScore, JSON.stringify(a.actionItems), a.keywords, a.model]);
    return { summary: a.summary, actionItems: a.actionItems, keywords: a.keywords, sentiment: a.sentiment };
  }

  /** Meeting analytics: attendance & engagement. */
  @RequirePermissions('meetings:host') @Get(':id/analytics')
  async analytics(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.db.one(`SELECT m.title, m.started_at, m.ended_at, EXTRACT(EPOCH FROM (COALESCE(m.ended_at, now()) - m.started_at))::int duration_seconds,
      count(p.id)::int invited, count(p.joined_at)::int attended, COALESCE(avg(EXTRACT(EPOCH FROM (COALESCE(p.left_at, m.ended_at, now()) - p.joined_at))) FILTER (WHERE p.joined_at IS NOT NULL), 0)::int avg_attendance_seconds
      FROM meetings m LEFT JOIN meeting_participants p ON p.meeting_id=m.id WHERE m.id=$1 AND m.org_id=$2 GROUP BY m.id`, [id, u.orgId]);
    if (!r) throw new NotFoundException();
    return r;
  }
}
