import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { evaluateSchedule, findRate, normalizeE164 } from '@cloudconnect/shared';
import { Db } from '../../common/db.service';
import { EventBus } from '../../common/events';
import { AuthUser, can } from '../../common/auth';
import { config } from '../../config';
import { TelephonyService } from '../telephony/telephony.service';
import { HELP_WORDS, renderTemplate, smsSegments, START_WORDS, STOP_WORDS } from './sms';

@Injectable()
export class MessagingService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Messaging');
  private timer?: NodeJS.Timeout;
  constructor(private db: Db, private bus: EventBus, private tel: TelephonyService) {}

  onModuleInit() { if (process.env.NODE_ENV !== 'test') this.timer = setInterval(() => this.dispatchScheduled().catch((e) => this.log.error(e)), 10_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async conversationFor(orgId: string, numberId: string, participants: string[]) {
    const sorted = [...new Set(participants)].sort();
    const kind = sorted.length > 1 ? 'group_sms' : 'sms';
    return this.db.one(`INSERT INTO conversations (org_id, kind, phone_number_id, participants) VALUES ($1,$2,$3,$4)
      ON CONFLICT (org_id, phone_number_id, participants) WHERE kind IN ('sms','group_sms') DO UPDATE SET last_message_at=now() RETURNING *`, [orgId, kind, numberId, sorted]);
  }

  async send(user: AuthUser, b: { from?: string; to: string[]; body: string; mediaUrls?: string[]; scheduledAt?: string; templateId?: string; vars?: Record<string, string>; campaignId?: string }) {
    const to = b.to.map((t) => normalizeE164(t));
    if (to.some((t) => !t)) throw new BadRequestException('Invalid recipient number');
    let body = b.body ?? '';
    if (b.templateId) {
      const t = await this.db.one(`SELECT body FROM sms_templates WHERE id=$1 AND org_id=$2`, [b.templateId, user.orgId]);
      if (!t) throw new NotFoundException('Template not found');
      body = renderTemplate(t.body, b.vars ?? {});
    }
    if (!body && !b.mediaUrls?.length) throw new BadRequestException('Message body or media required');
    const from = b.from
      ? await this.db.one(`SELECT id, e164 FROM phone_numbers WHERE org_id=$1 AND e164=$2 AND 'sms' = ANY(capabilities) AND status='active'`, [user.orgId, normalizeE164(b.from)])
      : await this.db.one(`SELECT id, e164 FROM phone_numbers WHERE org_id=$1 AND 'sms' = ANY(capabilities) AND status='active' ORDER BY (assigned_user_id=$2) DESC NULLS LAST, created_at LIMIT 1`, [user.orgId, user.userId]);
    if (!from) throw new ForbiddenException('No SMS-capable number available to send from');
    const opted = await this.db.query(`SELECT e164 FROM sms_opt_outs WHERE org_id=$1 AND e164 = ANY($2)`, [user.orgId, to]);
    if (opted.length) throw new ForbiddenException({ message: 'Recipient has opted out of messages', recipients: opted.map((o) => o.e164) });
    const conv = await this.conversationFor(user.orgId, from.id, to as string[]);
    const seg = smsSegments(body);
    const rates = await this.db.query(`SELECT prefix, country, per_minute_cents "perMinuteCents", sms_cents "smsCents" FROM rates`);
    const costCents = (to as string[]).reduce((s, n) => s + (findRate(n, rates.length ? rates : undefined)?.smsCents ?? 5) * seg.segments * (b.mediaUrls?.length ? 3 : 1), 0);
    const scheduled = b.scheduledAt ? new Date(b.scheduledAt) : null;
    if (scheduled && (isNaN(scheduled.getTime()) || scheduled.getTime() < Date.now() - 60_000)) throw new BadRequestException('scheduledAt must be in the future');
    const msg = await this.db.one(`INSERT INTO messages (org_id, conversation_id, direction, status, sender_user_id, from_address, to_addresses, body, media, segments, cost_cents, scheduled_at, campaign_id)
      VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [user.orgId, conv.id, scheduled ? 'scheduled' : 'queued', user.userId, from.e164, to, body, JSON.stringify((b.mediaUrls ?? []).map((url) => ({ url }))), seg.segments, costCents, scheduled, b.campaignId ?? null]);
    if (!scheduled) await this.dispatch(msg);
    return this.shape(await this.db.one(`SELECT * FROM messages WHERE id=$1`, [msg.id]));
  }

  private async dispatch(msg: any) {
    try {
      const media = (msg.media ?? []).map((m: any) => m.url);
      for (const to of msg.to_addresses as string[]) {
        const { providerMessageId } = await this.tel.provider.sendSms({ from: msg.from_address, to, body: msg.body, mediaUrls: media.length ? media : undefined, statusCallback: `${config().PUBLIC_URL}/v1/telephony/${this.tel.provider.name}/sms/status` });
        await this.db.query(`UPDATE messages SET provider_message_id=$2, status='sent' WHERE id=$1`, [msg.id, providerMessageId]);
      }
      await this.db.query(`INSERT INTO usage_records (org_id, kind, quantity, cost_cents, source_id) VALUES ($1,$2,$3,$4,$5)`, [msg.org_id, (msg.media ?? []).length ? 'mms' : 'sms', msg.segments * msg.to_addresses.length, msg.cost_cents, msg.id]);
      await this.db.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [msg.conversation_id]);
      this.bus.publish('message.sent', msg.org_id, { messageId: msg.id, conversationId: msg.conversation_id });
    } catch (e) {
      this.log.warn(`send failed ${msg.id}: ${(e as Error).message}`);
      await this.db.query(`UPDATE messages SET status='failed' WHERE id=$1`, [msg.id]);
    }
  }

  async dispatchScheduled() {
    const due = await this.db.query(`UPDATE messages SET status='queued' WHERE id IN (SELECT id FROM messages WHERE status='scheduled' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 200 FOR UPDATE SKIP LOCKED) RETURNING *`);
    for (const m of due) await this.dispatch(m);
    return due.length;
  }

  /** Inbound SMS webhook: compliance keywords, conversation threading, auto-replies, realtime push. */
  async inbound(p: { from: string; to: string; body: string; media: string[]; providerMessageId?: string }) {
    const number = await this.db.one(`SELECT n.*, o.timezone, o.name org_name FROM phone_numbers n JOIN organizations o ON o.id=n.org_id WHERE n.e164=$1 AND n.status='active'`, [p.to]);
    if (!number) return null;
    const word = p.body.trim().toUpperCase();
    const conv = await this.conversationFor(number.org_id, number.id, [p.from]);
    const msg = await this.db.one(`INSERT INTO messages (org_id, conversation_id, direction, status, from_address, to_addresses, body, media, provider_message_id) VALUES ($1,$2,'inbound','received',$3,$4,$5,$6,$7) RETURNING *`,
      [number.org_id, conv.id, p.from, [p.to], p.body, JSON.stringify(p.media.map((url) => ({ url }))), p.providerMessageId ?? null]);
    let reply: string | null = null;
    if (STOP_WORDS.includes(word)) {
      await this.db.query(`INSERT INTO sms_opt_outs (org_id, e164) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [number.org_id, p.from]);
      reply = `You have been unsubscribed from ${number.org_name}. Reply START to resubscribe.`;
    } else if (START_WORDS.includes(word)) {
      await this.db.query(`DELETE FROM sms_opt_outs WHERE org_id=$1 AND e164=$2`, [number.org_id, p.from]);
      reply = `You are resubscribed to ${number.org_name}. Reply STOP to opt out.`;
    } else if (HELP_WORDS.includes(word)) {
      reply = `${number.org_name}: Reply STOP to opt out. Msg & data rates may apply.`;
    } else {
      const rules = await this.db.query(`SELECT * FROM auto_replies WHERE phone_number_id=$1 AND enabled ORDER BY (trigger='keyword') DESC`, [number.id]);
      const org = await this.db.one(`SELECT settings FROM organizations WHERE id=$1`, [number.org_id]);
      const hours = org?.settings?.businessHours;
      for (const r of rules) {
        if (r.trigger === 'keyword' && r.keyword && word.includes(r.keyword.toUpperCase())) { reply = r.body; break; }
        if (r.trigger === 'after_hours' && hours && evaluateSchedule(hours) !== 'open') { reply = r.body; break; }
        if (r.trigger === 'always') { reply = r.body; break; }
      }
    }
    if (reply) {
      const out = await this.db.one(`INSERT INTO messages (org_id, conversation_id, direction, status, from_address, to_addresses, body) VALUES ($1,$2,'outbound','queued',$3,$4,$5) RETURNING *`, [number.org_id, conv.id, p.to, [p.from], reply]);
      await this.dispatch(out);
    }
    this.bus.publish('message.received', number.org_id, { messageId: msg.id, conversationId: conv.id, from: p.from, body: p.body.slice(0, 160) }, number.assigned_user_id ? [number.assigned_user_id] : undefined);
    return msg;
  }

  async status(providerMessageId: string, status: string) {
    const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', failed: 'failed', undelivered: 'failed', read: 'read' };
    if (!map[status]) return;
    await this.db.query(`UPDATE messages SET status=$2::msg_status, read_at = CASE WHEN $2='read' THEN now() ELSE read_at END WHERE provider_message_id=$1`, [providerMessageId, map[status]]);
  }

  async conversations(user: AuthUser, q: { kind?: string; q?: string }) {
    const all = can(user, 'sms:read:all');
    return this.db.query(`SELECT c.id, c.kind, c.title, c.participants, c.last_message_at "lastMessageAt", n.e164 "number",
        (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) "lastMessage",
        (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.read_at IS NULL) unread,
        (SELECT first_name || ' ' || last_name FROM contacts ct WHERE ct.org_id=c.org_id AND c.participants[1] = ANY(ct.phones) LIMIT 1) "contactName"
      FROM conversations c LEFT JOIN phone_numbers n ON n.id=c.phone_number_id
      WHERE c.org_id=$1 AND ($2::text IS NULL OR c.kind=$2)
        AND (c.kind IN ('team_chat','direct_chat') AND $3::text = ANY(c.participants) OR c.kind IN ('sms','group_sms') AND ($4::boolean OR n.assigned_user_id=$3::uuid OR n.assigned_user_id IS NULL))
        AND ($5::text IS NULL OR array_to_string(c.participants, ' ') ILIKE '%' || $5 || '%' OR c.title ILIKE '%' || $5 || '%')
      ORDER BY c.last_message_at DESC LIMIT 100`, [user.orgId, q.kind ?? null, user.userId, all, q.q ?? null]);
  }

  async assertConversation(user: AuthUser, id: string) {
    const c = await this.db.one(`SELECT c.*, n.assigned_user_id FROM conversations c LEFT JOIN phone_numbers n ON n.id=c.phone_number_id WHERE c.id=$1 AND c.org_id=$2`, [id, user.orgId]);
    if (!c) throw new NotFoundException();
    const isChat = ['team_chat', 'direct_chat'].includes(c.kind);
    if (isChat ? !c.participants.includes(user.userId) : !(can(user, 'sms:read:all') || !c.assigned_user_id || c.assigned_user_id === user.userId)) throw new NotFoundException();
    return c;
  }

  async messages(user: AuthUser, conversationId: string, before?: string) {
    await this.assertConversation(user, conversationId);
    const rows = await this.db.query(`SELECT * FROM messages WHERE conversation_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT 100`, [conversationId, before ?? null]);
    return rows.reverse().map((m) => this.shape(m));
  }

  /** Marks inbound messages read (read receipts for chat; inbox state for SMS). */
  async markRead(user: AuthUser, conversationId: string) {
    await this.assertConversation(user, conversationId);
    const r = await this.db.query(`UPDATE messages SET read_at=now(), status = CASE WHEN direction='inbound' THEN 'read'::msg_status ELSE status END
      WHERE conversation_id=$1 AND read_at IS NULL AND (sender_user_id IS DISTINCT FROM $2) RETURNING id`, [conversationId, user.userId]);
    return { read: r.length };
  }

  // ───── Internal team chat ─────
  async createChat(user: AuthUser, b: { title?: string; memberIds: string[] }) {
    const members = await this.db.query(`SELECT id FROM users WHERE org_id=$1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [user.orgId, b.memberIds]);
    const ids = [...new Set([user.userId!, ...members.map((m) => m.id)])].sort();
    if (ids.length < 2) throw new BadRequestException('A chat needs at least one other member');
    const kind = ids.length === 2 && !b.title ? 'direct_chat' : 'team_chat';
    if (kind === 'direct_chat') {
      const ex = await this.db.one(`SELECT * FROM conversations WHERE org_id=$1 AND kind='direct_chat' AND participants=$2`, [user.orgId, ids]);
      if (ex) return ex;
    }
    return this.db.one(`INSERT INTO conversations (org_id, kind, title, participants) VALUES ($1,$2,$3,$4) RETURNING *`, [user.orgId, kind, b.title ?? null, ids]);
  }

  async postChat(user: AuthUser, conversationId: string, b: { body: string; attachments?: { key: string; contentType: string; size: number; name?: string }[] }) {
    const c = await this.assertConversation(user, conversationId);
    if (!['team_chat', 'direct_chat'].includes(c.kind)) throw new BadRequestException('Use POST /v1/messages for SMS');
    const m = await this.db.one(`INSERT INTO messages (org_id, conversation_id, direction, status, sender_user_id, from_address, to_addresses, body, media) VALUES ($1,$2,'outbound','delivered',$3,$7,$4,$5,$6) RETURNING *`,
      [user.orgId, c.id, user.userId, c.participants.filter((p: string) => p !== user.userId), b.body ?? '', JSON.stringify(b.attachments ?? []), String(user.userId)]);
    await this.db.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [c.id]);
    this.bus.publish('message.received', user.orgId, { messageId: m.id, conversationId: c.id, from: user.userId, body: m.body.slice(0, 160), chat: true }, c.participants.filter((p: string) => p !== user.userId));
    return this.shape(m);
  }

  /** Bulk / broadcast send to a contact group or list (one conversation per recipient). */
  async bulk(user: AuthUser, b: { name: string; from?: string; body: string; to?: string[]; contactGroupId?: string; scheduledAt?: string }) {
    let recipients = b.to ?? [];
    if (b.contactGroupId) {
      const g = await this.db.one(`SELECT contact_ids FROM contact_groups WHERE id=$1 AND org_id=$2`, [b.contactGroupId, user.orgId]);
      if (!g) throw new NotFoundException('Contact group not found');
      const cs = await this.db.query(`SELECT phones[1] phone, first_name FROM contacts WHERE id = ANY($1::uuid[]) AND array_length(phones,1) > 0`, [g.contact_ids]);
      recipients = recipients.concat(cs.map((c) => c.phone));
    }
    recipients = [...new Set(recipients.map((r) => normalizeE164(r)).filter((r): r is string => !!r))];
    if (!recipients.length) throw new BadRequestException('No valid recipients');
    if (recipients.length > 10_000) throw new BadRequestException('Max 10,000 recipients per campaign');
    const opted = new Set((await this.db.query(`SELECT e164 FROM sms_opt_outs WHERE org_id=$1 AND e164 = ANY($2)`, [user.orgId, recipients])).map((r) => r.e164));
    const camp = await this.db.one(`INSERT INTO campaigns (org_id, name, body, contact_group_id, status, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [user.orgId, b.name, b.body, b.contactGroupId ?? null, b.scheduledAt ? 'scheduled' : 'sending', b.scheduledAt ?? null]);
    let sent = 0, failed = 0;
    for (const to of recipients) {
      if (opted.has(to)) continue;
      try { await this.send(user, { from: b.from, to: [to], body: b.body, scheduledAt: b.scheduledAt, campaignId: camp.id }); sent++; } catch { failed++; }
    }
    const stats = { recipients: recipients.length, queued: sent, failed, skippedOptOut: opted.size };
    await this.db.query(`UPDATE campaigns SET status=$2, stats=$3 WHERE id=$1`, [camp.id, b.scheduledAt ? 'scheduled' : 'completed', stats]);
    return { campaignId: camp.id, ...stats };
  }

  shape(m: any) {
    return { id: m.id, conversationId: m.conversation_id, direction: m.direction, status: m.status, senderUserId: m.sender_user_id, from: m.from_address, to: m.to_addresses, body: m.body, media: m.media,
      segments: m.segments, costCents: m.cost_cents, scheduledAt: m.scheduled_at, readAt: m.read_at, createdAt: m.created_at };
  }
}
