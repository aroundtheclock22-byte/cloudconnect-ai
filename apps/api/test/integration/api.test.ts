import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authenticator } from 'otplib';
import { auth, bootstrap, signup } from './helpers';

jest.setTimeout(60_000);

let app: INestApplication; let http: any;
beforeAll(async () => ({ app, http } = await bootstrap()));
afterAll(async () => app?.close());

describe('auth', () => {
  it('signs up, logs in, rotates refresh tokens and detects reuse', async () => {
    const o = await signup(http);
    expect(o.user.role).toBe('COMPANY_OWNER');
    expect(o.user.extension).toBe('101');
    await request(http).post('/v1/auth/login').send({ email: o.email, password: 'wrong-password' }).expect(401);
    const login = await request(http).post('/v1/auth/login').send({ email: o.email, password: 'Sup3rSecret!x' }).expect(200);
    expect(login.headers['set-cookie'][0]).toMatch(/cc_refresh=.*HttpOnly/);
    const r1 = await request(http).post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    await request(http).post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401); // replay → family revoked
    await request(http).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    await request(http).post('/v1/auth/signup').send({ orgName: 'X', email: 'weak@example.com', password: 'short', firstName: 'A' }).expect(400);
    const o = await signup(http);
    await request(http).post('/v1/auth/signup').send({ orgName: 'YY Corp', email: o.email, password: 'Sup3rSecret!x', firstName: 'A' }).expect(409);
  });

  it('enforces TOTP MFA', async () => {
    const o = await signup(http);
    const setup = await request(http).post('/v1/auth/mfa/setup').set(auth(o.token)).expect(201);
    await request(http).post('/v1/auth/mfa/enable').set(auth(o.token)).send({ code: '000000' }).expect(400);
    await request(http).post('/v1/auth/mfa/enable').set(auth(o.token)).send({ code: authenticator.generate(setup.body.secret) }).expect(200);
    const r = await request(http).post('/v1/auth/login').send({ email: o.email, password: 'Sup3rSecret!x' }).expect(200);
    expect(r.body).toEqual({ mfaRequired: true });
    await request(http).post('/v1/auth/login').send({ email: o.email, password: 'Sup3rSecret!x', mfaCode: authenticator.generate(setup.body.secret) }).expect(200);
  });

  it('supports scoped API keys', async () => {
    const o = await signup(http);
    const k = await request(http).post('/v1/auth/api-keys').set(auth(o.token)).send({ name: 'ci', scopes: ['contacts:read'] }).expect(201);
    expect(k.body.key).toMatch(/^cc_live_/);
    await request(http).get('/v1/contacts').set(auth(k.body.key)).expect(200);
    await request(http).get('/v1/numbers').set(auth(k.body.key)).expect(403);
    await request(http).get('/v1/contacts').set(auth('cc_live_bogus')).expect(401);
  });
});

describe('RBAC & tenancy', () => {
  it('prevents privilege escalation and enforces permissions', async () => {
    const o = await signup(http);
    const inv = await request(http).post('/v1/users').set(auth(o.token)).send({ email: `agent-${Date.now()}@example.com`, firstName: 'Agent', role: 'AGENT' }).expect(201);
    expect(inv.body.extension).toBe('102');
    const agent = await request(http).post('/v1/auth/login').send({ email: inv.body.email, password: inv.body.tempPassword }).expect(200);
    await request(http).post('/v1/numbers').set(auth(agent.body.accessToken)).send({ e164: '+14155550199' }).expect(403);
    await request(http).post('/v1/users').set(auth(agent.body.accessToken)).send({ email: 'x@example.com', firstName: 'X', role: 'ADMINISTRATOR' }).expect(403);
    await request(http).get('/v1/audit-logs').set(auth(agent.body.accessToken)).expect(403);
    const admin = await request(http).post('/v1/users').set(auth(o.token)).send({ email: `admin-${Date.now()}@example.com`, firstName: 'Admin', role: 'ADMINISTRATOR' }).expect(201);
    const adminTok = (await request(http).post('/v1/auth/login').send({ email: admin.body.email, password: admin.body.tempPassword })).body.accessToken;
    await request(http).patch(`/v1/users/${o.user.id}`).set(auth(adminTok)).send({ role: 'AGENT' }).expect(403); // cannot demote owner
    await request(http).post('/v1/users').set(auth(adminTok)).send({ email: 'own@example.com', firstName: 'O', role: 'COMPANY_OWNER' }).expect(403);
  });

  it('isolates tenants', async () => {
    const a = await signup(http); const b = await signup(http);
    const c = await request(http).post('/v1/contacts').set(auth(a.token)).send({ firstName: 'Secret', phones: ['+14155559999'], shared: true }).expect(201);
    const list = await request(http).get('/v1/contacts').set(auth(b.token)).expect(200);
    expect(list.body.data.find((x: any) => x.id === c.body.id)).toBeUndefined();
    await request(http).patch(`/v1/contacts/${c.body.id}`).set(auth(b.token)).send({ firstName: 'Hacked' }).expect(404);
    await request(http).get(`/v1/users/${a.user.id}`).set(auth(b.token)).expect(404);
  });
});

