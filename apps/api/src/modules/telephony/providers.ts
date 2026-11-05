/**
 * Carrier adapters. Each adapter implements outbound call control, SMS, number inventory and
 * WebRTC client tokens. The mock adapter is used in development/tests and records operations.
 */
import { Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { config } from '../../config';

export interface AvailableNumber { e164: string; locality?: string; region?: string; country: string; type: 'local' | 'toll_free'; monthlyCostCents: number }
export interface TelephonyProvider {
  readonly name: string;
  createCall(p: { from: string; to: string; url: string; statusCallback: string; record?: boolean }): Promise<{ providerCallId: string }>;
  updateCall(providerCallId: string, p: { twiml?: string; url?: string; status?: 'completed' }): Promise<void>;
  setRecording(providerCallId: string, status: 'start' | 'paused' | 'in-progress' | 'stopped', callbackUrl?: string): Promise<void>;
  sendSms(p: { from: string; to: string; body: string; mediaUrls?: string[]; statusCallback: string }): Promise<{ providerMessageId: string }>;
  searchNumbers(p: { country: string; type: 'local' | 'toll_free'; areaCode?: string; contains?: string; limit?: number }): Promise<AvailableNumber[]>;
  purchaseNumber(e164: string, webhooks: { voiceUrl: string; smsUrl: string }): Promise<{ providerSid: string }>;
  releaseNumber(providerSid: string): Promise<void>;
  clientToken(identity: string, ttlSeconds?: number): Promise<{ token: string; expiresIn: number }>;
}

export class MockProvider implements TelephonyProvider {
  readonly name = 'mock';
  readonly ops: { op: string; args: unknown }[] = [];
  private seq = 0;
  private log = new Logger('MockTelephony');
  private rec(op: string, args: unknown) { this.ops.push({ op, args }); this.log.debug(`${op} ${JSON.stringify(args)}`); }
  async createCall(p: any) { this.rec('createCall', p); return { providerCallId: `CA_mock_${++this.seq}_${Date.now()}` }; }
  async updateCall(id: string, p: any) { this.rec('updateCall', { id, ...p }); }
  async setRecording(id: string, status: string) { this.rec('setRecording', { id, status }); }
  async sendSms(p: any) { this.rec('sendSms', p); return { providerMessageId: `SM_mock_${++this.seq}_${Date.now()}` }; }
  async searchNumbers(p: { country: string; type: 'local' | 'toll_free'; areaCode?: string; limit?: number }) {
    const cc = p.country === 'US' || p.country === 'CA' ? '1' : p.country === 'GB' ? '44' : '1';
    const npa = p.type === 'toll_free' ? '888' : p.areaCode ?? '415';
    return Array.from({ length: p.limit ?? 10 }, (_, i) => ({
      e164: `+${cc}${npa}555${String(Math.floor(Math.random() * 9000) + 1000 + i).slice(0, 4)}`,
      country: p.country, type: p.type, locality: 'San Francisco', region: 'CA', monthlyCostCents: p.type === 'toll_free' ? 500 : 300,
    }));
  }
  async purchaseNumber(e164: string, w: any) { this.rec('purchaseNumber', { e164, ...w }); return { providerSid: `PN_mock_${++this.seq}` }; }
  async releaseNumber(sid: string) { this.rec('releaseNumber', { sid }); }
  async clientToken(identity: string, ttl = 3600) { return { token: jwt.sign({ identity, mock: true }, config().JWT_SECRET, { expiresIn: ttl }), expiresIn: ttl }; }
}

export class TwilioProvider implements TelephonyProvider {
  readonly name: string = 'twilio';
  constructor(protected sid: string, protected token: string, protected base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`) {}
  protected async req(method: string, path: string, form?: Record<string, string | string[] | undefined>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form ?? {})) {
      if (v === undefined) continue;
      (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
    }
    const res = await fetch(`${this.base}${path}`, {
      method, body: method === 'GET' ? undefined : body,
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64') },
    });
    if (!res.ok) throw new Error(`${this.name} ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }
  async createCall(p: { from: string; to: string; url: string; statusCallback: string; record?: boolean }) {
    const r: any = await this.req('POST', '/Calls.json', { From: p.from, To: p.to, Url: p.url, StatusCallback: p.statusCallback, StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], Record: p.record ? 'true' : undefined });
    return { providerCallId: r.sid };
  }
  async updateCall(id: string, p: { twiml?: string; url?: string; status?: 'completed' }) {
    await this.req('POST', `/Calls/${id}.json`, { Twiml: p.twiml, Url: p.url, Status: p.status });
  }
  async setRecording(id: string, status: 'start' | 'paused' | 'in-progress' | 'stopped', callbackUrl?: string) {
    if (status === 'start') await this.req('POST', `/Calls/${id}/Recordings.json`, { RecordingChannels: 'dual', RecordingStatusCallback: callbackUrl });
    else await this.req('POST', `/Calls/${id}/Recordings/Twilio.CURRENT.json`, { Status: status });
  }
  async sendSms(p: { from: string; to: string; body: string; mediaUrls?: string[]; statusCallback: string }) {
    const r: any = await this.req('POST', '/Messages.json', { From: p.from, To: p.to, Body: p.body, MediaUrl: p.mediaUrls, StatusCallback: p.statusCallback });
    return { providerMessageId: r.sid };
  }
  async searchNumbers(p: { country: string; type: 'local' | 'toll_free'; areaCode?: string; contains?: string; limit?: number }) {
    const q = new URLSearchParams({ PageSize: String(p.limit ?? 20), ...(p.areaCode ? { AreaCode: p.areaCode } : {}), ...(p.contains ? { Contains: p.contains } : {}) });
    const r: any = await this.req('GET', `/AvailablePhoneNumbers/${p.country}/${p.type === 'toll_free' ? 'TollFree' : 'Local'}.json?${q}`);
    return (r.available_phone_numbers ?? []).map((n: any) => ({ e164: n.phone_number, locality: n.locality, region: n.region, country: p.country, type: p.type, monthlyCostCents: p.type === 'toll_free' ? 200 : 115 }));
  }
  async purchaseNumber(e164: string, w: { voiceUrl: string; smsUrl: string }) {
    const r: any = await this.req('POST', '/IncomingPhoneNumbers.json', { PhoneNumber: e164, VoiceUrl: w.voiceUrl, SmsUrl: w.smsUrl, VoiceMethod: 'POST', SmsMethod: 'POST' });
    return { providerSid: r.sid };
  }
  async releaseNumber(sid: string) { await this.req('DELETE', `/IncomingPhoneNumbers/${sid}.json`); }
  /** Twilio Voice SDK AccessToken (JWT with VoiceGrant). */
  async clientToken(identity: string, ttl = 3600) {
    const c = config();
    if (!c.TWILIO_API_KEY || !c.TWILIO_API_SECRET) throw new Error('TWILIO_API_KEY/SECRET required for client tokens');
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({
      jti: `${c.TWILIO_API_KEY}-${now}`, grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: c.TWILIO_TWIML_APP_SID } } },
    }, c.TWILIO_API_SECRET, { issuer: c.TWILIO_API_KEY, subject: this.sid, expiresIn: ttl, header: { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' } as any });
    return { token, expiresIn: ttl };
  }
}

