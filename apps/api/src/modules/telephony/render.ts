/**
 * Renders provider-neutral RoutingActions into provider call-control markup.
 *  - TwiML: Twilio, SignalWire (LaML) and Telnyx (TeXML) are TwiML-compatible.
 *  - Plivo XML
 *  - Vonage NCCO (JSON)
 */
import { Continuation, RoutingAction } from '@cloudconnect/shared';

export type Dialect = 'twiml' | 'plivo' | 'ncco';
export interface RenderCtx { baseUrl: string; provider: string; callId: string; callerId?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

export function continueUrl(ctx: RenderCtx, c: Continuation, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ callId: ctx.callId, node: c.nodeId, attempt: String(c.attempt ?? 0), lang: c.language ?? 'en-US', ...extra });
  return `${ctx.baseUrl}/v1/telephony/${ctx.provider}/voice/continue?${q}`;
}
const cb = (ctx: RenderCtx, path: string, extra: Record<string, string> = {}) =>
  `${ctx.baseUrl}/v1/telephony/${ctx.provider}/${path}?${new URLSearchParams({ callId: ctx.callId, ...extra })}`;

function dialTarget(t: string): { kind: 'number' | 'client' | 'sip'; value: string } {
  if (t.startsWith('client:')) return { kind: 'client', value: t.slice(7) };
  if (t.startsWith('sip:')) return { kind: 'sip', value: t };
  return { kind: 'number', value: t };
}

