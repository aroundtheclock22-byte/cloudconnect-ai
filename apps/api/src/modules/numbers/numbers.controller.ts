import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { countryOf, isTollFree, normalizeE164, validateFlow, vanityToDigits, RoutingFlow } from '@cloudconnect/shared';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { EventBus } from '../../common/events';
import { encrypt } from '../../common/crypto';
import { z$ } from '../../common/validation';
import { config } from '../../config';
import { TelephonyService } from '../telephony/telephony.service';

const Search = z.object({ country: z.string().length(2).default('US'), type: z.enum(['local', 'toll_free']).default('local'), areaCode: z.string().regex(/^\d{2,4}$/).optional(), contains: z.string().max(10).optional(), vanity: z.string().max(12).optional() });
const Purchase = z.object({ e164: z.string(), label: z.string().max(60).optional(), assignedUserId: z.string().uuid().optional(), temporaryDays: z.number().int().min(1).max(90).optional(), vanity: z.string().optional() });
const UpdateNumber = z.object({ label: z.string().max(60).nullable().optional(), assignedUserId: z.string().uuid().nullable().optional(), routingFlowId: z.string().uuid().nullable().optional(), callerIdName: z.string().max(15).nullable().optional() });
const Port = z.object({ numbers: z.array(z.string()).min(1).max(500), losingCarrier: z.string().min(2), accountNumber: z.string().min(1), pin: z.string().optional(), loaDocumentKey: z.string().optional() });
const Block = z.object({ e164: z.string(), reason: z.string().max(200).optional() });
const Flow = z.object({ name: z.string().min(1).max(100), definition: z.any(), published: z.boolean().default(false) });
const Trunk = z.object({ name: z.string().min(1), provider: z.string().min(2), terminationUri: z.string().regex(/^sips?:/), ipAcl: z.array(z.string()).default([]), maxChannels: z.number().int().min(1).max(10000).default(30), srtpRequired: z.boolean().default(true) });

const NUM_COLS = `id, e164, type, status, country, label, vanity, provider, capabilities, assigned_user_id "assignedUserId", routing_flow_id "routingFlowId", caller_id_name "callerIdName", expires_at "expiresAt", monthly_cost_cents "monthlyCostCents", created_at "createdAt"`;

@ApiTags('numbers')
@Controller('v1')
export class NumbersController {
  constructor(private db: Db, private tel: TelephonyService, private bus: EventBus) {}

