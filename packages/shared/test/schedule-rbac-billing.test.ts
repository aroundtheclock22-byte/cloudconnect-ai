import { evaluateSchedule, toLocalTime } from '../src/schedule';
import { hasPermission, canAssignRole, ROLES, ROLE_PERMISSIONS } from '../src/rbac';
import { normalizeE164, isTollFree, vanityToDigits, countryOf } from '../src/phone';
import { rateCall, computeInvoice, planHasFeature, findRate } from '../src/billing';

describe('schedule', () => {
  it('converts to local time across DST', () => {
    expect(toLocalTime(new Date('2026-07-01T16:00:00Z'), 'America/New_York')).toMatchObject({ minutes: 12 * 60, weekday: 'wed' });
    expect(toLocalTime(new Date('2026-12-01T16:00:00Z'), 'America/New_York')).toMatchObject({ minutes: 11 * 60, weekday: 'tue' });
  });
  it('handles overnight ranges', () => {
    const s = { timezone: 'UTC', hours: { fri: [{ start: '22:00', end: '06:00' }] } };
    expect(evaluateSchedule(s, new Date('2026-11-06T23:00:00Z'))).toBe('open');   // Fri 23:00
    expect(evaluateSchedule(s, new Date('2026-11-07T05:00:00Z'))).toBe('open');   // Sat 05:00
    expect(evaluateSchedule(s, new Date('2026-11-07T07:00:00Z'))).toBe('closed');
  });
  it('supports partial-day holidays', () => {
    const s = { timezone: 'UTC', hours: { thu: [{ start: '09:00', end: '17:00' }] }, holidays: [{ date: '2026-11-26', name: 'Thanksgiving', ranges: [{ start: '09:00', end: '12:00' }] }] };
    expect(evaluateSchedule(s, new Date('2026-11-26T10:00:00Z'))).toBe('open');
    expect(evaluateSchedule(s, new Date('2026-11-26T13:00:00Z'))).toBe('holiday');
  });
});

describe('rbac', () => {
  it('every role has a permission set', () => ROLES.forEach((r) => expect(ROLE_PERMISSIONS[r].size).toBeGreaterThan(0)));
  it('enforces least privilege', () => {
    expect(hasPermission('READ_ONLY', 'calls:make')).toBe(false);
    expect(hasPermission('SUPERVISOR', 'calls:barge')).toBe(true);
    expect(hasPermission('AGENT', 'calls:barge')).toBe(false);
    expect(hasPermission('BILLING_ADMIN', 'billing:write')).toBe(true);
    expect(hasPermission('ADMINISTRATOR', 'billing:write')).toBe(false);
    expect(hasPermission('COMPANY_OWNER', 'platform:admin')).toBe(false);
  });
  it('prevents privilege escalation', () => {
    expect(canAssignRole('ADMINISTRATOR', 'COMPANY_OWNER')).toBe(false);
    expect(canAssignRole('ADMINISTRATOR', 'AGENT')).toBe(true);
    expect(canAssignRole('COMPANY_OWNER', 'SUPER_ADMIN')).toBe(false);
    expect(canAssignRole('MANAGER', 'AGENT')).toBe(false); // no users:write
  });
});

describe('phone', () => {
  it('normalizes numbers', () => {
    expect(normalizeE164('(415) 555-0100')).toBe('+14155550100');
    expect(normalizeE164('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizeE164('abc')).toBeNull();
  });
  it('detects toll free, vanity and country', () => {
    expect(isTollFree('+18005550100')).toBe(true);
    expect(vanityToDigits('1-800-FLOWERS')).toBe('18003569377');
    expect(countryOf('+442079460958')).toBe('GB');
    expect(countryOf('+971501234567')).toBe('AE');
  });
});

describe('billing', () => {
  it('uses longest-prefix rates and per-minute rounding', () => {
    expect(findRate('+447700900123')?.country).toBe('GB-MOBILE');
    expect(rateCall('+447700900123', 61)).toBe(12);
    expect(rateCall('+14155550100', 600)).toBe(0);
  });
  it('computes invoices with overage, coupons and tax', () => {
    const inv = computeInvoice({ planId: 'pro', interval: 'month', seats: 2, usage: { minutes: 5100, sms: 1000, internationalCents: 250, tollFreeMinutes: 0 }, couponPercentOff: 10, taxRatePercent: 8 });
    // 2*3000 + 100*2 + 0 + 250 = 6450
    expect(inv.subtotalCents).toBe(6450);
    expect(inv.discountCents).toBe(645);
    expect(inv.taxCents).toBe(464);
    expect(inv.totalCents).toBe(6450 - 645 + 464);
  });
  it('gates features by plan', () => {
    expect(planHasFeature('starter', 'ivr')).toBe(false);
    expect(planHasFeature('business', 'ivr')).toBe(true);
    expect(planHasFeature('business', 'sso')).toBe(false);
    expect(planHasFeature('enterprise', 'sso')).toBe(true);
  });
});
