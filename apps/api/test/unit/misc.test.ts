import { analyzeTranscript } from '../../src/modules/ai/analyzer';
import { smsSegments, renderTemplate } from '../../src/modules/messaging/sms';
import { parseCsv } from '../../src/modules/contacts/contacts.controller';
import { isPrivateAddress, signPayload } from '../../src/modules/platform/webhooks.service';
import { encrypt, decrypt } from '../../src/common/crypto';
import { livekitToken } from '../../src/modules/meetings/meetings.controller';
import * as jwt from 'jsonwebtoken';

describe('AI heuristic analyzer', () => {
  it('extracts sentiment, keywords, action items and coaching', () => {
    const a = analyzeTranscript(`Agent: Thanks for calling, how can I help? Customer: My invoice is wrong and I am frustrated. Agent: I'm sorry about that. I will send you a corrected invoice by Friday. Customer: Great, thanks, that's helpful. Agent: Anything else I can help with?`);
    expect(['positive', 'mixed']).toContain(a.sentiment);
    expect(a.keywords).toContain('invoice');
    expect(a.actionItems.some((i) => /corrected invoice/.test(i.text))).toBe(true);
    expect(a.callScore).toBeGreaterThan(50);
  });
  it('flags negative calls', () => {
    const a = analyzeTranscript('This is the worst service. I want a refund. I am angry and disappointed.');
    expect(a.sentiment).toBe('negative');
    expect(a.coaching.join(' ')).toMatch(/frustration/);
  });
});

describe('SMS', () => {
  it('computes GSM-7 and UCS-2 segments', () => {
    expect(smsSegments('hello')).toEqual({ encoding: 'GSM-7', length: 5, segments: 1 });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('€'.repeat(80)).length).toBe(160);
    expect(smsSegments('héllo 😀').encoding).toBe('UCS-2');
    expect(smsSegments('😀'.repeat(36)).segments).toBe(2);
  });
  it('renders templates', () => expect(renderTemplate('Hi {{ name }}, see you {{day}}{{missing}}', { name: 'Ada', day: 'Mon' })).toBe('Hi Ada, see you Mon'));
});

describe('CSV', () => {
  it('parses quoted fields and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,2')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  });
});

describe('security helpers', () => {
  it('detects private addresses (SSRF)', () => {
    ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'].forEach((ip) => expect(isPrivateAddress(ip)).toBe(true));
    ['8.8.8.8', '1.1.1.1', '2606:4700::1111'].forEach((ip) => expect(isPrivateAddress(ip)).toBe(false));
  });
  it('round-trips AES-GCM and detects tampering', () => {
    const c = encrypt('totp-secret');
    expect(decrypt(c)).toBe('totp-secret');
    const b = Buffer.from(c, 'base64'); b[b.length - 1] ^= 1;
    expect(() => decrypt(b.toString('base64'))).toThrow();
  });
  it('signs webhook payloads', () => expect(signPayload('s', '{}', 1700000000)).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/));
  it('issues LiveKit grants with publish restrictions', () => {
    const t = jwt.decode(livekitToken({ identity: 'p1', name: 'Guest', room: 'org:123', canPublish: false })) as any;
    expect(t.video).toMatchObject({ room: 'org:123', roomJoin: true, canPublish: false, roomAdmin: false });
    expect(t.sub).toBe('p1');
  });
});
