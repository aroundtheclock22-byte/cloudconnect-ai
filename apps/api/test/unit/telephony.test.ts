import { generateKeyPairSync, sign } from 'crypto';
import { renderTwiml, renderNcco, renderPlivo, render } from '../../src/modules/telephony/render';
import { twilioSignature, verifyTwilio, verifyTelnyx } from '../../src/modules/telephony/signature';
import { normalizeParams } from '../../src/modules/telephony/telephony.service';

const ctx = { baseUrl: 'https://api.example.com', provider: 'twilio', callId: 'c1', callerId: '+14155550100' };

describe('TwiML renderer', () => {
  it('renders gather with continuation + no-input fallback', () => {
    const x = renderTwiml({ kind: 'gather', prompt: 'Press 1 & 2 <now>', language: 'en-US', timeoutSeconds: 5, numDigits: 1, nodeId: 'menu', attempt: 0, then: { nodeId: 'menu', attempt: 0 } }, ctx);
    expect(x).toContain('<Gather input="dtmf speech" numDigits="1" timeout="5"');
    expect(x).toContain('Press 1 &amp; 2 &lt;now&gt;');
    expect(x).toContain('noInput=1');
    expect(x).toMatch(/^<\?xml/);
  });
  it('renders dial to clients, numbers and SIP with recording', () => {
    const x = renderTwiml({ kind: 'dial', targets: ['client:u1', '+14155551212', 'sip:desk@pbx.example.com'], timeoutSeconds: 20, nodeId: 'g', record: true, callerIdPassthrough: false, then: { nodeId: 'vm' } }, ctx);
    expect(x).toContain('<Client>u1</Client><Number>+14155551212</Number><Sip>sip:desk@pbx.example.com</Sip>');
    expect(x).toContain('record="record-from-answer-dual"');
    expect(x).toContain('callerId="+14155550100"');
    expect(x).toContain('dial=1');
  });
  it('renders voicemail with transcription and rejects', () => {
    expect(renderTwiml({ kind: 'voicemail', mailboxId: 'mb', greeting: 'Hi', language: 'en-US', transcribe: true }, ctx)).toContain('transcribeCallback=');
    expect(renderTwiml({ kind: 'reject', reason: 'spam' }, ctx)).toContain('<Reject reason="rejected"/>');
  });
  it('renders Plivo XML and Vonage NCCO dialects', () => {
    const a = { kind: 'dial' as const, targets: ['+14155551212'], timeoutSeconds: 20, nodeId: 'g', record: false, callerIdPassthrough: true, then: { nodeId: 'vm' } };
    expect(renderPlivo(a, { ...ctx, provider: 'plivo' })).toContain('<Number>+14155551212</Number>');
    expect(renderNcco(a, { ...ctx, provider: 'vonage' })).toEqual([expect.objectContaining({ action: 'connect', endpoint: [{ type: 'phone', number: '14155551212' }] })]);
    expect(render(a, { ...ctx, provider: 'vonage' }).contentType).toBe('application/json');
    expect(render(a, { ...ctx, provider: 'telnyx' }).body).toContain('<Dial');
  });
});

describe('webhook signatures', () => {
  it('verifies Twilio-style HMAC-SHA1 signatures and rejects tampering', () => {
    const url = 'https://api.example.com/v1/telephony/twilio/voice';
    const params = { CallSid: 'CA1', From: '+1555', To: '+1444' };
    const sig = twilioSignature('secret', url, params);
    expect(verifyTwilio('secret', url, params, sig)).toBe(true);
    expect(verifyTwilio('secret', url, { ...params, To: '+1999' }, sig)).toBe(false);
    expect(verifyTwilio('secret', url, params, undefined)).toBe(false);
  });
  it('verifies Telnyx ed25519 signatures with replay window', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"data":{}}';
    const sig = sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString('base64');
    expect(verifyTelnyx(raw, body, sig, ts)).toBe(true);
    expect(verifyTelnyx(raw, body + ' ', sig, ts)).toBe(false);
    expect(verifyTelnyx(raw, body, sig, String(Number(ts) - 3600))).toBe(false);
  });
});

describe('param normalization', () => {
  it('maps provider-specific webhook fields', () => {
    expect(normalizeParams('twilio', { CallSid: 'a', From: 'client:u1', To: '+1', Digits: '2' })).toMatchObject({ callSid: 'a', identity: 'u1', digits: '2' });
    expect(normalizeParams('plivo', { CallUUID: 'p', From: '+1', To: '+2', Digits: '3' })).toMatchObject({ callSid: 'p', digits: '3' });
    expect(normalizeParams('vonage', { uuid: 'v', from: '1', to: '2', dtmf: { digits: '9' } })).toMatchObject({ callSid: 'v', digits: '9' });
  });
});
