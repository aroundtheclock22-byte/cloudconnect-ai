import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { countryOf, findRate, HANGUP_NODE, isTollFree, normalizeE164, RoutingAction, RoutingFlow, screenCall, step } from '@cloudconnect/shared';
import { Db } from '../../common/db.service';
import { EventBus } from '../../common/events';
import { AuthUser, can } from '../../common/auth';
import { config } from '../../config';
import { AiService } from '../ai/ai.service';
import { FraudService } from '../platform/fraud.service';
import { createProvider, TelephonyProvider } from './providers';
import { render, RenderCtx } from './render';

/** Provider-normalized webhook params. */
export interface CallParams { callSid: string; from: string; to: string; status?: string; digits?: string; speech?: string; dialStatus?: string; dialDuration?: number; duration?: number;
  recordingUrl?: string; recordingSid?: string; recordingDuration?: number; transcription?: string; identity?: string }

export function normalizeParams(provider: string, p: Record<string, any>): CallParams {
  if (provider === 'plivo') return { callSid: p.CallUUID, from: p.From, to: p.To, status: p.CallStatus, digits: p.Digits, speech: p.Speech, dialStatus: p.DialStatus, recordingUrl: p.RecordUrl, recordingDuration: Number(p.RecordingDuration) || undefined, duration: Number(p.Duration) || undefined, transcription: p.transcription };
  if (provider === 'vonage') return { callSid: p.uuid ?? p.conversation_uuid, from: p.from, to: p.to, status: p.status, digits: p.dtmf?.digits, speech: p.speech?.results?.[0]?.text, recordingUrl: p.recording_url, duration: Number(p.duration) || undefined };
  // Twilio, SignalWire (LaML), Telnyx (TeXML) share TwiML parameter names
  return { callSid: p.CallSid, from: p.From, to: p.To, status: p.CallStatus, digits: p.Digits, speech: p.SpeechResult, dialStatus: p.DialCallStatus, dialDuration: Number(p.DialCallDuration) || undefined,
    duration: Number(p.CallDuration) || undefined, recordingUrl: p.RecordingUrl, recordingSid: p.RecordingSid, recordingDuration: Number(p.RecordingDuration) || undefined, transcription: p.TranscriptionText,
    identity: typeof p.From === 'string' && p.From.startsWith('client:') ? p.From.slice(7) : undefined };
}

