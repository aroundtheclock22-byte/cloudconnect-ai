import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { encrypt, randomToken } from '../../common/crypto';
import { page, z$ } from '../../common/validation';
import { AiService } from '../ai/ai.service';
import { assertPublicHttpsUrl } from '../platform/webhooks.service';

const Webhook = z.object({ url: z.string().url(), events: z.array(z.string()).min(1) });
const OrgSettings = z.object({ name: z.string().min(2).max(100).optional(), timezone: z.string().optional(), currency: z.string().length(3).optional(), defaultLanguage: z.string().optional(),
  settings: z.object({ recordAllCalls: z.boolean().optional(), recordingRetentionDays: z.number().int().min(1).max(3650).optional(), allowedCountries: z.array(z.string().length(2)).optional(),
    businessHours: z.any().optional(), taxRatePercent: z.number().min(0).max(30).optional(), aiAgents: z.record(z.string(), z.any()).optional(), mfaRequired: z.boolean().optional(),
    sessionTimeoutMinutes: z.number().int().min(5).max(43200).optional(), ipAllowlist: z.array(z.string()).optional(), aiFeatures: z.record(z.string(), z.boolean()).optional() }).partial().optional() });
const Integration = z.object({ provider: z.enum(['salesforce', 'hubspot', 'zoho', 'microsoft_teams', 'slack', 'google_workspace', 'microsoft_365', 'zapier', 'stripe', 'quickbooks', 'calendly', 'zoom', 'outlook', 'gmail']),
  credentials: z.record(z.string(), z.string()), settings: z.record(z.string(), z.any()).default({}) });

export const INTEGRATION_CATALOG = [
  { provider: 'salesforce', category: 'CRM', capabilities: ['screen_pop', 'call_logging', 'click_to_call', 'contact_sync'] },
  { provider: 'hubspot', category: 'CRM', capabilities: ['screen_pop', 'call_logging', 'contact_sync', 'sms_logging'] },
  { provider: 'zoho', category: 'CRM', capabilities: ['call_logging', 'contact_sync'] },
  { provider: 'microsoft_teams', category: 'Collaboration', capabilities: ['direct_routing', 'presence_sync', 'notifications'] },
  { provider: 'slack', category: 'Collaboration', capabilities: ['notifications', 'slash_call', 'voicemail_to_channel'] },
  { provider: 'google_workspace', category: 'Productivity', capabilities: ['calendar', 'contacts', 'sso'] },
  { provider: 'microsoft_365', category: 'Productivity', capabilities: ['calendar', 'contacts', 'sso'] },
  { provider: 'outlook', category: 'Productivity', capabilities: ['calendar', 'meeting_addin'] },
  { provider: 'gmail', category: 'Productivity', capabilities: ['click_to_call', 'voicemail_delivery'] },
  { provider: 'zapier', category: 'Automation', capabilities: ['triggers', 'actions'] },
  { provider: 'stripe', category: 'Finance', capabilities: ['customer_lookup'] },
  { provider: 'quickbooks', category: 'Finance', capabilities: ['invoice_sync', 'customer_lookup'] },
  { provider: 'calendly', category: 'Scheduling', capabilities: ['booking_webhooks', 'ai_appointment_booking'] },
  { provider: 'zoom', category: 'Video', capabilities: ['meeting_interop'] },
];

@ApiTags('admin')
@Controller('v1')
export class AdminController {
  constructor(private db: Db, private ai: AiService) {}

  @Get('organization')
  org(@CurrentUser() u: AuthUser) {
    return this.db.one(`SELECT id, name, slug, timezone, country, currency, default_language "defaultLanguage", data_region "dataRegion", settings, hipaa_enabled "hipaaEnabled", created_at "createdAt" FROM organizations WHERE id=$1`, [u.orgId]);
  }

