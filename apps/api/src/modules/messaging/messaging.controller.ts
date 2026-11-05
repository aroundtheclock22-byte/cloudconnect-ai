import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { z$ } from '../../common/validation';
import { AiService } from '../ai/ai.service';
import { MessagingService } from './messaging.service';
import { smsSegments } from './sms';
import { verifyWebhook } from '../telephony/telephony.controller';

const Send = z.object({ from: z.string().optional(), to: z.array(z.string()).min(1).max(10), body: z.string().max(1600).default(''), mediaUrls: z.array(z.string().url()).max(10).optional(),
  scheduledAt: z.string().datetime().optional(), templateId: z.string().uuid().optional(), vars: z.record(z.string()).optional() });
const Bulk = z.object({ name: z.string().min(1), from: z.string().optional(), body: z.string().min(1).max(1600), to: z.array(z.string()).optional(), contactGroupId: z.string().uuid().optional(), scheduledAt: z.string().datetime().optional() });
const Chat = z.object({ title: z.string().max(80).optional(), memberIds: z.array(z.string().uuid()).min(1) });
const ChatMsg = z.object({ body: z.string().max(10_000).default(''), attachments: z.array(z.object({ key: z.string(), contentType: z.string(), size: z.number().int().max(100 * 1024 * 1024), name: z.string().optional() })).max(10).optional() });
const Template = z.object({ name: z.string().min(1).max(80), body: z.string().min(1).max(1600) });
const AutoReply = z.object({ phoneNumberId: z.string().uuid(), trigger: z.enum(['after_hours', 'keyword', 'always', 'missed_call']), keyword: z.string().max(30).optional(), body: z.string().min(1).max(640), enabled: z.boolean().default(true) });

@ApiTags('messaging')
@Controller('v1')
export class MessagingController {
  constructor(private svc: MessagingService, private db: Db, private ai: AiService) {}

  @RequirePermissions('sms:send') @Post('messages')
  send(@CurrentUser() u: AuthUser, @Body(z$(Send)) b: z.infer<typeof Send>) { return this.svc.send(u, b); }

  @RequirePermissions('sms:bulk') @Post('messages/bulk')
  bulk(@CurrentUser() u: AuthUser, @Body(z$(Bulk)) b: z.infer<typeof Bulk>) { return this.svc.bulk(u, b); }

  @RequirePermissions('sms:send') @HttpCode(200) @Post('messages/segments')
  segments(@Body() b: { body: string }) { return smsSegments(String(b?.body ?? '')); }

  @RequirePermissions('sms:read:own') @Get('conversations')
  conversations(@CurrentUser() u: AuthUser, @Query() q: { kind?: string; q?: string }) { return this.svc.conversations(u, q); }

  @RequirePermissions('sms:read:own') @Get('conversations/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('before') before?: string) { return this.svc.messages(u, id, before); }

  @RequirePermissions('sms:read:own') @HttpCode(200) @Post('conversations/:id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.markRead(u, id); }

  /** AI-assisted reply suggestions for a conversation. */
  @RequirePermissions('ai:use') @HttpCode(200) @Post('conversations/:id/suggest-replies')
  async suggest(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() b: { tone?: string }) {
    const msgs = await this.svc.messages(u, id);
    return { suggestions: await this.ai.draftReplies(msgs.map((m) => ({ direction: m.direction, body: m.body })), b?.tone) };
  }

  @RequirePermissions('chat:use') @Post('chats')
  createChat(@CurrentUser() u: AuthUser, @Body(z$(Chat)) b: z.infer<typeof Chat>) { return this.svc.createChat(u, b); }

  @RequirePermissions('chat:use') @Post('chats/:id/messages')
  postChat(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body(z$(ChatMsg)) b: z.infer<typeof ChatMsg>) { return this.svc.postChat(u, id, b); }

  @RequirePermissions('sms:send') @Get('sms-templates')
  templates(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, name, body FROM sms_templates WHERE org_id=$1 ORDER BY name`, [u.orgId]); }
  @RequirePermissions('sms:send') @Post('sms-templates')
  createTemplate(@CurrentUser() u: AuthUser, @Body(z$(Template)) b: z.infer<typeof Template>) {
    return this.db.one(`INSERT INTO sms_templates (org_id, name, body) VALUES ($1,$2,$3) ON CONFLICT (org_id, name) DO UPDATE SET body=EXCLUDED.body RETURNING id, name, body`, [u.orgId, b.name, b.body]);
  }
  @RequirePermissions('sms:send') @HttpCode(204) @Delete('sms-templates/:id')
  async deleteTemplate(@CurrentUser() u: AuthUser, @Param('id') id: string) { await this.db.query(`DELETE FROM sms_templates WHERE id=$1 AND org_id=$2`, [id, u.orgId]); }

  @RequirePermissions('numbers:write') @Get('auto-replies')
  autoReplies(@CurrentUser() u: AuthUser) { return this.db.query(`SELECT id, phone_number_id "phoneNumberId", trigger, keyword, body, enabled FROM auto_replies WHERE org_id=$1`, [u.orgId]); }
  @RequirePermissions('numbers:write') @Put('auto-replies')
  async upsertAutoReply(@CurrentUser() u: AuthUser, @Body(z$(AutoReply)) b: z.infer<typeof AutoReply>) {
    const n = await this.db.one(`SELECT 1 FROM phone_numbers WHERE id=$1 AND org_id=$2`, [b.phoneNumberId, u.orgId]);
    if (!n) return { error: 'unknown number' };
    return this.db.one(`INSERT INTO auto_replies (org_id, phone_number_id, trigger, keyword, body, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, trigger, keyword, body, enabled`, [u.orgId, b.phoneNumberId, b.trigger, b.keyword ?? null, b.body, b.enabled]);
  }
}

/** Carrier SMS webhooks — signatures verified exactly like voice webhooks. */
@Public() @SkipThrottle()
@Controller('v1/telephony/:provider/sms')
export class SmsWebhookController {
  constructor(private svc: MessagingService) {}
  @HttpCode(200) @Post()
  async inbound(@Param('provider') p: string, @Req() req: Request) {
    verifyWebhook(p, req);
    const b = req.body ?? {};
    const media: string[] = [];
    for (let i = 0; i < Number(b.NumMedia ?? 0); i++) if (b[`MediaUrl${i}`]) media.push(b[`MediaUrl${i}`]);
    const isTelnyx = p === 'telnyx' && b.data?.payload;
    await this.svc.inbound(isTelnyx
      ? { from: b.data.payload.from.phone_number, to: b.data.payload.to[0].phone_number, body: b.data.payload.text ?? '', media: (b.data.payload.media ?? []).map((m: any) => m.url), providerMessageId: b.data.payload.id }
      : { from: b.From, to: b.To, body: b.Body ?? '', media, providerMessageId: b.MessageSid });
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }
  @HttpCode(204) @Post('status')
  async status(@Param('provider') p: string, @Req() req: Request) {
    verifyWebhook(p, req);
    const b = req.body ?? {};
    if (b.MessageSid) await this.svc.status(b.MessageSid, b.MessageStatus);
    else if (b.data?.payload?.id) await this.svc.status(b.data.payload.id, b.data.payload.to?.[0]?.status);
  }
}