  @RequirePermissions('numbers:read') @Get('numbers')
  list(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT ${NUM_COLS} FROM phone_numbers WHERE org_id=$1 AND status <> 'released' ORDER BY created_at`, [u.orgId]); }

  @RequirePermissions('numbers:write') @Get('numbers/available')
  async search(@Query(z$(Search)) q: z.infer<typeof Search>) {
    const contains = q.vanity ? vanityToDigits(q.vanity) : q.contains;
    return this.tel.provider.searchNumbers({ country: q.country, type: q.type, areaCode: q.areaCode, contains, limit: 20 });
  }

  /** Purchase local, toll-free, vanity, international or temporary numbers. */
  @RequirePermissions('numbers:write') @Post('numbers')
  async purchase(@CurrentUser() u: AuthUser, @Body(z$(Purchase)) b: z.infer<typeof Purchase>) {
    const e164 = normalizeE164(b.e164);
    if (!e164) throw new BadRequestException('Invalid number');
    if (await this.db.one(`SELECT 1 FROM phone_numbers WHERE e164=$1 AND status <> 'released'`, [e164])) throw new ConflictException('Number already in use');
    const base = `${config().PUBLIC_URL}/v1/telephony/${this.tel.provider.name}`;
    const { providerSid } = await this.tel.provider.purchaseNumber(e164, { voiceUrl: `${base}/voice`, smsUrl: `${base}/sms` });
    const country = countryOf(e164) ?? 'US';
    const type = b.temporaryDays ? 'temporary' : b.vanity ? 'vanity' : isTollFree(e164) ? 'toll_free' : country !== 'US' ? 'international' : 'local';
    const row = await this.db.one(`INSERT INTO phone_numbers (org_id, e164, type, country, label, vanity, provider, provider_sid, assigned_user_id, expires_at, monthly_cost_cents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $10::int IS NULL THEN NULL ELSE now() + make_interval(days => $10::int) END, $11) RETURNING ${NUM_COLS}`,
      [u.orgId, e164, type, country, b.label ?? null, b.vanity ?? null, this.tel.provider.name === 'mock' ? 'twilio' : this.tel.provider.name, providerSid, b.assignedUserId ?? null, b.temporaryDays ?? null, type === 'toll_free' ? 500 : 300]);
    await this.db.query(`INSERT INTO usage_records (org_id, kind, quantity, cost_cents, source_id) VALUES ($1,'number',1,$2,$3)`, [u.orgId, row.monthlyCostCents, row.id]);
    this.bus.publish('number.purchased', u.orgId, { numberId: row.id, e164 });
    return row;
  }

  @RequirePermissions('numbers:write') @Patch('numbers/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(UpdateNumber)) b: z.infer<typeof UpdateNumber>) {
    if (b.routingFlowId && !(await this.db.one(`SELECT 1 FROM routing_flows WHERE id=$1 AND org_id=$2`, [b.routingFlowId, u.orgId]))) throw new BadRequestException('Unknown routing flow');
    if (b.assignedUserId && !(await this.db.one(`SELECT 1 FROM users WHERE id=$1 AND org_id=$2`, [b.assignedUserId, u.orgId]))) throw new BadRequestException('Unknown user');
    const set = (k: keyof typeof b) => b[k] !== undefined;
    const row = await this.db.one(`UPDATE phone_numbers SET label=CASE WHEN $3 THEN $4 ELSE label END, assigned_user_id=CASE WHEN $5 THEN $6::uuid ELSE assigned_user_id END,
      routing_flow_id=CASE WHEN $7 THEN $8::uuid ELSE routing_flow_id END, caller_id_name=CASE WHEN $9 THEN $10 ELSE caller_id_name END WHERE id=$1 AND org_id=$2 RETURNING ${NUM_COLS}`,
      [id, u.orgId, set('label'), b.label ?? null, set('assignedUserId'), b.assignedUserId ?? null, set('routingFlowId'), b.routingFlowId ?? null, set('callerIdName'), b.callerIdName ?? null]);
    if (!row) throw new NotFoundException();
    return row;
  }

  @RequirePermissions('numbers:write') @HttpCode(204) @Delete('numbers/:id')
  async release(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const n = await this.db.one(`UPDATE phone_numbers SET status='released', routing_flow_id=NULL, assigned_user_id=NULL WHERE id=$1 AND org_id=$2 AND status <> 'released' RETURNING provider_sid`, [id, u.orgId]);
    if (!n) throw new NotFoundException();
    if (n.provider_sid) await this.tel.provider.releaseNumber(n.provider_sid);
  }

  @RequirePermissions('numbers:port') @Post('numbers/port-requests')
  port(@CurrentUser() u: AuthUser, @Body(z$(Port)) b: z.infer<typeof Port>) {
    const nums = b.numbers.map((n) => normalizeE164(n));
    if (nums.some((n) => !n)) throw new BadRequestException('Invalid number in port request');
    return this.db.one(`INSERT INTO port_requests (org_id, numbers, losing_carrier, account_number, pin_encrypted, loa_document_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, numbers, status, created_at "createdAt"`,
      [u.orgId, nums, b.losingCarrier, b.accountNumber, b.pin ? encrypt(b.pin) : null, b.loaDocumentKey ?? null]);
  }
  @RequirePermissions('numbers:read') @Get('numbers/port-requests')
  ports(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, numbers, losing_carrier "losingCarrier", status, foc_date "focDate", created_at "createdAt" FROM port_requests WHERE org_id=$1 ORDER BY created_at DESC`, [u.orgId]); }