describe('telephony: IVR → ring group → voicemail → missed-call lifecycle', () => {
  it('routes an inbound call through the flow', async () => {
    const o = await signup(http);
    const num = await request(http).post('/v1/numbers').set(auth(o.token)).send({ e164: '+14155550142', label: 'Main' }).expect(201);
    const always = { mon: [{ start: '00:00', end: '23:59' }], tue: [{ start: '00:00', end: '23:59' }], wed: [{ start: '00:00', end: '23:59' }], thu: [{ start: '00:00', end: '23:59' }], fri: [{ start: '00:00', end: '23:59' }], sat: [{ start: '00:00', end: '23:59' }], sun: [{ start: '00:00', end: '23:59' }] };
    const vmBox = (await request(http).get('/v1/voicemails').set(auth(o.token))).body; void vmBox;
    const definition = {
      id: 'main', name: 'Main', entry: 'hours', recordCalls: true, blockAnonymous: true,
      nodes: {
        hours: { id: 'hours', type: 'schedule', schedule: { timezone: 'UTC', hours: always }, open: 'menu', closed: 'vm' },
        menu: { id: 'menu', type: 'menu', prompt: 'Press 1 for sales', options: { '1': 'sales' }, onTimeout: 'vm', onInvalid: 'vm' },
        sales: { id: 'sales', type: 'ring_group', name: 'Sales', strategy: 'simultaneous', ringTimeoutSeconds: 20, onNoAnswer: 'vm', targets: [{ extension: '101', destination: `client:${o.user.id}` }] },
        vm: { id: 'vm', type: 'voicemail', mailboxId: 'MAILBOX' },
      },
    };
    const db = (app as any).get(require('../../src/common/db.service').Db);
    const mb = await db.one(`SELECT id FROM voicemail_boxes WHERE user_id=$1`, [o.user.id]);
    definition.nodes.vm.mailboxId = mb.id;
    await request(http).post('/v1/routing-flows').set(auth(o.token)).send({ name: 'Broken', definition: { ...definition, entry: 'nope' } }).expect(400);
    const flow = await request(http).post('/v1/routing-flows').set(auth(o.token)).send({ name: 'Main', definition, published: true }).expect(201);
    await request(http).patch(`/v1/numbers/${num.body.id}`).set(auth(o.token)).send({ routingFlowId: flow.body.id }).expect(200);

    // anonymous rejected
    const anon = await request(http).post('/v1/telephony/mock/voice').type('form').send({ CallSid: 'CA-anon', From: 'anonymous', To: '+14155550142' }).expect(200);
    expect(anon.text).toContain('<Reject');

    const first = await request(http).post('/v1/telephony/mock/voice').type('form').send({ CallSid: 'CA-100', From: '+12125550123', To: '+14155550142' }).expect(200);
    expect(first.text).toContain('<Gather');
    const callId = /callId=([0-9a-f-]+)/.exec(first.text)![1];

    const dial = await request(http).post(`/v1/telephony/mock/voice/continue?callId=${callId}&node=menu&attempt=0`).type('form').send({ CallSid: 'CA-100', Digits: '1' }).expect(200);
    expect(dial.text).toContain(`<Client>${o.user.id}</Client>`);
    expect(dial.text).toContain('record="record-from-answer-dual"');

    const vm = await request(http).post(`/v1/telephony/mock/voice/continue?callId=${callId}&node=vm&attempt=0&dial=1`).type('form').send({ CallSid: 'CA-100', DialCallStatus: 'no-answer' }).expect(200);
    expect(vm.text).toContain('<Record');

    await request(http).post(`/v1/telephony/mock/voicemail?callId=${callId}&mailbox=${mb.id}`).type('form').send({ CallSid: 'CA-100', RecordingUrl: 'https://media.example.com/r1', RecordingDuration: '12' }).expect(200);
    await request(http).post(`/v1/telephony/mock/transcription?callId=${callId}&mailbox=${mb.id}`).type('form').send({ TranscriptionText: 'Hi, this is Bob, please call me back at 212 555 0123 about my order.' }).expect(204);
    await request(http).post('/v1/telephony/mock/status').type('form').send({ CallSid: 'CA-100', CallStatus: 'completed', CallDuration: '45' }).expect(204);

    const vms = await request(http).get('/v1/voicemails').set(auth(o.token)).expect(200);
    expect(vms.body[0]).toMatchObject({ from: '+12125550123', durationSeconds: 12, isRead: false });
    expect(vms.body[0].transcript).toMatch(/call me back/);
    const call = await request(http).get(`/v1/calls/${callId}`).set(auth(o.token)).expect(200);
    expect(call.body.status).toBe('voicemail');
    expect(call.body.routingPath).toEqual(['hours', 'menu', 'vm']);
    const dash = await request(http).get('/v1/analytics/dashboard').set(auth(o.token)).expect(200);
    expect(dash.body.today.voicemails).toBe(1);
  });

  it('places outbound calls with caller-ID selection and blocks IRSF fraud', async () => {
    const o = await signup(http);
    await request(http).post('/v1/calls').set(auth(o.token)).send({ to: '+14155551234' }).expect(400); // no number yet
    await request(http).post('/v1/numbers').set(auth(o.token)).send({ e164: '+14155550177' }).expect(201);
    await request(http).post('/v1/numbers').set(auth(o.token)).send({ e164: '+442071234567' }).expect(201);
    const us = await request(http).post('/v1/calls').set(auth(o.token)).send({ to: '(415) 555-1234' }).expect(201);
    expect(us.body.callerId).toBe('+14155550177');
    const uk = await request(http).post('/v1/calls').set(auth(o.token)).send({ to: '+447700900123' }).expect(201);
    expect(uk.body.callerId).toBe('+442071234567'); // country-specific caller ID
    const fraud = await request(http).post('/v1/calls').set(auth(o.token)).send({ to: '+881612345678' }).expect(403);
    expect(fraud.body.reasons).toContain('high_risk_destination');
    await request(http).post('/v1/calls').set(auth(o.token)).send({ to: '+14155551234', from: '+19999999999' }).expect(403); // unowned caller ID
    const ctl = await request(http).post(`/v1/calls/${us.body.callId}/hold`).set(auth(o.token)).send({}).expect(200);
    expect(ctl.body).toMatchObject({ ok: true, action: 'hold' });
    await request(http).post(`/v1/calls/${us.body.callId}/warm_transfer`).set(auth(o.token)).send({ to: '+14155550000' }).expect(200);
    await request(http).post(`/v1/calls/${us.body.callId}/park`).set(auth(o.token)).send({ orbit: '701' }).expect(200);
    const bridge = await request(http).post(`/v1/telephony/mock/bridge?callId=${us.body.callId}`).expect(200);
    expect(bridge.text).toContain('<Number>+14155551234</Number>');
    const tok = await request(http).get('/v1/telephony/token').set(auth(o.token)).expect(200);
    expect(tok.body).toMatchObject({ provider: 'mock', identity: o.user.id });
  });
});

