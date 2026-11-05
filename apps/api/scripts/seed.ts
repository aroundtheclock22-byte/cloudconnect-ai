/** Demo tenant with two weeks of realistic activity. Login: demo@cloudconnect.ai / DemoPassw0rd! */
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { analyzeTranscript } from '../src/modules/ai/analyzer';

const TRANSCRIPTS = [
  'Thanks for calling, how can I help? I would like to upgrade our plan to add ten users. Great, I will send you a quote by Friday. Perfect, thanks so much!',
  'Hi, my phone is broken and I am frustrated, this is the third time. I am sorry about that. Let me schedule a replacement. Please follow up tomorrow. Okay thanks.',
  'Hello, I am calling about the invoice. Could you explain the international charges? Sure, those are calls to the UK. Got it, that is helpful, thank you.',
  'I want to cancel. The service has been terrible and calls drop. I understand, can you tell me more about the problem? It is always late afternoon. We will investigate and call you back.',
  'Good morning! Can we book a demo for next week? Absolutely, what day works? Tuesday at 2pm. Excellent, I will send the invite. Wonderful.',
];

export async function seed(url = process.env.DATABASE_URL ?? 'postgres://cloudconnect:cloudconnect@localhost:5432/cloudconnect') {
  const c = new Client({ connectionString: url });
  await c.connect();
  const exists = await c.query(`SELECT org_id FROM users WHERE email='demo@cloudconnect.ai'`);
  if (exists.rows[0]) { console.log('demo tenant already seeded'); await c.end(); return; }
  await c.query('BEGIN');
  const org = (await c.query(`INSERT INTO organizations (name, slug, timezone, settings) VALUES ('Northwind Traders','northwind','America/New_York', $1) RETURNING id`,
    [{ recordAllCalls: true, aiAgents: { main: { company: 'Northwind Traders', instructions: 'Help callers with orders and book demos.', departments: { sales: 'sales', support: 'support' } } } }])).rows[0].id;
  const pw = await bcrypt.hash('DemoPassw0rd!', 12);
  const people = [
    ['demo@cloudconnect.ai', 'Avery', 'Chen', 'COMPANY_OWNER', 'Leadership', 'CEO'], ['maria@northwind.test', 'Maria', 'Lopez', 'ADMINISTRATOR', 'IT', 'IT Director'],
    ['sam@northwind.test', 'Sam', 'Patel', 'SUPERVISOR', 'Support', 'Support Lead'], ['jordan@northwind.test', 'Jordan', 'Kim', 'AGENT', 'Sales', 'Account Executive'],
    ['riley@northwind.test', 'Riley', 'Brooks', 'AGENT', 'Sales', 'SDR'], ['taylor@northwind.test', 'Taylor', 'Nguyen', 'AGENT', 'Support', 'Support Specialist'],
    ['casey@northwind.test', 'Casey', 'Morgan', 'RECEPTIONIST', 'Front Desk', 'Receptionist'], ['blake@northwind.test', 'Blake', 'Reed', 'BILLING_ADMIN', 'Finance', 'Controller'],
  ];
  const presences = ['available', 'available', 'on_call', 'on_call', 'available', 'busy', 'available', 'away'];
  const users: { id: string; ext: string }[] = [];
  for (const [i, p] of people.entries()) {
    const u = (await c.query(`INSERT INTO users (org_id, email, password_hash, first_name, last_name, role, department, title, presence, email_verified, last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true, now() - interval '1 hour' * $10) RETURNING id`,
      [org, p[0], pw, p[1], p[2], p[3], p[4], p[5], presences[i], i])).rows[0];
    const ext = String(101 + i);
    await c.query(`INSERT INTO extensions (org_id, number, user_id) VALUES ($1,$2,$3)`, [org, ext, u.id]);
    await c.query(`INSERT INTO voicemail_boxes (org_id, user_id, name) VALUES ($1,$2,$3)`, [org, u.id, `${p[1]}'s voicemail`]);
    users.push({ id: u.id, ext });
  }
  await c.query(`INSERT INTO subscriptions (org_id, plan_id, interval, seats, status) VALUES ($1,'business','year',25,'active')`, [org]);
  const mb = (await c.query(`SELECT id FROM voicemail_boxes WHERE user_id=$1`, [users[0].id])).rows[0].id;
  const t = (u: { id: string; ext: string }) => ({ extension: u.ext, destination: `client:${u.id}` });
  const weekday = [{ start: '09:00', end: '18:00' }];
  const flow = {
    id: 'main', name: 'Main line', entry: 'hours', recordCalls: true, blockAnonymous: false, spamScoreThreshold: 0.8,
    nodes: {
      hours: { id: 'hours', type: 'schedule', schedule: { timezone: 'America/New_York', hours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday }, holidays: [{ date: '*-12-25', name: 'Christmas' }, { date: '*-01-01', name: "New Year's Day" }] }, open: 'lang', closed: 'ai', holiday: 'holiday' },
      lang: { id: 'lang', type: 'language_select', prompt: 'For English, press 1. Para español, oprima 2.', onTimeout: 'menu', options: { '1': { language: 'en-US', next: 'menu' }, '2': { language: 'es-MX', next: 'menu_es' } } },
      menu: { id: 'menu', type: 'menu', prompt: 'Thanks for calling Northwind. For sales press 1, for support press 2, for billing press 3, or press 0 for the operator.', options: { '1': 'sales', '2': 'support', '3': 'billing', '0': 'operator' }, onTimeout: 'operator', onInvalid: 'operator' },
      menu_es: { id: 'menu_es', type: 'menu', language: 'es-MX', prompt: 'Gracias por llamar a Northwind. Para ventas oprima 1, para soporte oprima 2.', options: { '1': 'sales', '2': 'support' }, onTimeout: 'operator' },
      sales: { id: 'sales', type: 'ring_group', name: 'Sales', strategy: 'simultaneous', ringTimeoutSeconds: 20, onNoAnswer: 'vm', targets: [t(users[3]), t(users[4])] },
      support: { id: 'support', type: 'ring_group', name: 'Support', strategy: 'longest_idle', ringTimeoutSeconds: 15, onNoAnswer: 'vm', targets: [t(users[5]), t(users[2])] },
      billing: { id: 'billing', type: 'ring_group', name: 'Billing', strategy: 'sequential', ringTimeoutSeconds: 15, onNoAnswer: 'vm', targets: [t(users[7]), t(users[0])] },
      operator: { id: 'operator', type: 'ring_group', name: 'Front desk', strategy: 'simultaneous', ringTimeoutSeconds: 25, onNoAnswer: 'vm', targets: [t(users[6])] },
      ai: { id: 'ai', type: 'ai_receptionist', agentId: 'main', fallback: 'vm' },
      holiday: { id: 'holiday', type: 'say', text: 'Northwind is closed for the holiday. Please leave a message.', next: 'vm' },
      vm: { id: 'vm', type: 'voicemail', mailboxId: mb },
    },
  };
  const f = (await c.query(`INSERT INTO routing_flows (org_id, name, definition, published) VALUES ($1,'Main line',$2,true) RETURNING id`, [org, flow])).rows[0].id;
  const nums = [['+16175550100', 'local', 'US', 'Main line', f, null], ['+18885550123', 'toll_free', 'US', 'Toll-free support', f, null], ['+442071230000', 'international', 'GB', 'London office', f, null],
    ['+16175550111', 'local', 'US', 'Jordan direct', null, users[3].id]];
  const numIds: string[] = [];
  for (const n of nums) numIds.push((await c.query(`INSERT INTO phone_numbers (org_id, e164, type, country, label, routing_flow_id, assigned_user_id, monthly_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,300) RETURNING id`, [org, ...n])).rows[0].id);

  const contacts = [['Olivia', 'Park', 'Contoso', '+12125550101', ['vip', 'customer']], ['Liam', 'Smith', 'Fabrikam', '+13105550102', ['lead']], ['Emma', 'Garcia', 'Tailspin', '+14155550103', ['customer']],
    ['Noah', 'Wilson', 'Litware', '+447700900104', ['partner']], ['Ava', 'Martin', 'Adventure Works', '+13125550105', ['lead', 'demo']], ['Lucas', 'Silva', 'Wingtip', '+5511955550106', ['customer']]];
  for (const ct of contacts) await c.query(`INSERT INTO contacts (org_id, first_name, last_name, company, phones, emails, tags, favorite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [org, ct[0], ct[1], ct[2], [ct[3]], [`${String(ct[0]).toLowerCase()}@${String(ct[2]).toLowerCase().replace(/\s/g, '')}.com`], ct[4], ct[0] === 'Olivia']);

  // 14 days of calls
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };
  const callers = contacts.map((x) => x[3] as string).concat(['+12025550188', '+17185550177', '+19175550166', '+12155550155', '+33612345678', '+4915112345678']);
  for (let d = 13; d >= 0; d--) {
    const count = 18 + Math.floor(rnd() * 14) - (d % 7 >= 5 ? 12 : 0);
    for (let i = 0; i < count; i++) {
      const inbound = rnd() < 0.62;
      const agent = users[3 + Math.floor(rnd() * 4)] ?? users[3];
      const ext = callers[Math.floor(rnd() * callers.length)];
      const startedAt = new Date(Date.now() - d * 86400_000 - Math.floor(rnd() * 9 * 3600_000) - 3600_000);
      const roll = rnd();
      const status = roll < 0.78 ? 'completed' : roll < 0.9 ? 'no_answer' : 'voicemail';
      const answered = status === 'completed';
      const dur = answered ? 30 + Math.floor(rnd() * 900) : 0;
      const country = ext.startsWith('+44') ? 'GB' : ext.startsWith('+55') ? 'BR' : ext.startsWith('+33') ? 'FR' : ext.startsWith('+49') ? 'DE' : 'US';
      const cost = !inbound && country !== 'US' ? Math.ceil(dur / 60) * 2 : 0;
      const path = inbound ? JSON.stringify(['hours', 'lang', 'menu', ['sales', 'support', 'billing'][Math.floor(rnd() * 3)]]) : '[]';
      const call = (await c.query(`INSERT INTO calls (org_id, provider, provider_call_id, direction, status, from_number, to_number, user_id, phone_number_id, started_at, answered_at, ended_at, cost_cents, country, mos_score, jitter_ms, packet_loss_pct, routing_path)
        VALUES ($1,'twilio',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [org, `CAseed${d}_${i}`, inbound ? 'inbound' : 'outbound', status, inbound ? ext : '+16175550100', inbound ? '+16175550100' : ext, agent.id, numIds[0], startedAt,
         answered ? new Date(startedAt.getTime() + 8000) : null, new Date(startedAt.getTime() + 8000 + dur * 1000), cost, country, (3.9 + rnd() * 0.5).toFixed(2), Math.floor(5 + rnd() * 25), (rnd() * 1.2).toFixed(2), path])).rows[0];
      if (answered && rnd() < 0.55) {
        const text = TRANSCRIPTS[Math.floor(rnd() * TRANSCRIPTS.length)];
        const a = analyzeTranscript(text);
        await c.query(`INSERT INTO transcripts (org_id, source_type, source_id, full_text) VALUES ($1,'call',$2,$3)`, [org, call.id, text]);
        await c.query(`INSERT INTO ai_insights (org_id, source_type, source_id, summary, sentiment, sentiment_score, action_items, keywords, call_score, coaching, model, created_at) VALUES ($1,'call',$2,$3,$4,$5,$6,$7,$8,$9,'heuristic-v1',$10)`,
          [org, call.id, a.summary, a.sentiment, a.sentimentScore, JSON.stringify(a.actionItems), a.keywords, a.callScore, JSON.stringify(a.coaching), startedAt]);
        await c.query(`INSERT INTO recordings (org_id, call_id, storage_key, duration_seconds, status) VALUES ($1,$2,$3,$4,'ready')`, [org, call.id, `s3://cloudconnect-media/${org}/${call.id}.mp3`, dur]);
      }
      if (status === 'voicemail') {
        const vt = ['Hi, this is about my order, please call me back.', 'Calling to reschedule our meeting to Thursday.', 'Question about the invoice, call me at your convenience.'][Math.floor(rnd() * 3)];
        await c.query(`INSERT INTO voicemails (org_id, mailbox_id, call_id, from_number, storage_key, duration_seconds, transcript, ai_summary, is_read, created_at) VALUES ($1,$2,$3,$4,'s3://demo/vm.mp3',$5,$6,$7,$8,$9)`,
          [org, mb, call.id, ext, 10 + Math.floor(rnd() * 40), vt, vt.replace(/^Hi, /, ''), d > 1, startedAt]);
      }
      await c.query(`INSERT INTO usage_records (org_id, kind, quantity, cost_cents, source_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`, [org, cost ? 'minutes_international' : 'minutes_domestic', Math.ceil(dur / 60), cost, call.id, startedAt]);
    }
  }
  // live calls
  for (const [i, u] of [users[2], users[3]].entries()) {
    await c.query(`INSERT INTO calls (org_id, provider, provider_call_id, direction, status, from_number, to_number, user_id, phone_number_id, started_at, answered_at, country) VALUES ($1,'twilio',$2,'inbound','in_progress',$3,'+16175550100',$4,$5, now() - interval '1 minute' * $6, now() - interval '1 minute' * $6, 'US')`,
      [org, `CAlive${i}`, callers[i], u.id, numIds[0], 3 + i * 4]);
  }
  // SMS conversations
  const threads = [[contacts[0][3], ['Hi! Is my order shipping today?', 'Yes — it ships this afternoon, tracking to follow.', 'Amazing, thank you!']], [contacts[1][3], ['Can we move our call to 3pm?', 'Sure, 3pm works. See you then.']], [contacts[4][3], ['Interested in a demo next week', 'Great! Does Tuesday 2pm ET work?']]];
  for (const [phone, msgs] of threads as [string, string[]][]) {
    const conv = (await c.query(`INSERT INTO conversations (org_id, kind, phone_number_id, participants) VALUES ($1,'sms',$2,$3) RETURNING id`, [org, numIds[0], [phone]])).rows[0];
    for (const [i, body] of msgs.entries()) {
      const inbound = i % 2 === 0;
      await c.query(`INSERT INTO messages (org_id, conversation_id, direction, status, sender_user_id, from_address, to_addresses, body, created_at, read_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 minute' * $9, $10)`,
        [org, conv.id, inbound ? 'inbound' : 'outbound', inbound ? 'received' : 'delivered', inbound ? null : users[3].id, inbound ? phone : '+16175550100', [inbound ? '+16175550100' : phone], body, (msgs.length - i) * 7, inbound && i < msgs.length - 1 ? new Date() : null]);
    }
  }
  const team = (await c.query(`INSERT INTO conversations (org_id, kind, title, participants) VALUES ($1,'team_chat','#sales',$2) RETURNING id`, [org, users.slice(0, 5).map((u) => u.id).sort()])).rows[0];
  for (const [i, body] of ['Big demo with Adventure Works on Tuesday 🎉', 'Nice! I’ll prep the deck.', 'Pricing sheet is in the shared drive.'].entries())
    await c.query(`INSERT INTO messages (org_id, conversation_id, direction, status, sender_user_id, from_address, to_addresses, body, created_at) VALUES ($1,$2,'outbound','delivered',$3,$6,'{}',$4, now() - interval '1 minute' * $5)`, [org, team.id, users[i + 2].id, body, 30 - i * 5, users[i + 2].id]);
  for (const [i, title] of ['Weekly sales sync', 'Adventure Works demo', 'Q4 planning'].entries())
    await c.query(`INSERT INTO meetings (org_id, host_id, title, join_code, scheduled_start, scheduled_end, waiting_room) VALUES ($1,$2,$3,$4, now() + interval '1 day' * $5, now() + interval '1 day' * $5 + interval '45 minutes', true)`, [org, users[i].id, title, `90000000${i}${i}`, i + 1]);
  await c.query(`INSERT INTO teams (org_id, name) VALUES ($1,'Sales'),($1,'Support')`, [org]);
  await c.query(`INSERT INTO sms_templates (org_id, name, body) VALUES ($1,'Appointment reminder','Hi {{name}}, reminder of your appointment on {{date}}. Reply C to confirm.'),($1,'Thanks for calling','Thanks for calling Northwind! Reply here anytime.')`, [org]);
  await c.query(`INSERT INTO audit_logs (org_id, actor_id, action, ip, created_at) SELECT $1, $2, a, '203.0.113.10', now() - interval '1 hour' * g FROM unnest(ARRAY['auth.login','POST /v1/users','PATCH /v1/numbers/:id','PUT /v1/routing-flows/:id','auth.mfa_enabled']) WITH ORDINALITY AS t(a, g)`, [org, users[1].id]);
  await c.query('COMMIT');
  await c.end();
  console.log('seeded demo tenant: demo@cloudconnect.ai / DemoPassw0rd!');
}
if (require.main === module) seed().catch((e) => { console.error(e); process.exit(1); });
