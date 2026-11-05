import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { canAssignRole, ROLES } from '@cloudconnect/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { EventBus } from '../../common/events';
import { page, z$ } from '../../common/validation';
import { randomToken } from '../../common/crypto';

const Invite = z.object({ email: z.string().email().toLowerCase(), firstName: z.string().min(1), lastName: z.string().default(''), role: z.enum(ROLES).default('EMPLOYEE'),
  department: z.string().optional(), title: z.string().optional(), extension: z.string().regex(/^\d{2,6}$/).optional() });
const UpdateUser = z.object({ firstName: z.string().optional(), lastName: z.string().optional(), role: z.enum(ROLES).optional(), department: z.string().nullable().optional(),
  title: z.string().nullable().optional(), status: z.enum(['active', 'suspended']).optional(), timezone: z.string().optional(), language: z.string().optional() });
const Presence = z.object({ status: z.enum(['available', 'busy', 'on_call', 'in_meeting', 'away', 'dnd', 'offline']), note: z.string().max(140).optional() });
const Forwarding = z.object({ dnd: z.boolean().optional(), forwarding: z.object({ always: z.string().optional(), busy: z.string().optional(), noAnswer: z.string().optional(), simultaneous: z.array(z.string()).max(10).optional() }).optional() });
const Team = z.object({ name: z.string().min(1).max(80), memberIds: z.array(z.string().uuid()).default([]) });
const Device = z.object({ kind: z.enum(['web', 'ios', 'android', 'windows', 'macos', 'linux', 'desk_phone', 'sip']), name: z.string().min(1), pushToken: z.string().optional(), macAddress: z.string().optional(), userId: z.string().uuid().optional() });

const USER_COLS = `u.id, u.email, u.first_name "firstName", u.last_name "lastName", u.role, u.title, u.department, u.presence, u.presence_note "presenceNote", u.status, u.mfa_enabled "mfaEnabled", u.last_login_at "lastLoginAt", u.created_at "createdAt", e.number extension`;

@ApiTags('users')
@Controller('v1')
export class DirectoryController {
  constructor(private db: Db, private bus: EventBus) {}

  @RequirePermissions('users:read') @Get('users')
  async list(@CurrentUser() u: AuthUser, @Query() q: { q?: string; role?: string; department?: string; limit?: string; offset?: string }) {
    const { limit, offset } = page(q);
    const rows = await this.db.query(
      `SELECT ${USER_COLS}, count(*) OVER() total FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user'
       WHERE u.org_id=$1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR u.first_name || ' ' || u.last_name || ' ' || u.email ILIKE '%' || $2 || '%' OR e.number = $2)
         AND ($3::text IS NULL OR u.role::text=$3) AND ($4::text IS NULL OR u.department=$4)
       ORDER BY u.first_name, u.last_name LIMIT $5 OFFSET $6`, [u.orgId, q.q ?? null, q.role ?? null, q.department ?? null, limit, offset]);
    return { data: rows.map(({ total, ...r }) => r), total: Number(rows[0]?.total ?? 0), limit, offset };
  }