  @RequirePermissions('security:manage') @Patch('organization')
  async updateOrg(@CurrentUser() u: AuthUser, @Body(z$(OrgSettings)) b: z.infer<typeof OrgSettings>) {
    if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw new BadRequestException('Invalid time zone'); } }
    await this.db.query(`UPDATE organizations SET name=COALESCE($2,name), timezone=COALESCE($3,timezone), currency=COALESCE($4,currency), default_language=COALESCE($5,default_language), settings = settings || COALESCE($6::jsonb, '{}') WHERE id=$1`,
      [u.orgId, b.name ?? null, b.timezone ?? null, b.currency?.toUpperCase() ?? null, b.defaultLanguage ?? null, b.settings ? JSON.stringify(b.settings) : null]);
    return this.org(u);
  }

  @RequirePermissions('audit:read') @Get('audit-logs')
  async audit(@CurrentUser() u: AuthUser, @Query() q: { action?: string; actorId?: string; limit?: string; offset?: string }) {
    const { limit, offset } = page(q);
    return this.db.query(`SELECT a.id, a.actor_id "actorId", a.actor_type "actorType", a.action, a.target_type "targetType", a.target_id "targetId", a.ip, a.user_agent "userAgent", a.metadata, a.created_at "createdAt",
        u.first_name || ' ' || u.last_name "actorName"
      FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.org_id=$1 AND ($2::text IS NULL OR a.action ILIKE '%' || $2 || '%') AND ($3::uuid IS NULL OR a.actor_id=$3)
      ORDER BY a.created_at DESC LIMIT $4 OFFSET $5`, [u.orgId, q.action ?? null, q.actorId ?? null, limit, offset]);
  }

  /** Security center: MFA coverage, active sessions, fraud events, failed logins. */
  @RequirePermissions('security:manage') @Get('security/overview')
  async security(@CurrentUser() u: AuthUser) {
    const [mfa, sessions, failed, fraud, keys] = await Promise.all([
      this.db.one(`SELECT count(*)::int users, count(*) FILTER (WHERE mfa_enabled)::int "mfaEnabled" FROM users WHERE org_id=$1 AND deleted_at IS NULL`, [u.orgId]),
      this.db.one(`SELECT count(*)::int active FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.org_id=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [u.orgId]),
      this.db.query(`SELECT ip, count(*)::int attempts, max(created_at) "lastAt" FROM audit_logs WHERE org_id=$1 AND action='auth.login_failed' AND created_at > now() - interval '24 hours' GROUP BY ip ORDER BY 2 DESC LIMIT 20`, [u.orgId]),
      this.db.query(`SELECT kind, score, details, action, created_at "createdAt" FROM fraud_events WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50`, [u.orgId]),
      this.db.one(`SELECT count(*)::int active FROM api_keys WHERE org_id=$1 AND revoked_at IS NULL`, [u.orgId]),
    ]);
    return { mfa, sessions, failedLogins: failed, fraudEvents: fraud, apiKeys: keys, encryption: { atRest: 'AES-256 (RDS/S3 KMS) + AES-256-GCM field-level', inTransit: 'TLS 1.2+ / SRTP' } };
  }

  @RequirePermissions('security:manage') @HttpCode(200) @Post('security/users/:id/revoke-sessions')
  async revokeAll(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const r = await this.db.query(`UPDATE sessions s SET revoked_at=now() FROM users u WHERE u.id=s.user_id AND u.id=$1 AND u.org_id=$2 AND s.revoked_at IS NULL RETURNING s.id`, [id, u.orgId]);
    return { revoked: r.length };
  }

  /** GDPR: export all personal data held about a user (Art. 15/20). */
  @RequirePermissions('security:manage') @Get('privacy/users/:id/export')
  async gdprExport(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const user = await this.db.one(`SELECT id, email, first_name, last_name, title, department, timezone, language, created_at, last_login_at FROM users WHERE id=$1 AND org_id=$2`, [id, u.orgId]);
    if (!user) throw new BadRequestException('Unknown user');
    const [calls, messages, contacts, meetings] = await Promise.all([
      this.db.query(`SELECT id, direction, from_number, to_number, started_at, duration_seconds FROM calls WHERE user_id=$1`, [id]),
      this.db.query(`SELECT id, body, created_at FROM messages WHERE sender_user_id=$1`, [id]),
      this.db.query(`SELECT * FROM contacts WHERE owner_id=$1`, [id]),
      this.db.query(`SELECT id, title, scheduled_start FROM meetings WHERE host_id=$1`, [id]),
    ]);
    return { exportedAt: new Date().toISOString(), user, calls, messages, contacts, meetings };
  }

  /** GDPR erasure (Art. 17) for an external party: removes contact records and redacts message bodies for a phone number. */
  @RequirePermissions('security:manage') @HttpCode(200) @Post('privacy/erase')
  async erase(@CurrentUser() u: AuthUser, @Body() b: { e164: string }) {
    if (!/^\+\d{7,15}$/.test(b?.e164 ?? '')) throw new BadRequestException('e164 required');
    return this.db.tx(u.orgId, async (c) => {
      const contacts = await c.query(`DELETE FROM contacts WHERE org_id=$1 AND $2 = ANY(phones) RETURNING id`, [u.orgId, b.e164]);
      const msgs = await c.query(`UPDATE messages SET body='[erased]', media='[]' WHERE org_id=$1 AND (from_address=$2 OR $2 = ANY(to_addresses)) RETURNING id`, [u.orgId, b.e164]);
      const vms = await c.query(`UPDATE voicemails SET transcript=NULL, ai_summary=NULL, storage_key='erased' WHERE org_id=$1 AND from_number=$2 RETURNING id`, [u.orgId, b.e164]);
      await c.query(`UPDATE calls SET from_number=CASE WHEN from_number=$2 THEN '+00000000000' ELSE from_number END, to_number=CASE WHEN to_number=$2 THEN '+00000000000' ELSE to_number END WHERE org_id=$1`, [u.orgId, b.e164]);
      return { contacts: contacts.rowCount, messages: msgs.rowCount, voicemails: vms.rowCount };
    });
  }

  // ───── Webhooks ─────
  @RequirePermissions('webhooks:manage') @Get('webhooks')
  hooks(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, url, events, enabled, created_at "createdAt" FROM webhooks WHERE org_id=$1`, [u.orgId]); }

  @RequirePermissions('webhooks:manage') @Post('webhooks')
  async createHook(@CurrentUser() u: AuthUser, @Body(z$(Webhook)) b: z.infer<typeof Webhook>) {
    try { await assertPublicHttpsUrl(b.url); } catch (e) { throw new BadRequestException((e as Error).message); }
    const secret = `whsec_${randomToken(24)}`;
    const h = await this.db.one(`INSERT INTO webhooks (org_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING id, url, events, enabled`, [u.orgId, b.url, b.events, secret]);
    return { ...h, secret };
  }

  @RequirePermissions('webhooks:manage') @HttpCode(204) @Delete('webhooks/:id')
  async deleteHook(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM webhooks WHERE id=$1 AND org_id=$2`, [id, u.orgId]); }

  @RequirePermissions('webhooks:manage') @Get('webhooks/:id/deliveries')
  deliveries(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.db.query(`SELECT d.id, d.event, d.status_code "statusCode", d.attempt, d.delivered_at "deliveredAt", d.next_retry_at "nextRetryAt", d.created_at "createdAt" FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.id=$1 AND w.org_id=$2 ORDER BY d.id DESC LIMIT 100`, [id, u.orgId]);
  }

  // ───── Integrations ─────
  @RequirePermissions('integrations:manage') @Get('integrations')
  async integrations(@CurrentUser() u: AuthUser) {
    const connected = await this.db.query(`SELECT provider, settings, created_at "connectedAt" FROM integrations WHERE org_id=$1`, [u.orgId]);
    return INTEGRATION_CATALOG.map((c) => ({ ...c, connected: connected.find((x) => x.provider === c.provider) ?? null }));
  }

  @RequirePermissions('integrations:manage') @Post('integrations')
  async connect(@CurrentUser() u: AuthUser, @Body(z$(Integration)) b: z.infer<typeof Integration>) {
    await this.db.query(`INSERT INTO integrations (org_id, provider, credentials_encrypted, settings, connected_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (org_id, provider) DO UPDATE SET credentials_encrypted=EXCLUDED.credentials_encrypted, settings=EXCLUDED.settings`, [u.orgId, b.provider, encrypt(JSON.stringify(b.credentials)), b.settings, u.userId]);
    return { provider: b.provider, connected: true };
  }

  @RequirePermissions('integrations:manage') @HttpCode(204) @Delete('integrations/:provider')
  async disconnect(@CurrentUser() u: AuthUser, @Param('provider') p: string) { await this.db.query(`DELETE FROM integrations WHERE org_id=$1 AND provider=$2`, [u.orgId, p]); }

  // ───── AI utilities ─────
  @RequirePermissions('ai:use') @HttpCode(200) @Post('ai/translate')
  translate(@Body() b: { text: string; targetLanguage: string }) {
    if (!b?.text || !b.targetLanguage) throw new BadRequestException('text and targetLanguage required');
    return this.ai.translate(String(b.text).slice(0, 5000), b.targetLanguage);
  }

  @RequirePermissions('ai:use') @HttpCode(200) @Post('ai/draft')
  async draft(@Body() b: { context: string; tone?: string }) {
    return { suggestions: await this.ai.draftReplies([{ direction: 'inbound', body: String(b?.context ?? '').slice(0, 4000) }], b?.tone) };
  }

  @RequirePermissions('ai:use') @HttpCode(200) @Post('ai/analyze')
  analyze(@Body() b: { transcript: string; kind?: 'call' | 'meeting' | 'voicemail' }) {
    if (!b?.transcript) throw new BadRequestException('transcript required');
    return this.ai.analyze(String(b.transcript), b.kind ?? 'call');
  }

  @Get('ai/status')
  aiStatus() { return { llm: this.ai.enabled ? 'openai' : 'heuristic', features: ['receptionist', 'summaries', 'sentiment', 'action_items', 'keywords', 'call_scoring', 'coaching', 'translation', 'reply_drafting', 'transcription'] }; }
}