/** SignalWire exposes a Twilio-compatible ("LaML") REST API. */
export class SignalWireProvider extends TwilioProvider {
  readonly name = 'signalwire';
  constructor(project: string, token: string, space: string) { super(project, token, `https://${space}/api/laml/2010-04-01/Accounts/${project}`); }
}

/** Telnyx TeXML is TwiML-compatible for call control; messaging & numbers use the v2 API. */
export class TelnyxProvider extends TwilioProvider {
  readonly name = 'telnyx';
  constructor(private apiKey: string) { super('telnyx', apiKey, 'https://api.telnyx.com/v2'); }
  private async v2(method: string, path: string, json?: object) {
    const res = await fetch(`https://api.telnyx.com/v2${path}`, { method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
    if (!res.ok) throw new Error(`telnyx ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<any>;
  }
  async createCall(p: { from: string; to: string; url: string; statusCallback: string; record?: boolean }) {
    const r = await this.v2('POST', `/texml/calls/${config().TELNYX_TEXML_APP_ID}`, { From: p.from, To: p.to, Url: p.url, StatusCallback: p.statusCallback, Record: p.record });
    return { providerCallId: r.data?.call_sid ?? r.call_sid };
  }
  async updateCall(id: string, p: { twiml?: string; url?: string; status?: 'completed' }) {
    await this.v2('POST', `/texml/calls/${id}/update`, { Texml: p.twiml, Url: p.url, Status: p.status });
  }
  /** WebRTC login token for a telephony credential mapped to the user's SIP identity. */
  async clientToken(identity: string, ttl = 86400) {
    const res = await fetch(`https://api.telnyx.com/v2/telephony_credentials/${encodeURIComponent(identity)}/token`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`telnyx token failed: ${res.status}`);
    return { token: await res.text(), expiresIn: ttl };
  }
  async sendSms(p: { from: string; to: string; body: string; mediaUrls?: string[]; statusCallback: string }) {
    const r = await this.v2('POST', '/messages', { from: p.from, to: p.to, text: p.body, media_urls: p.mediaUrls, webhook_url: p.statusCallback });
    return { providerMessageId: r.data.id };
  }
  async searchNumbers(p: { country: string; type: 'local' | 'toll_free'; areaCode?: string; limit?: number }) {
    const q = new URLSearchParams({ 'filter[country_code]': p.country, 'filter[phone_number_type]': p.type, 'filter[limit]': String(p.limit ?? 20), ...(p.areaCode ? { 'filter[national_destination_code]': p.areaCode } : {}) });
    const r = await this.v2('GET', `/available_phone_numbers?${q}`);
    return r.data.map((n: any) => ({ e164: n.phone_number, country: p.country, type: p.type, locality: n.region_information?.[0]?.region_name, monthlyCostCents: Math.round(Number(n.cost_information?.monthly_cost ?? 1) * 100) }));
  }
  async purchaseNumber(e164: string) { const r = await this.v2('POST', '/number_orders', { phone_numbers: [{ phone_number: e164 }] }); return { providerSid: r.data.id }; }
  async releaseNumber(id: string) { await this.v2('DELETE', `/phone_numbers/${id}`); }
}

export function createProvider(name = config().TELEPHONY_PROVIDER): TelephonyProvider {
  const c = config();
  switch (name) {
    case 'twilio': return new TwilioProvider(c.TWILIO_ACCOUNT_SID!, c.TWILIO_AUTH_TOKEN!);
    case 'signalwire': return new SignalWireProvider(c.SIGNALWIRE_PROJECT_ID!, c.SIGNALWIRE_TOKEN!, c.SIGNALWIRE_SPACE!);
    case 'telnyx': return new TelnyxProvider(c.TELNYX_API_KEY!);
    // Plivo & Vonage adapters render their own markup (render.ts); REST adapters follow the same interface.
    default: return new MockProvider();
  }
}