  @RequirePermissions('users:read') @Get('users/:id')
  async get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const row = await this.db.one(`SELECT ${USER_COLS}, e.forwarding, e.dnd FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user' WHERE u.id=$1 AND u.org_id=$2 AND u.deleted_at IS NULL`, [id, u.orgId]);
    if (!row) throw new NotFoundException();
    return row;
  }

  @RequirePermissions('users:write') @Post('users')
  async invite(@CurrentUser() u: AuthUser, @Body(z$(Invite)) b: z.infer<typeof Invite>) {
    if (!canAssignRole(u.role, b.role)) throw new ForbiddenException(`You cannot assign role ${b.role}`);
    if (await this.db.one(`SELECT 1 FROM users WHERE email=$1 AND deleted_at IS NULL`, [b.email])) throw new ConflictException('Email already in use');
    const tempPassword = randomToken(12) + 'Aa1';
    const created = await this.db.tx(u.orgId, async (c) => {
      const row = (await c.query(`INSERT INTO users (org_id, email, password_hash, first_name, last_name, role, department, title, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'invited') RETURNING id`,
        [u.orgId, b.email, await bcrypt.hash(tempPassword, 12), b.firstName, b.lastName, b.role, b.department ?? null, b.title ?? null])).rows[0];
      const ext = b.extension ?? (await c.query(`SELECT COALESCE(MAX(number::int), 100) + 1 n FROM extensions WHERE org_id=$1 AND number ~ '^[0-9]{3}$' AND number::int < 700`, [u.orgId])).rows[0].n.toString();
      await c.query(`INSERT INTO extensions (org_id, number, user_id) VALUES ($1,$2,$3)`, [u.orgId, ext, row.id]);
      await c.query(`INSERT INTO voicemail_boxes (org_id, user_id, name) VALUES ($1,$2,$3)`, [u.orgId, row.id, `${b.firstName}'s voicemail`]);
      await c.query(`UPDATE subscriptions SET seats = GREATEST(seats, (SELECT count(*) FROM users WHERE org_id=$1 AND deleted_at IS NULL)) WHERE org_id=$1`, [u.orgId]);
      return { id: row.id, extension: ext };
    });
    this.bus.publish('user.created', u.orgId, { userId: created.id, email: b.email });
    // The notifications worker emails an invite link (user.created); the temp password is never returned in production.
    return { ...created, email: b.email, status: 'invited', ...(process.env.NODE_ENV !== 'production' ? { tempPassword } : {}) };
  }

  @RequirePermissions('users:write') @Patch('users/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(UpdateUser)) b: z.infer<typeof UpdateUser>) {
    const target = await this.db.one(`SELECT role FROM users WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [id, u.orgId]);
    if (!target) throw new NotFoundException();
    if (!canAssignRole(u.role, target.role) || (b.role && !canAssignRole(u.role, b.role))) throw new ForbiddenException('Insufficient privilege for this role change');
    if (id === u.userId && b.role && b.role !== target.role) throw new ForbiddenException('You cannot change your own role');
    await this.db.query(`UPDATE users SET first_name=COALESCE($3,first_name), last_name=COALESCE($4,last_name), role=COALESCE($5,role), department=CASE WHEN $6::boolean THEN $7 ELSE department END,
      title=CASE WHEN $8::boolean THEN $9 ELSE title END, status=COALESCE($10,status), timezone=COALESCE($11,timezone), language=COALESCE($12,language) WHERE id=$1 AND org_id=$2`,
      [id, u.orgId, b.firstName ?? null, b.lastName ?? null, b.role ?? null, b.department !== undefined, b.department ?? null, b.title !== undefined, b.title ?? null, b.status ?? null, b.timezone ?? null, b.language ?? null]);
    if (b.status === 'suspended') await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
    return this.get(u, id);
  }

  @RequirePermissions('users:delete') @HttpCode(204) @Delete('users/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    if (id === u.userId) throw new BadRequestException('You cannot delete yourself');
    const target = await this.db.one(`SELECT role FROM users WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`, [id, u.orgId]);
    if (!target) throw new NotFoundException();
    if (!canAssignRole(u.role, target.role)) throw new ForbiddenException();
    await this.db.tx(u.orgId, async (c) => {
      await c.query(`UPDATE users SET deleted_at=now(), status='suspended', email = email || '.deleted.' || extract(epoch from now())::bigint WHERE id=$1`, [id]);
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1`, [id]);
      await c.query(`UPDATE extensions SET user_id=NULL WHERE user_id=$1`, [id]);
      await c.query(`UPDATE phone_numbers SET assigned_user_id=NULL WHERE assigned_user_id=$1`, [id]);
    });
  }

  @Put('me/presence')
  async presence(@CurrentUser() u: AuthUser, @Body(z$(Presence)) b: z.infer<typeof Presence>) {
    await this.db.query(`UPDATE users SET presence=$2, presence_note=$3 WHERE id=$1`, [u.userId, b.status, b.note ?? null]);
    this.bus.publish('presence.changed', u.orgId, { userId: u.userId, status: b.status, note: b.note });
    return { status: b.status, note: b.note ?? null };
  }

  @Put('me/call-handling')
  async forwarding(@CurrentUser() u: AuthUser, @Body(z$(Forwarding)) b: z.infer<typeof Forwarding>) {
    const r = await this.db.one(`UPDATE extensions SET dnd=COALESCE($2,dnd), forwarding=COALESCE($3,forwarding) WHERE user_id=$1 AND kind='user' RETURNING dnd, forwarding`, [u.userId, b.dnd ?? null, b.forwarding ?? null]);
    return r;
  }

  /** Company directory with presence (click-to-call source). */
  @RequirePermissions('users:read') @Get('directory')
  directory(@CurrentUser() u: AuthUser) {
    return this.db.query(`SELECT u.id, u.first_name "firstName", u.last_name "lastName", u.title, u.department, u.presence, u.avatar_url "avatarUrl", e.number extension
      FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user' WHERE u.org_id=$1 AND u.deleted_at IS NULL AND u.status='active' ORDER BY u.first_name`, [u.orgId]);
  }

  @RequirePermissions('users:read') @Get('teams')
  teams(@CurrentUser() u: AuthUser) {
    return this.db.query(`SELECT t.id, t.name, COALESCE(array_agg(m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') "memberIds" FROM teams t LEFT JOIN team_members m ON m.team_id=t.id WHERE t.org_id=$1 GROUP BY t.id ORDER BY t.name`, [u.orgId]);
  }

  @RequirePermissions('teams:write') @Post('teams')
  async createTeam(@CurrentUser() u: AuthUser, @Body(z$(Team)) b: z.infer<typeof Team>) {
    return this.db.tx(u.orgId, async (c) => {
      const t = (await c.query(`INSERT INTO teams (org_id, name) VALUES ($1,$2) RETURNING id, name`, [u.orgId, b.name])).rows[0];
      if (b.memberIds.length) await c.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE org_id=$2 AND id = ANY($3::uuid[])`, [t.id, u.orgId, b.memberIds]);
      return { ...t, memberIds: b.memberIds };
    });
  }

  @RequirePermissions('teams:write') @HttpCode(204) @Delete('teams/:id')
  async deleteTeam(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM teams WHERE id=$1 AND org_id=$2`, [id, u.orgId]); }

  @Get('devices')
  devices(@CurrentUser() u: AuthUser) {
    return this.db.query(`SELECT id, kind, name, user_id "userId", verified, last_seen_at "lastSeenAt", sip_username "sipUsername" FROM devices WHERE org_id=$1 AND ($2::boolean OR user_id=$3) ORDER BY created_at DESC`,
      [u.orgId, ['COMPANY_OWNER', 'ADMINISTRATOR', 'SUPER_ADMIN'].includes(u.role), u.userId]);
  }

  /** Registers an app install (push token) or provisions a desk phone / SIP device with credentials. */
  @Post('devices')
  async registerDevice(@CurrentUser() u: AuthUser, @Body(z$(Device)) b: z.infer<typeof Device>) {
    const sip = ['desk_phone', 'sip'].includes(b.kind);
    if (sip && !['COMPANY_OWNER', 'ADMINISTRATOR', 'SUPER_ADMIN'].includes(u.role)) throw new ForbiddenException('devices:manage required');
    const sipPassword = sip ? randomToken(18) : null;
    const d = await this.db.one(`INSERT INTO devices (org_id, user_id, kind, name, push_token, mac_address, sip_username, sip_password_hash, verified) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, kind, name, sip_username "sipUsername"`,
      [u.orgId, b.userId ?? u.userId, b.kind, b.name, b.pushToken ?? null, b.macAddress ?? null, sip ? `cc${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}` : null, sipPassword ? await bcrypt.hash(sipPassword, 10) : null, !sip]);
    return { ...d, ...(sipPassword ? { sipPassword, sipDomain: 'sip.cloudconnect.ai', transport: 'TLS', srtp: 'required' } : {}) };
  }

  @HttpCode(204) @Delete('devices/:id')
  async removeDevice(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.db.query(`DELETE FROM devices WHERE id=$1 AND org_id=$2 AND (user_id=$3 OR $4::boolean)`, [id, u.orgId, u.userId, ['COMPANY_OWNER', 'ADMINISTRATOR'].includes(u.role)]);
  }
}