describe('messaging', () => {
  it('sends SMS, honours STOP opt-outs, threads conversations and drafts AI replies', async () => {
    const o = await signup(http);
    await request(http).post('/v1/numbers').set(auth(o.token)).send({ e164: '+14155550188' }).expect(201);
    const sent = await request(http).post('/v1/messages').set(auth(o.token)).send({ to: ['+12125550111'], body: 'Hello from CloudConnect' }).expect(201);
    expect(sent.body).toMatchObject({ status: 'sent', segments: 1, direction: 'outbound' });
    await request(http).post('/v1/telephony/mock/sms').type('form').send({ From: '+12125550111', To: '+14155550188', Body: 'Can we talk tomorrow?', MessageSid: 'SM1' }).expect(200);
    const convs = await request(http).get('/v1/conversations').set(auth(o.token)).expect(200);
    expect(convs.body[0]).toMatchObject({ unread: 1, lastMessage: 'Can we talk tomorrow?' });
    const s = await request(http).post(`/v1/conversations/${convs.body[0].id}/suggest-replies`).set(auth(o.token)).send({}).expect(200);
    expect(s.body.suggestions).toHaveLength(3);
    await request(http).post(`/v1/conversations/${convs.body[0].id}/read`).set(auth(o.token)).expect(200);
    await request(http).post('/v1/telephony/mock/sms').type('form').send({ From: '+12125550111', To: '+14155550188', Body: 'STOP', MessageSid: 'SM2' }).expect(200);
    await request(http).post('/v1/messages').set(auth(o.token)).send({ to: ['+12125550111'], body: 'Still there?' }).expect(403);
    const sched = await request(http).post('/v1/messages').set(auth(o.token)).send({ to: ['+12125550222'], body: 'Later', scheduledAt: new Date(Date.now() + 3600_000).toISOString() }).expect(201);
    expect(sched.body.status).toBe('scheduled');
    const bulk = await request(http).post('/v1/messages/bulk').set(auth(o.token)).send({ name: 'Promo', body: 'Sale!', to: ['+12125550111', '+12125550333', 'bad'] }).expect(201);
    expect(bulk.body).toMatchObject({ recipients: 2, queued: 1, skippedOptOut: 1 });
  });

  it('supports internal team chat', async () => {
    const o = await signup(http);
    const inv = await request(http).post('/v1/users').set(auth(o.token)).send({ email: `chat-${Date.now()}@example.com`, firstName: 'Bea', role: 'EMPLOYEE' }).expect(201);
    const chat = await request(http).post('/v1/chats').set(auth(o.token)).send({ memberIds: [inv.body.id] }).expect(201);
    expect(chat.body.kind).toBe('direct_chat');
    await request(http).post(`/v1/chats/${chat.body.id}/messages`).set(auth(o.token)).send({ body: 'Hi Bea', attachments: [{ key: 'org/files/a.pdf', contentType: 'application/pdf', size: 1000 }] }).expect(201);
    const bea = (await request(http).post('/v1/auth/login').send({ email: inv.body.email, password: inv.body.tempPassword })).body.accessToken;
    const msgs = await request(http).get(`/v1/conversations/${chat.body.id}/messages`).set(auth(bea)).expect(200);
    expect(msgs.body[0]).toMatchObject({ body: 'Hi Bea', media: [expect.objectContaining({ contentType: 'application/pdf' })] });
  });
});