  @RequirePermissions('routing:read') @Get('blocked-numbers')
  blocked(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT e164, reason, created_at "createdAt" FROM blocked_numbers WHERE org_id=$1 ORDER BY created_at DESC`, [u.orgId]); }
  @RequirePermissions('calls:make') @Post('blocked-numbers')
  async block(@CurrentUser() u: AuthUser, @Body(z$(Block)) b: z.infer<typeof Block>) {
    const e164 = normalizeE164(b.e164); if (!e164) throw new BadRequestException('Invalid number');
    await this.db.query(`INSERT INTO blocked_numbers (org_id, e164, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.orgId, e164, b.reason ?? null]);
    return { e164 };
  }
  @RequirePermissions('routing:write') @HttpCode(204) @Delete('blocked-numbers/:e164')
  async unblock(@CurrentUser() u: AuthUser, @Param('e164') e164: string) { await this.db.query(`DELETE FROM blocked_numbers WHERE org_id=$1 AND e164=$2`, [u.orgId, e164]); }

  // ───── Routing flows (auto receptionist, IVR, ring/hunt groups, business hours) ─────
  @RequirePermissions('routing:read') @Get('routing-flows')
  flows(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, name, definition, version, published, updated_at "updatedAt" FROM routing_flows WHERE org_id=$1 ORDER BY name`, [u.orgId]); }

  @RequirePermissions('routing:write') @Post('routing-flows')
  async createFlow(@CurrentUser() u: AuthUser, @Body(z$(Flow)) b: z.infer<typeof Flow>) {
    this.assertFlow(b.definition);
    return this.db.one(`INSERT INTO routing_flows (org_id, name, definition, published, updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, definition, version, published`, [u.orgId, b.name, b.definition, b.published, u.userId]);
  }

  @RequirePermissions('routing:write') @Put('routing-flows/:id')
  async updateFlow(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(Flow)) b: z.infer<typeof Flow>) {
    this.assertFlow(b.definition);
    const r = await this.db.one(`UPDATE routing_flows SET name=$3, definition=$4, published=$5, version=version+1, updated_by=$6, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING id, name, definition, version, published`, [id, u.orgId, b.name, b.definition, b.published, u.userId]);
    if (!r) throw new NotFoundException();
    return r;
  }

  @RequirePermissions('routing:write') @HttpCode(204) @Delete('routing-flows/:id')
  async deleteFlow(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM routing_flows WHERE id=$1 AND org_id=$2`, [id, u.orgId]); }

  @RequirePermissions('routing:read') @HttpCode(200) @Post('routing-flows/validate')
  validate(@Body() b: { definition: RoutingFlow }) { return { errors: this.errors(b.definition) }; }

  private errors(def: any): string[] {
    if (!def || typeof def !== 'object' || typeof def.entry !== 'string' || typeof def.nodes !== 'object') return ['definition must have entry and nodes'];
    return validateFlow(def);
  }
  private assertFlow(def: any) { const e = this.errors(def); if (e.length) throw new BadRequestException({ message: 'Invalid routing flow', errors: e }); }

  // ───── SIP trunks ─────
  @RequirePermissions('sip:manage') @Get('sip-trunks')
  trunks(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, name, provider, termination_uri "terminationUri", auth->'ipAcl' "ipAcl", max_channels "maxChannels", srtp_required "srtpRequired" FROM sip_trunks WHERE org_id=$1`, [u.orgId]); }
  @RequirePermissions('sip:manage') @Post('sip-trunks')
  createTrunk(@CurrentUser() u: AuthUser, @Body(z$(Trunk)) b: z.infer<typeof Trunk>) {
    return this.db.one(`INSERT INTO sip_trunks (org_id, name, provider, termination_uri, auth, max_channels, srtp_required) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, provider, termination_uri "terminationUri", max_channels "maxChannels", srtp_required "srtpRequired"`,
      [u.orgId, b.name, b.provider, b.terminationUri, { ipAcl: b.ipAcl }, b.maxChannels, b.srtpRequired]);
  }
  @RequirePermissions('sip:manage') @HttpCode(204) @Delete('sip-trunks/:id')
  async deleteTrunk(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM sip_trunks WHERE id=$1 AND org_id=$2`, [id, u.orgId]); }
}