export function renderTwiml(a: RoutingAction, ctx: RenderCtx): string {
  const body = (() => {
    switch (a.kind) {
      case 'reject': return `<Reject reason="${a.reason === 'blocked' ? 'busy' : 'rejected'}"/>`;
      case 'say': return `<Say language="${esc(a.language)}" voice="Polly.Joanna-Neural">${esc(a.text)}</Say><Redirect method="POST">${esc(continueUrl(ctx, a.then))}</Redirect>`;
      case 'gather':
        return `<Gather input="dtmf speech" numDigits="${a.numDigits}" timeout="${a.timeoutSeconds}" language="${esc(a.language)}" action="${esc(continueUrl(ctx, a.then))}" method="POST">` +
          `<Say language="${esc(a.language)}" voice="Polly.Joanna-Neural">${esc(a.prompt)}</Say></Gather>` +
          `<Redirect method="POST">${esc(continueUrl(ctx, a.then, { noInput: '1' }))}</Redirect>`;
      case 'dial': {
        const rec = a.record ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(cb(ctx, 'recording'))}"` : '';
        const cid = !a.callerIdPassthrough && ctx.callerId ? ` callerId="${esc(ctx.callerId)}"` : '';
        const nouns = a.targets.map(dialTarget).map((t) =>
          t.kind === 'client' ? `<Client>${esc(t.value)}</Client>` : t.kind === 'sip' ? `<Sip>${esc(t.value)}</Sip>` : `<Number>${esc(t.value)}</Number>`).join('');
        return `<Dial timeout="${a.timeoutSeconds}" answerOnBridge="true"${cid}${rec} action="${esc(continueUrl(ctx, a.then, { dial: '1' }))}" method="POST">${nouns}</Dial>`;
      }
      case 'voicemail':
        return `<Say language="${esc(a.language)}" voice="Polly.Joanna-Neural">${esc(a.greeting)}</Say>` +
          `<Record maxLength="180" playBeep="true" finishOnKey="#" action="${esc(cb(ctx, 'voicemail', { mailbox: a.mailboxId }))}"` +
          (a.transcribe ? ` transcribe="true" transcribeCallback="${esc(cb(ctx, 'transcription', { mailbox: a.mailboxId }))}"` : '') + `/><Hangup/>`;
      case 'enqueue':
        return `<Enqueue waitUrl="${esc(a.holdMusicUrl ?? '')}" action="${esc(continueUrl(ctx, a.then, { queue: a.queueId }))}">${esc(a.queueId)}</Enqueue>`;
      case 'ai_agent':
        return `<Gather input="speech" speechTimeout="auto" language="en-US" action="${esc(cb(ctx, 'ai', { agent: a.agentId, fallback: a.then.nodeId }))}" method="POST"/>` +
          `<Redirect method="POST">${esc(cb(ctx, 'ai', { agent: a.agentId, fallback: a.then.nodeId, greet: '1' }))}</Redirect>`;
      case 'hangup': return '<Hangup/>';
    }
  })();
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export function renderPlivo(a: RoutingAction, ctx: RenderCtx): string {
  const body = (() => {
    switch (a.kind) {
      case 'reject': return `<Hangup reason="rejected"/>`;
      case 'say': return `<Speak language="${esc(a.language)}">${esc(a.text)}</Speak><Redirect>${esc(continueUrl(ctx, a.then))}</Redirect>`;
      case 'gather': return `<GetInput action="${esc(continueUrl(ctx, a.then))}" method="POST" inputType="dtmf speech" numDigits="${a.numDigits}" digitEndTimeout="${a.timeoutSeconds}"><Speak language="${esc(a.language)}">${esc(a.prompt)}</Speak></GetInput><Redirect>${esc(continueUrl(ctx, a.then, { noInput: '1' }))}</Redirect>`;
      case 'dial': return `<Dial timeout="${a.timeoutSeconds}" action="${esc(continueUrl(ctx, a.then, { dial: '1' }))}">${a.targets.map(dialTarget).map((t) => t.kind === 'number' ? `<Number>${esc(t.value)}</Number>` : `<User>${esc(t.kind === 'client' ? `sip:${t.value}@phone.plivo.com` : t.value)}</User>`).join('')}</Dial>`;
      case 'voicemail': return `<Speak>${esc(a.greeting)}</Speak><Record action="${esc(cb(ctx, 'voicemail', { mailbox: a.mailboxId }))}" maxLength="180" playBeep="true"${a.transcribe ? ` transcriptionType="auto" transcriptionUrl="${esc(cb(ctx, 'transcription', { mailbox: a.mailboxId }))}"` : ''}/>`;
      case 'enqueue': return `<Conference waitSound="${esc(a.holdMusicUrl ?? '')}" callbackUrl="${esc(continueUrl(ctx, a.then))}">${esc(a.queueId)}</Conference>`;
      case 'ai_agent': return `<GetInput action="${esc(cb(ctx, 'ai', { agent: a.agentId, fallback: a.then.nodeId }))}" inputType="speech"/>`;
      case 'hangup': return '<Hangup/>';
    }
  })();
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export function renderNcco(a: RoutingAction, ctx: RenderCtx): object[] {
  switch (a.kind) {
    case 'reject': case 'hangup': return [{ action: 'hangup' }];
    case 'say': return [{ action: 'talk', text: a.text, language: a.language }, { action: 'notify', payload: {}, eventUrl: [continueUrl(ctx, a.then)] }];
    case 'gather': return [{ action: 'talk', text: a.prompt, language: a.language, bargeIn: true }, { action: 'input', type: ['dtmf', 'speech'], dtmf: { maxDigits: a.numDigits, timeOut: a.timeoutSeconds }, eventUrl: [continueUrl(ctx, a.then)] }];
    case 'dial': return [{ action: 'connect', timeout: a.timeoutSeconds, eventUrl: [continueUrl(ctx, a.then, { dial: '1' })], endpoint: a.targets.map(dialTarget).map((t) => t.kind === 'number' ? { type: 'phone', number: t.value.replace('+', '') } : t.kind === 'sip' ? { type: 'sip', uri: t.value } : { type: 'app', user: t.value }) }];
    case 'voicemail': return [{ action: 'talk', text: a.greeting }, { action: 'record', beepStart: true, endOnKey: '#', timeOut: 180, eventUrl: [cb(ctx, 'voicemail', { mailbox: a.mailboxId })], ...(a.transcribe ? { transcription: { eventUrl: [cb(ctx, 'transcription', { mailbox: a.mailboxId })] } } : {}) }];
    case 'enqueue': return [{ action: 'conversation', name: a.queueId, musicOnHoldUrl: a.holdMusicUrl ? [a.holdMusicUrl] : undefined }];
    case 'ai_agent': return [{ action: 'input', type: ['speech'], eventUrl: [cb(ctx, 'ai', { agent: a.agentId, fallback: a.then.nodeId })] }];
  }
}

export function dialectFor(provider: string): Dialect {
  return provider === 'plivo' ? 'plivo' : provider === 'vonage' ? 'ncco' : 'twiml';
}
export function render(a: RoutingAction, ctx: RenderCtx): { contentType: string; body: string } {
  const d = dialectFor(ctx.provider);
  if (d === 'ncco') return { contentType: 'application/json', body: JSON.stringify(renderNcco(a, ctx)) };
  return { contentType: 'text/xml', body: d === 'plivo' ? renderPlivo(a, ctx) : renderTwiml(a, ctx) };
}