describe('contacts', () => {
  it('imports CSV, detects duplicates, merges and exports', async () => {
    const o = await signup(http);
    const csv = 'First Name,Last Name,Company,Email,Phone,Tags\nJane,Doe,Acme,jane@acme.com,(415) 555-0001,vip;lead\nJohn,Roe,,john@x.com,4155550002,\nJane,Dup,,jane@acme.com,,';
    const imp = await request(http).post('/v1/contacts/import').set(auth(o.token)).send({ csv, skipDuplicates: true }).expect(200);
    expect(imp.body).toEqual({ imported: 2, skipped: 1, invalid: 0 });
    const a = await request(http).post('/v1/contacts').set(auth(o.token)).send({ firstName: 'J', phones: ['+14155550001'] }).expect(201);
    const dups = await request(http).get('/v1/contacts/duplicates').set(auth(o.token)).expect(200);
    expect(dups.body[0].matchKey).toBe('+14155550001');
    const primary = dups.body[0].contactIds.find((id: string) => id !== a.body.id);
    const m = await request(http).post('/v1/contacts/merge').set(auth(o.token)).send({ primaryId: primary, duplicateIds: [a.body.id] }).expect(200);
    expect(m.body.merged).toBe(1);
    const lookup = await request(http).get('/v1/contacts/lookup?phone=4155550001').set(auth(o.token)).expect(200);
    expect(lookup.body.firstName).toBe('Jane');
    const exp = await request(http).get('/v1/contacts/export.csv').set(auth(o.token)).expect(200);
    expect(exp.text.split('\n')[0]).toBe('first_name,last_name,company,email,phone,tags,favorite');
    expect(exp.text).toMatch(/Jane,Doe,Acme,jane@acme.com,\+14155550001,"(lead;vip|vip;lead)",false/);
  });
});

