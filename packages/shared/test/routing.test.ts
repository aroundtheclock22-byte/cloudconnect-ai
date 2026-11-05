import { RoutingFlow, step, screenCall, validateFlow, orderTargets, HANGUP_NODE } from '../src/routing';

const schedule = { timezone: 'America/New_York', hours: { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }] }, holidays: [{ date: '*-12-25', name: 'Christmas' }] };

const flow: RoutingFlow = {
  id: 'f1', name: 'Main', entry: 'hours', recordCalls: true, blockAnonymous: true, spamScoreThreshold: 0.9,
  nodes: {
    hours: { id: 'hours', type: 'schedule', schedule, open: 'menu', closed: 'vm', holiday: 'holidayMsg' },
    menu: { id: 'menu', type: 'menu', prompt: 'Press 1 for sales, 2 for support', options: { '1': 'sales', '2': 'support' }, onTimeout: 'operator', onInvalid: 'operator', maxRetries: 1 },
    sales: { id: 'sales', type: 'ring_group', name: 'Sales', strategy: 'simultaneous', ringTimeoutSeconds: 20, onNoAnswer: 'vm',
      targets: [{ extension: '101', destination: 'client:alice' }, { extension: '102', destination: 'client:bob' }, { extension: '103', destination: 'client:carol', available: false }] },
    support: { id: 'support', type: 'ring_group', name: 'Support', strategy: 'sequential', ringTimeoutSeconds: 15, onNoAnswer: 'vm',
      targets: [{ extension: '201', destination: 'client:dan' }, { extension: '202', destination: 'client:eve' }] },
    operator: { id: 'operator', type: 'forward', to: '+15550001111' },
    vm: { id: 'vm', type: 'voicemail', mailboxId: 'mb1' },
    holidayMsg: { id: 'holidayMsg', type: 'say', text: 'We are closed for the holiday.', next: 'vm' },
  },
};

// Monday 2026-11-02 14:00 New York = 19:00 UTC
const OPEN = new Date('2026-11-02T19:00:00Z');
const CLOSED = new Date('2026-11-03T03:00:00Z'); // Mon 22:00 NY
const XMAS = new Date('2026-12-25T16:00:00Z');

describe('routing engine', () => {
  it('validates a well-formed flow', () => expect(validateFlow(flow)).toEqual([]));

  it('detects broken references', () => {
    const bad: RoutingFlow = { ...flow, nodes: { ...flow.nodes, vm: undefined as any } };
    delete (bad.nodes as any).vm;
    expect(validateFlow(bad).join()).toMatch(/missing node "vm"/);
  });

  it('screens anonymous, blocked and spam callers', () => {
    expect(screenCall(flow, { from: 'anonymous', to: '+1' })).toEqual({ kind: 'reject', reason: 'anonymous' });
    expect(screenCall(flow, { from: '+15551234567', to: '+1', blocked: true })?.kind).toBe('reject');
    expect(screenCall(flow, { from: '+15551234567', to: '+1', spamScore: 0.95 })).toEqual({ kind: 'reject', reason: 'spam' });
    expect(screenCall(flow, { from: '+15551234567', to: '+1', spamScore: 0.1 })).toBeNull();
  });

  it('plays the IVR menu during business hours', () => {
    const a = step(flow, undefined, { from: '+1', to: '+1', now: OPEN });
    expect(a).toMatchObject({ kind: 'gather', nodeId: 'menu' });
  });

  it('goes to voicemail after hours and announces holidays', () => {
    expect(step(flow, undefined, { from: '+1', to: '+1', now: CLOSED }).kind).toBe('voicemail');
    expect(step(flow, undefined, { from: '+1', to: '+1', now: XMAS })).toMatchObject({ kind: 'say', then: { nodeId: 'vm' } });
  });

  it('rings available group members simultaneously with recording', () => {
    const a = step(flow, 'menu', { from: '+1', to: '+1', digits: '1' });
    expect(a).toMatchObject({ kind: 'dial', targets: ['client:alice', 'client:bob'], record: true, then: { nodeId: 'vm' } });
  });

  it('hunts sequentially then falls to voicemail', () => {
    const first = step(flow, 'menu', { from: '+1', to: '+1', digits: '2' });
    expect(first).toMatchObject({ kind: 'dial', targets: ['client:dan'], then: { nodeId: 'support', attempt: 1 } });
    const second = step(flow, 'support', { from: '+1', to: '+1', attempt: 1 });
    expect(second).toMatchObject({ kind: 'dial', targets: ['client:eve'], then: { nodeId: 'vm' } });
  });

  it('re-prompts on invalid input, then falls back', () => {
    expect(step(flow, 'menu', { from: '+1', to: '+1', digits: '9', attempt: 0 })).toMatchObject({ kind: 'say', then: { nodeId: 'menu', attempt: 1 } });
    expect(step(flow, 'menu', { from: '+1', to: '+1', digits: '9', attempt: 1 })).toMatchObject({ kind: 'dial', targets: ['+15550001111'], then: { nodeId: HANGUP_NODE } });
    expect(step(flow, HANGUP_NODE, { from: '+1', to: '+1' })).toEqual({ kind: 'hangup' });
  });

  it('supports multi-language selection', () => {
    const ml: RoutingFlow = { id: 'm', name: 'ML', entry: 'lang', nodes: {
      lang: { id: 'lang', type: 'language_select', prompt: 'For English press 1. Para español oprima 2.', onTimeout: 'en', options: { '1': { language: 'en-US', next: 'en' }, '2': { language: 'es-MX', next: 'es' } } },
      en: { id: 'en', type: 'say', text: 'Welcome', next: 'bye' },
      es: { id: 'es', type: 'say', text: 'Bienvenido', next: 'bye' },
      bye: { id: 'bye', type: 'hangup' },
    } };
    expect(step(ml, 'lang', { from: '+1', to: '+1', digits: '2' })).toMatchObject({ kind: 'say', text: 'Bienvenido', language: 'es-MX' });
  });

  it('detects routing loops', () => {
    const loop: RoutingFlow = { id: 'l', name: 'L', entry: 'a', nodes: {
      a: { id: 'a', type: 'schedule', schedule: { timezone: 'UTC', hours: {} }, open: 'b', closed: 'b' },
      b: { id: 'b', type: 'schedule', schedule: { timezone: 'UTC', hours: {} }, open: 'a', closed: 'a' },
    } };
    expect(() => step(loop, undefined, { from: '+1', to: '+1' })).toThrow(/loop/);
  });

  it('orders round robin and longest idle', () => {
    const t = [{ extension: '1', destination: 'a', lastCallEndedAt: 30 }, { extension: '2', destination: 'b', lastCallEndedAt: 10 }, { extension: '3', destination: 'c', lastCallEndedAt: 20 }];
    expect(orderTargets('round_robin', t, 1).map((x) => x.destination)).toEqual(['b', 'c', 'a']);
    expect(orderTargets('longest_idle', t).map((x) => x.destination)).toEqual(['b', 'c', 'a']);
  });
});