const STATUS_MAP: Record<string, string> = { queued: 'queued', initiated: 'queued', ringing: 'ringing', 'in-progress': 'in_progress', answered: 'in_progress', completed: 'completed', busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled' };
const HOLD_MUSIC = 'https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3';
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

@Injectable()
export class TelephonyService {
  readonly provider: TelephonyProvider = createProvider();
  private log = new Logger('Telephony');
  constructor(private db: Db, private bus: EventBus, private ai: AiService, private fraud: FraudService) {}

  private ctx(provider: string, callId: string, callerId?: string): RenderCtx { return { baseUrl: config().PUBLIC_URL, provider, callId, callerId }; }

  /** Default flow for numbers assigned directly to a user: ring all their devices, then voicemail. */
  private async defaultFlowFor(orgId: string, userId: string | null): Promise<RoutingFlow> {
    const mb = userId ? await this.db.one(`SELECT id FROM voicemail_boxes WHERE user_id=$1 LIMIT 1`, [userId]) : await this.db.one(`SELECT id FROM voicemail_boxes WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]);
    const ext = userId ? await this.db.one(`SELECT forwarding FROM extensions WHERE user_id=$1 AND kind='user'`, [userId]) : null;
    const simultaneous: string[] = ext?.forwarding?.simultaneous ?? [];
    return {
      id: 'default', name: 'Direct line', entry: userId ? 'ring' : 'vm', nodes: {
        ring: { id: 'ring', type: 'ring_group', name: 'Direct', strategy: 'simultaneous', ringTimeoutSeconds: 25, onNoAnswer: 'vm',
          targets: [{ extension: 'self', destination: `client:${userId}` }, ...simultaneous.map((d) => ({ extension: 'fwd', destination: d }))] },
        vm: { id: 'vm', type: 'voicemail', mailboxId: mb?.id ?? 'none' },
      },
    };
  }

  private async flowForCall(call: any): Promise<RoutingFlow> {
    const n = call.phone_number_id ? await this.db.one(`SELECT n.assigned_user_id, f.definition FROM phone_numbers n LEFT JOIN routing_flows f ON f.id=n.routing_flow_id WHERE n.id=$1`, [call.phone_number_id]) : null;
    return n?.definition ?? this.defaultFlowFor(call.org_id, n?.assigned_user_id ?? call.user_id);
  }

  /** First webhook for an inbound PSTN call. */
  async inbound(provider: string, p: CallParams) {
    const number = await this.db.one(`SELECT n.*, f.definition FROM phone_numbers n LEFT JOIN routing_flows f ON f.id=n.routing_flow_id WHERE n.e164=$1 AND n.status='active'`, [p.to]);
    if (!number) return render({ kind: 'hangup' }, this.ctx(provider, 'unknown'));
    const flow: RoutingFlow = number.definition ?? await this.defaultFlowFor(number.org_id, number.assigned_user_id);
    const [blocked, spamScore] = await Promise.all([
      this.db.one(`SELECT 1 FROM blocked_numbers WHERE org_id=$1 AND e164=$2`, [number.org_id, p.from]),
      this.fraud.spamScore(p.from, p.to),
    ]);
    const call = await this.db.one(
      `INSERT INTO calls (org_id, provider, provider_call_id, direction, status, from_number, to_number, phone_number_id, user_id, country, spam_score)
       VALUES ($1,$2,$3,'inbound','ringing',$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider, provider_call_id) DO UPDATE SET status=calls.status RETURNING *`,
      [number.org_id, provider, p.callSid, p.from, p.to, number.id, number.assigned_user_id, countryOf(p.from), spamScore]);
    const ctx = { from: p.from, to: p.to, blocked: !!blocked, spamScore };
    const rejection = screenCall(flow, ctx);
    if (rejection) {
      await this.db.query(`UPDATE calls SET status='rejected', ended_at=now(), tags=array_append(tags,$2) WHERE id=$1`, [call.id, rejection.kind === 'reject' ? rejection.reason : 'rejected']);
      return render(rejection, this.ctx(provider, call.id));
    }
    const contact = await this.db.one(`SELECT id, first_name, last_name, company FROM contacts WHERE org_id=$1 AND $2 = ANY(phones) LIMIT 1`, [number.org_id, p.from]);
    this.bus.publish('call.ringing', number.org_id, { callId: call.id, from: p.from, to: p.to, contact, spamScore, label: number.label });
    return this.advance(provider, call, flow, undefined, { from: p.from, to: p.to, spamScore });
  }

  private async advance(provider: string, call: any, flow: RoutingFlow, nodeId: string | undefined, ctx: Parameters<typeof step>[2]) {
    let action: RoutingAction;
    try {
      action = step(flow, nodeId, { ...ctx, now: new Date() }); // schedule nodes carry their own IANA time zone
    } catch (e) {
      this.log.error(`routing error on call ${call.id}: ${(e as Error).message}`);
      action = { kind: 'say', text: 'We are sorry, we cannot complete your call right now.', language: 'en-US', then: { nodeId: HANGUP_NODE } };
    }
    const visited = nodeId ?? flow.entry;
    await this.db.query(`UPDATE calls SET routing_path = routing_path || to_jsonb($2::text), status = CASE WHEN $3 = 'voicemail' THEN 'voicemail'::call_status ELSE status END WHERE id=$1`,
      [call.id, visited, action.kind]);
    const callerId = await this.db.one(`SELECT e164 FROM phone_numbers WHERE id=$1`, [call.phone_number_id]);
    return render(action, this.ctx(provider, call.id, callerId?.e164));
  }

  /** Continuation webhook (Gather result, Dial result, Say redirect). */
  async continue(provider: string, q: Record<string, string>, p: CallParams) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1`, [q.callId]);
    if (!call) return render({ kind: 'hangup' }, this.ctx(provider, 'unknown'));
    if (q.dial === '1') {
      if (p.dialStatus === 'completed' || p.dialStatus === 'answered') {
        await this.db.query(`UPDATE calls SET answered_at = COALESCE(answered_at, now() - make_interval(secs => $2)), status='completed', ended_at=now() WHERE id=$1`, [call.id, p.dialDuration ?? 0]);
        return render({ kind: 'hangup' }, this.ctx(provider, call.id));
      }
      await this.db.query(`INSERT INTO call_events (call_id, type, data) VALUES ($1,'dial_unanswered',$2)`, [call.id, { node: q.node, status: p.dialStatus }]);
    }
    const flow = await this.flowForCall(call);
    const digits = q.noInput === '1' ? '' : p.digits;
    return this.advance(provider, call, flow, q.node, { from: call.from_number, to: call.to_number, digits, attempt: Number(q.attempt) || 0, language: q.lang });
  }

  /** Call status callback: lifecycle, quality, rating and usage metering. */
  async status(provider: string, p: CallParams & { mos?: number; jitter?: number; loss?: number }) {
    const status = STATUS_MAP[p.status ?? ''] ?? null;
    if (!status) return;
    const call = await this.db.one(`SELECT * FROM calls WHERE provider=$1 AND provider_call_id=$2`, [provider, p.callSid]);
    if (!call) return;
    if (status === 'in_progress') {
      if (call.direction === 'outbound') await this.db.query(`UPDATE calls SET status='in_progress', answered_at=COALESCE(answered_at, now()) WHERE id=$1`, [call.id]);
      this.bus.publish('call.answered', call.org_id, { callId: call.id }, call.user_id ? [call.user_id] : undefined);
      return;
    }
    if (!['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(status)) {
      await this.db.query(`UPDATE calls SET status=$2::call_status WHERE id=$1 AND status IN ('queued','ringing')`, [call.id, status]);
      return;
    }
    const final = call.status === 'voicemail' || call.status === 'rejected' ? call.status : call.answered_at ? 'completed' : status === 'completed' ? (call.direction === 'inbound' ? 'no_answer' : 'completed') : status;
    const billable = call.direction === 'outbound' ? call.to_number : call.from_number;
    const seconds = p.duration ?? 0;
    const minutes = Math.ceil(seconds / 60);
    const rates = await this.db.query(`SELECT prefix, country, per_minute_cents "perMinuteCents", sms_cents "smsCents" FROM rates`);
    const rate = findRate(billable, rates.length ? rates : undefined);
    const tollFree = call.direction === 'inbound' && isTollFree(call.to_number);
    const international = call.direction === 'outbound' && !billable.startsWith('+1');
    const costCents = tollFree ? minutes * 2 : international ? minutes * (rate?.perMinuteCents ?? 10) : 0;
    const updated = await this.db.one(
      `UPDATE calls SET status=$2::call_status, ended_at=COALESCE(ended_at, now()), cost_cents=$3, mos_score=COALESCE($4, mos_score), jitter_ms=COALESCE($5, jitter_ms), packet_loss_pct=COALESCE($6, packet_loss_pct)
       WHERE id=$1 RETURNING *`, [call.id, final, costCents, p.mos ?? null, p.jitter ?? null, p.loss ?? null]);
    if (minutes > 0) {
      await this.db.query(`INSERT INTO usage_records (org_id, kind, quantity, cost_cents, source_id) VALUES ($1,$2,$3,$4,$5)`,
        [call.org_id, tollFree ? 'minutes_toll_free' : international ? 'minutes_international' : 'minutes_domestic', minutes, costCents, call.id]);
    }
    const missed = call.direction === 'inbound' && !updated.answered_at && final !== 'rejected';
    this.bus.publish(missed ? 'call.missed' : 'call.completed', call.org_id, { callId: call.id, from: call.from_number, to: call.to_number, status: final, durationSeconds: updated.duration_seconds, costCents });
    if (missed) await this.missedCallAutoReply(call);
  }

  private async missedCallAutoReply(call: any) {
    const r = await this.db.one(`SELECT a.body, n.e164 FROM auto_replies a JOIN phone_numbers n ON n.id=a.phone_number_id WHERE a.phone_number_id=$1 AND a.trigger='missed_call' AND a.enabled`, [call.phone_number_id]);
    if (!r || !/^\+\d+$/.test(call.from_number)) return;
    const opted = await this.db.one(`SELECT 1 FROM sms_opt_outs WHERE org_id=$1 AND e164=$2`, [call.org_id, call.from_number]);
    if (opted) return;
    await this.provider.sendSms({ from: r.e164, to: call.from_number, body: r.body, statusCallback: `${config().PUBLIC_URL}/v1/telephony/${call.provider}/sms/status` }).catch(() => undefined);
  }

  /** Recording ready → store, transcribe, run AI analysis. */
  async recording(provider: string, q: Record<string, string>, p: CallParams) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1`, [q.callId]);
    if (!call || !p.recordingUrl) return;
    // Media is copied from the carrier to S3 (SSE-KMS) by the media worker; we store the carrier URL until then.
    const rec = await this.db.one(`INSERT INTO recordings (org_id, call_id, storage_key, duration_seconds, status) VALUES ($1,$2,$3,$4,'ready') RETURNING id`,
      [call.org_id, call.id, p.recordingUrl, p.recordingDuration ?? 0]);
    this.bus.publish('call.recording.ready', call.org_id, { callId: call.id, recordingId: rec.id });
    void this.analyzeCall(call, p.recordingUrl).catch((e) => this.log.warn(`analysis failed: ${e.message}`));
  }

  async analyzeCall(call: any, audioUrl?: string, transcriptText?: string) {
    const text = transcriptText ?? (audioUrl ? await this.ai.transcribeUrl(audioUrl.endsWith('.mp3') ? audioUrl : `${audioUrl}.mp3`, this.carrierAuth()) : null);
    if (!text) return;
    await this.db.query(`INSERT INTO transcripts (org_id, source_type, source_id, full_text) VALUES ($1,'call',$2,$3) ON CONFLICT (source_type, source_id) DO UPDATE SET full_text=EXCLUDED.full_text`, [call.org_id, call.id, text]);
    const a = await this.ai.analyze(text, 'call');
    await this.db.query(
      `INSERT INTO ai_insights (org_id, source_type, source_id, summary, sentiment, sentiment_score, action_items, keywords, call_score, coaching, model)
       VALUES ($1,'call',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (source_type, source_id) DO UPDATE SET summary=EXCLUDED.summary, sentiment=EXCLUDED.sentiment, sentiment_score=EXCLUDED.sentiment_score,
         action_items=EXCLUDED.action_items, keywords=EXCLUDED.keywords, call_score=EXCLUDED.call_score, coaching=EXCLUDED.coaching, model=EXCLUDED.model`,
      [call.org_id, call.id, a.summary, a.sentiment, a.sentimentScore, JSON.stringify(a.actionItems), a.keywords, a.callScore, JSON.stringify(a.coaching), a.model]);
    this.bus.publish('call.analyzed', call.org_id, { callId: call.id, sentiment: a.sentiment, callScore: a.callScore });
    return a;
  }

  private carrierAuth() {
    const c = config();
    return c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN ? 'Basic ' + Buffer.from(`${c.TWILIO_ACCOUNT_SID}:${c.TWILIO_AUTH_TOKEN}`).toString('base64') : undefined;
  }

  async voicemail(provider: string, q: Record<string, string>, p: CallParams) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1`, [q.callId]);
    const box = call ? await this.db.one(`SELECT * FROM voicemail_boxes WHERE id=$1 AND org_id=$2`, [q.mailbox, call.org_id]).catch(() => undefined) : undefined;
    if (call && box && p.recordingUrl) {
      const vm = await this.db.one(`INSERT INTO voicemails (org_id, mailbox_id, call_id, from_number, storage_key, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [call.org_id, box.id, call.id, call.from_number, p.recordingUrl, p.recordingDuration ?? 0]);
      await this.db.query(`UPDATE calls SET status='voicemail' WHERE id=$1`, [call.id]);
      this.bus.publish('voicemail.received', call.org_id, { voicemailId: vm.id, from: call.from_number, mailboxId: box.id }, box.user_id ? [box.user_id] : undefined);
      if (box.sms_notify) {
        const from = await this.db.one(`SELECT e164 FROM phone_numbers WHERE id=$1`, [call.phone_number_id]);
        if (from) await this.provider.sendSms({ from: from.e164, to: box.sms_notify, body: `New voicemail from ${call.from_number} (${p.recordingDuration ?? 0}s). Open CloudConnect to listen.`, statusCallback: '' }).catch(() => undefined);
      }
      // Email delivery is handled by the notifications worker subscribed to voicemail.received (SES).
    }
    return render({ kind: 'hangup' }, this.ctx(provider, q.callId));
  }

  async transcription(q: Record<string, string>, p: CallParams) {
    if (!p.transcription) return;
    const summary = await this.ai.summarizeVoicemail(p.transcription);
    await this.db.query(`UPDATE voicemails SET transcript=$2, ai_summary=$3 WHERE call_id=$1`, [q.callId, p.transcription, summary]);
  }

  /** AI receptionist: one conversational turn per Gather(speech) round-trip. */
  async aiTurn(provider: string, q: Record<string, string>, p: CallParams) {
    const call = await this.db.one(`SELECT c.*, o.name org_name, o.timezone, o.settings FROM calls c JOIN organizations o ON o.id=c.org_id WHERE c.id=$1`, [q.callId]);
    if (!call) return { contentType: 'text/xml', body: xml('<Hangup/>') };
    const agent = call.settings?.aiAgents?.[q.agent] ?? {};
    const departments: Record<string, string> = agent.departments ?? {};
    const turns = await this.db.query(`SELECT data FROM call_events WHERE call_id=$1 AND type='ai_turn' ORDER BY id`, [call.id]);
    const history = turns.map((t) => t.data as { role: 'caller' | 'agent'; text: string });
    if (p.speech && q.greet !== '1') {
      history.push({ role: 'caller', text: p.speech });
      await this.db.query(`INSERT INTO call_events (call_id, type, data) VALUES ($1,'ai_turn',$2)`, [call.id, { role: 'caller', text: p.speech }]);
    }
    const turn = await this.ai.receptionist({ company: agent.company ?? call.org_name, instructions: agent.instructions, departments: Object.keys(departments), history, nowIso: new Date().toISOString(), timezone: call.timezone });
    await this.db.query(`INSERT INTO call_events (call_id, type, data) VALUES ($1,'ai_turn',$2)`, [call.id, { role: 'agent', text: turn.reply, intent: turn.intent }]);
    const say = `<Say voice="Polly.Joanna-Neural">${esc(turn.reply)}</Say>`;
    const self = `${config().PUBLIC_URL}/v1/telephony/${provider}/ai?${new URLSearchParams({ callId: call.id, agent: q.agent, fallback: q.fallback })}`;
    const cont = (node: string) => `${config().PUBLIC_URL}/v1/telephony/${provider}/voice/continue?${new URLSearchParams({ callId: call.id, node, attempt: '0' })}`;

    if (turn.intent === 'transfer' && turn.department && departments[turn.department]) return { contentType: 'text/xml', body: xml(`${say}<Redirect method="POST">${esc(cont(departments[turn.department]))}</Redirect>`) };
    if (turn.intent === 'take_message') return { contentType: 'text/xml', body: xml(`${say}<Redirect method="POST">${esc(cont(q.fallback))}</Redirect>`) };
    if (turn.intent === 'end') return { contentType: 'text/xml', body: xml(`${say}<Hangup/>`) };
    if (turn.intent === 'book_appointment' && turn.appointment?.startIso) {
      const host = await this.db.one(`SELECT COALESCE(n.assigned_user_id, (SELECT id FROM users WHERE org_id=$2 AND role='COMPANY_OWNER' LIMIT 1)) id FROM phone_numbers n WHERE n.id=$1`, [call.phone_number_id, call.org_id]);
      if (host?.id) {
        const start = new Date(turn.appointment.startIso);
        if (!isNaN(start.getTime())) {
          await this.db.query(`INSERT INTO meetings (org_id, host_id, title, join_code, scheduled_start, scheduled_end, waiting_room) VALUES ($1,$2,$3,$4,$5,$6,false)`,
            [call.org_id, host.id, `Appointment: ${turn.appointment.name ?? call.from_number}${turn.appointment.reason ? ` — ${turn.appointment.reason}` : ''}`, Math.random().toString().slice(2, 12), start, new Date(start.getTime() + 30 * 60_000)]);
        }
      }
    }
    return { contentType: 'text/xml', body: xml(`<Gather input="speech" speechTimeout="auto" action="${esc(self)}" method="POST">${say}</Gather><Redirect method="POST">${esc(cont(q.fallback))}</Redirect>`) };
  }

  // ───────────── Outbound ─────────────
  /** Picks a caller ID: explicit (must be owned), user's number, country-matched org number, or any org number. */
  async selectCallerId(orgId: string, userId: string | null, to: string, explicit?: string) {
    if (explicit) {
      const n = await this.db.one(`SELECT id, e164 FROM phone_numbers WHERE org_id=$1 AND e164=$2 AND status='active'`, [orgId, explicit]);
      if (!n) throw new ForbiddenException('Caller ID must be a number owned by your organization');
      return n;
    }
    const dest = countryOf(to);
    return this.db.one(`SELECT id, e164 FROM phone_numbers WHERE org_id=$1 AND status='active' AND 'voice' = ANY(capabilities)
      ORDER BY (assigned_user_id = $2) DESC NULLS LAST, (country = $3) DESC, created_at LIMIT 1`, [orgId, userId, dest]);
  }

  async outbound(user: AuthUser, body: { to: string; from?: string; ringDevice?: string; record?: boolean }) {
    const to = /^\d{2,6}$/.test(body.to) ? body.to : normalizeE164(body.to);
    if (!to) throw new BadRequestException('Invalid destination number');
    // internal extension dialing
    if (/^\d{2,6}$/.test(to)) {
      const ext = await this.db.one(`SELECT user_id FROM extensions WHERE org_id=$1 AND number=$2`, [user.orgId, to]);
      if (!ext?.user_id) throw new NotFoundException('Extension not found');
      const call = await this.db.one(`INSERT INTO calls (org_id, provider, direction, status, from_number, to_number, user_id) VALUES ($1,$2,'internal','queued',$3,$4,$5) RETURNING *`,
        [user.orgId, this.provider.name, `client:${user.userId}`, `client:${ext.user_id}`, user.userId]);
      return { callId: call.id, dial: `client:${ext.user_id}` };
    }
    const org = await this.db.one(`SELECT settings FROM organizations WHERE id=$1`, [user.orgId]);
    const verdict = await this.fraud.checkOutbound(user.orgId, to, org?.settings?.allowedCountries, countryOf(to));
    if (!verdict.allowed) throw new ForbiddenException({ message: 'Call blocked by fraud protection', reasons: verdict.reasons });
    const callerId = await this.selectCallerId(user.orgId, user.userId, to, body.from);
    if (!callerId) throw new BadRequestException('Your organization has no voice-capable number for caller ID');
    const call = await this.db.one(`INSERT INTO calls (org_id, provider, direction, status, from_number, to_number, user_id, phone_number_id, country) VALUES ($1,$2,'outbound','queued',$3,$4,$5,$6,$7) RETURNING *`,
      [user.orgId, this.provider.name, callerId.e164, to, user.userId, callerId.id, countryOf(to)]);
    // Click-to-call: ring the user's device first, then bridge to the destination.
    const base = `${config().PUBLIC_URL}/v1/telephony/${this.provider.name}`;
    const { providerCallId } = await this.provider.createCall({
      from: callerId.e164, to: body.ringDevice ?? `client:${user.userId}`, url: `${base}/bridge?callId=${call.id}`, statusCallback: `${base}/status`, record: body.record,
    });
    await this.db.query(`UPDATE calls SET provider_call_id=$2, status='ringing' WHERE id=$1`, [call.id, providerCallId]);
    return { callId: call.id, providerCallId, callerId: callerId.e164 };
  }

  async bridge(q: Record<string, string>) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1`, [q.callId]);
    if (!call) return xml('<Hangup/>');
    const rec = (await this.db.one(`SELECT settings FROM organizations WHERE id=$1`, [call.org_id]))?.settings?.recordAllCalls;
    const cb = `${config().PUBLIC_URL}/v1/telephony/${call.provider}/recording?callId=${call.id}`;
    return xml(`<Dial callerId="${esc(call.from_number)}" answerOnBridge="true"${rec ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(cb)}"` : ''}><Number>${esc(call.to_number)}</Number></Dial>`);
  }

  /** WebRTC softphone outbound (TwiML App voice URL): the SDK posts To + identity. */
  async clientOutbound(provider: string, p: CallParams & { To?: string }) {
    const userId = p.identity;
    const user = userId ? await this.db.one(`SELECT id, org_id, role FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId]) : null;
    if (!user) return xml('<Say>Unauthorized device.</Say><Hangup/>');
    try {
      const to = /^\d{2,6}$/.test(p.to) ? p.to : normalizeE164(p.to);
      if (!to) return xml('<Say>Invalid number.</Say><Hangup/>');
      if (/^\d{2,6}$/.test(to)) {
        const ext = await this.db.one(`SELECT user_id FROM extensions WHERE org_id=$1 AND number=$2`, [user.org_id, to]);
        return ext?.user_id ? xml(`<Dial><Client>${esc(ext.user_id)}</Client></Dial>`) : xml('<Say>Extension not found.</Say><Hangup/>');
      }
      const org = await this.db.one(`SELECT settings FROM organizations WHERE id=$1`, [user.org_id]);
      const verdict = await this.fraud.checkOutbound(user.org_id, to, org?.settings?.allowedCountries, countryOf(to));
      if (!verdict.allowed) return xml('<Say>This call is not permitted.</Say><Hangup/>');
      const cid = await this.selectCallerId(user.org_id, user.id, to);
      if (!cid) return xml('<Say>No caller ID configured.</Say><Hangup/>');
      const call = await this.db.one(`INSERT INTO calls (org_id, provider, provider_call_id, direction, status, from_number, to_number, user_id, phone_number_id, country) VALUES ($1,$2,$3,'outbound','ringing',$4,$5,$6,$7,$8) RETURNING id`,
        [user.org_id, provider, p.callSid, cid.e164, to, user.id, cid.id, countryOf(to)]);
      return this.bridge({ callId: call.id });
    } catch {
      return xml('<Say>We could not place your call.</Say><Hangup/>');
    }
  }

  // ───────────── In-call controls ─────────────
  async control(user: AuthUser, callId: string, action: string, body: { to?: string; orbit?: string; mode?: string }) {
    const call = await this.db.one(`SELECT * FROM calls WHERE id=$1 AND org_id=$2`, [callId, user.orgId]);
    if (!call) throw new NotFoundException();
    const own = call.user_id === user.userId;
    const need = (perm: Parameters<typeof can>[1]) => { if (!can(user, perm)) throw new ForbiddenException(`Missing permission ${perm}`); };
    if (!own && !['monitor', 'whisper', 'barge'].includes(action)) need('calls:read:all');
    if (!call.provider_call_id) throw new BadRequestException('Call is not connected to a carrier leg');
    const base = `${config().PUBLIC_URL}/v1/telephony/${call.provider}`;
    const sid = call.provider_call_id;
    let data: Record<string, unknown> = {};
    switch (action) {
      case 'hold':
        await this.provider.updateCall(sid, { twiml: xml(`<Play loop="0">${HOLD_MUSIC}</Play>`) });
        await this.db.query(`UPDATE calls SET status='on_hold' WHERE id=$1`, [call.id]); break;
      case 'unhold':
        await this.provider.updateCall(sid, { twiml: xml(`<Dial><Client>${esc(call.user_id ?? user.userId!)}</Client></Dial>`) });
        await this.db.query(`UPDATE calls SET status='in_progress' WHERE id=$1`, [call.id]); break;
      case 'transfer': {           // blind transfer
        if (!body.to) throw new BadRequestException('to is required');
        const target = await this.resolveTarget(user.orgId, body.to);
        await this.provider.updateCall(sid, { twiml: xml(`<Dial>${target}</Dial>`) });
        data = { to: body.to }; break;
      }
      case 'warm_transfer': {      // consultative: caller → conference, consult target joins, agent drops when ready
        if (!body.to) throw new BadRequestException('to is required');
        const room = `xfer-${call.id}`;
        await this.provider.updateCall(sid, { twiml: xml(`<Dial><Conference waitUrl="${HOLD_MUSIC}" startConferenceOnEnter="false" endConferenceOnExit="false">${room}</Conference></Dial>`) });
        await this.provider.createCall({ from: call.direction === 'inbound' ? call.to_number : call.from_number, to: body.to, url: `${base}/conference?room=${room}&mode=participant`, statusCallback: `${base}/status` });
        data = { to: body.to, room }; break;
      }
      case 'conference': {         // add a third party (three-way / conference calling)
        if (!body.to) throw new BadRequestException('to is required');
        const room = `conf-${call.id}`;
        await this.provider.updateCall(sid, { twiml: xml(`<Dial><Conference endConferenceOnExit="false">${room}</Conference></Dial>`) });
        await this.provider.createCall({ from: call.direction === 'inbound' ? call.to_number : call.from_number, to: body.to, url: `${base}/conference?room=${room}&mode=participant`, statusCallback: `${base}/status` });
        data = { to: body.to, room }; break;
      }
      case 'park': {
        const orbit = body.orbit ?? String(700 + Math.floor(Math.random() * 99));
        await this.provider.updateCall(sid, { twiml: xml(`<Enqueue waitUrl="${HOLD_MUSIC}">park-${user.orgId}-${orbit}</Enqueue>`) });
        data = { orbit }; break;
      }
      case 'record_start': await this.provider.setRecording(sid, 'start', `${base}/recording?callId=${call.id}`); break;
      case 'record_pause': await this.provider.setRecording(sid, 'paused'); break;
      case 'record_resume': await this.provider.setRecording(sid, 'in-progress'); break;
      case 'hangup': await this.provider.updateCall(sid, { status: 'completed' }); break;
      case 'monitor': case 'whisper': case 'barge': {
        need(action === 'monitor' ? 'calls:monitor' : action === 'whisper' ? 'calls:whisper' : 'calls:barge');
        // Supervisor leg joins the call's conference; whisper uses Twilio "coach" so only the agent hears.
        const room = `conf-${call.id}`;
        await this.provider.updateCall(sid, { twiml: xml(`<Dial><Conference endConferenceOnExit="true">${room}</Conference></Dial>`) });
        await this.provider.createCall({ from: call.to_number, to: `client:${user.userId}`, url: `${base}/conference?room=${room}&mode=${action}&coach=${encodeURIComponent(sid)}`, statusCallback: `${base}/status` });
        data = { room, mode: action }; break;
      }
      default: throw new BadRequestException(`Unknown action ${action}`);
    }
    await this.db.query(`INSERT INTO call_events (call_id, type, actor_id, data) VALUES ($1,$2,$3,$4)`, [call.id, action, user.userId, data]);
    return { ok: true, action, ...data };
  }

  async pickup(user: AuthUser, orbit: string) {
    const { providerCallId } = await this.provider.createCall({ from: 'client:park', to: `client:${user.userId}`, url: `${config().PUBLIC_URL}/v1/telephony/${this.provider.name}/conference?mode=pickup&room=${encodeURIComponent(`park-${user.orgId}-${orbit}`)}`, statusCallback: `${config().PUBLIC_URL}/v1/telephony/${this.provider.name}/status` });
    return { ok: true, providerCallId };
  }

  conferenceTwiml(q: Record<string, string>) {
    const room = esc(q.room ?? '');
    switch (q.mode) {
      case 'pickup': return xml(`<Dial><Queue>${room}</Queue></Dial>`);
      case 'monitor': return xml(`<Dial><Conference muted="true" beep="false">${room}</Conference></Dial>`);
      case 'whisper': return xml(`<Dial><Conference coach="${esc(q.coach ?? '')}" beep="false">${room}</Conference></Dial>`);
      default: return xml(`<Dial><Conference beep="true">${room}</Conference></Dial>`);
    }
  }

  private async resolveTarget(orgId: string, to: string) {
    if (/^\d{2,6}$/.test(to)) {
      const ext = await this.db.one(`SELECT user_id FROM extensions WHERE org_id=$1 AND number=$2`, [orgId, to]);
      if (!ext?.user_id) throw new NotFoundException('Extension not found');
      return `<Client>${esc(ext.user_id)}</Client>`;
    }
    const n = normalizeE164(to);
    if (!n) throw new BadRequestException('Invalid transfer target');
    return `<Number>${esc(n)}</Number>`;
  }
}