describe('meetings', () => {
  it('handles waiting room, admission and LiveKit tokens', async () => {
    const o = await signup(http);
    const m = await request(http).post('/v1/meetings').set(auth(o.token)).send({ title: 'Quarterly review', passcode: '4321', scheduledStart: new Date(Date.now() + 3600_000).toISOString() }).expect(201);
    const ics = await request(http).get(`/v1/meetings/${m.body.joinCode}/ics`).expect(200);
    expect(ics.text).toContain('SUMMARY:Quarterly review');
    await request(http).post(`/v1/meetings/${m.body.joinCode}/join`).send({ displayName: 'Guest' }).expect(403);
    const host = await request(http).post(`/v1/meetings/${m.body.joinCode}/join`).set(auth(o.token)).send({ displayName: 'Host' }).expect(200);
    expect(host.body).toMatchObject({ status: 'admitted', token: expect.any(String) });
    const g = await request(http).post(`/v1/meetings/${m.body.joinCode}/join`).send({ displayName: 'Guest', passcode: '4321' }).expect(200);
    expect(g.body.status).toBe('waiting');
    await request(http).post(`/v1/meetings/${m.body.id}/participants/${g.body.participantId}/admit`).set(auth(o.token)).expect(200);
    const st = await request(http).get(`/v1/meetings/${m.body.joinCode}/participants/${g.body.participantId}/status`).expect(200);
    expect(st.body.status).toBe('admitted');
    const notes = await request(http).post(`/v1/meetings/${m.body.id}/notes`).set(auth(o.token)).send({ transcript: 'We agreed the budget is great. Ada will send the deck by Friday.' }).expect(200);
    expect(notes.body.actionItems.length).toBeGreaterThan(0);
  });
});

describe('billing, platform & admin', () => {
  it('previews usage invoices and applies coupons', async () => {
    const o = await signup(http);
    const sub = await request(http).get('/v1/billing/subscription').set(auth(o.token)).expect(200);
    expect(sub.body).toMatchObject({ planId: 'pro', status: 'trialing', seats: 1 });
    await request(http).post('/v1/billing/checkout').set(auth(o.token)).send({ planId: 'business', interval: 'year', seats: 3, coupon: 'NOPE' }).expect(400);
    const co = await request(http).post('/v1/billing/checkout').set(auth(o.token)).send({ planId: 'business', interval: 'year', seats: 3, coupon: 'launch20' }).expect(200);
    expect(co.body).toMatchObject({ mode: 'direct', couponPercentOff: 20 });
    const p = await request(http).get('/v1/billing/invoice-preview').set(auth(o.token)).expect(200);
    expect(p.body.subtotalCents).toBe(3 * 3500 * 12);
    expect(p.body.discountCents).toBe(Math.round(p.body.subtotalCents * 0.2));
    const plans = await request(http).get('/v1/billing/plans?currency=EUR').expect(200);
    expect(plans.body).toHaveLength(4);
  });

  it('guards webhooks against SSRF, records audit logs and serves GraphQL', async () => {
    const o = await signup(http);
    await request(http).post('/v1/webhooks').set(auth(o.token)).send({ url: 'http://example.com/hook', events: ['call.completed'] }).expect(400);
    await request(http).post('/v1/webhooks').set(auth(o.token)).send({ url: 'https://127.0.0.1/hook', events: ['call.completed'] }).expect(400);
    await request(http).patch('/v1/organization').set(auth(o.token)).send({ settings: { recordAllCalls: true, allowedCountries: ['US', 'CA'] } }).expect(200);
    const logs = await request(http).get('/v1/audit-logs').set(auth(o.token)).expect(200);
    expect(logs.body.map((l: any) => l.action)).toEqual(expect.arrayContaining(['auth.signup', 'PATCH /v1/organization']));
    await request(http).post('/graphql').send({ query: '{ me { id } }' }).expect(401);
    const gql = await request(http).post('/graphql').set(auth(o.token)).send({ query: '{ me { email role } callStats(days: 7) { total } }' }).expect(200);
    expect(gql.body.data.me.role).toBe('COMPANY_OWNER');
    const deep = await request(http).post('/graphql').set(auth(o.token)).send({ query: '{ calls { user { id } insight { summary } } conversations { messages { id } } }' }).expect(200);
    expect(deep.body.errors).toBeUndefined();
    const sec = await request(http).get('/v1/security/overview').set(auth(o.token)).expect(200);
    expect(sec.body.mfa.users).toBe(1);
    const ai = await request(http).post('/v1/ai/analyze').set(auth(o.token)).send({ transcript: 'Customer is angry about a broken phone and wants a refund.' }).expect(200);
    expect(ai.body).toMatchObject({ sentiment: 'negative', model: 'heuristic-v1' });
  });
});
