/** Subscription plans and usage rating. Amounts are integer cents (USD base currency). */
export type PlanId = 'starter' | 'pro' | 'business' | 'enterprise';
export interface Plan {
  id: PlanId; name: string; monthlyPerUserCents: number; annualPerUserCents: number;
  includedMinutesPerUser: number; includedSmsPerUser: number; maxMeetingParticipants: number;
  features: string[];
}
export const PLANS: Record<PlanId, Plan> = {
  starter: { id: 'starter', name: 'Starter', monthlyPerUserCents: 2000, annualPerUserCents: 1500, includedMinutesPerUser: 1000, includedSmsPerUser: 100, maxMeetingParticipants: 50,
    features: ['local_numbers', 'voicemail', 'sms', 'video', 'mobile_apps', 'auto_receptionist'] },
  pro: { id: 'pro', name: 'Pro', monthlyPerUserCents: 3000, annualPerUserCents: 2500, includedMinutesPerUser: 2500, includedSmsPerUser: 500, maxMeetingParticipants: 100,
    features: ['local_numbers', 'toll_free', 'voicemail', 'voicemail_transcription', 'sms', 'video', 'mobile_apps', 'auto_receptionist', 'ivr', 'ring_groups', 'call_recording', 'crm_integrations'] },
  business: { id: 'business', name: 'Business', monthlyPerUserCents: 4500, annualPerUserCents: 3500, includedMinutesPerUser: 5000, includedSmsPerUser: 1000, maxMeetingParticipants: 200,
    features: ['*', '-sso', '-hipaa'] },
  enterprise: { id: 'enterprise', name: 'Enterprise', monthlyPerUserCents: 6500, annualPerUserCents: 5500, includedMinutesPerUser: 10000, includedSmsPerUser: 2500, maxMeetingParticipants: 500,
    features: ['*'] },
};

export function planHasFeature(planId: PlanId, feature: string): boolean {
  const f = PLANS[planId].features;
  if (f.includes(`-${feature}`)) return false;
  return f.includes('*') || f.includes(feature);
}

export interface Rate { prefix: string; country: string; perMinuteCents: number; smsCents: number }
/** Sample international rate deck; production loads the carrier rate deck into `rates` table. */
export const DEFAULT_RATES: Rate[] = [
  { prefix: '1', country: 'US', perMinuteCents: 0, smsCents: 1 },
  { prefix: '1800', country: 'US-TF', perMinuteCents: 2, smsCents: 1 },
  { prefix: '44', country: 'GB', perMinuteCents: 2, smsCents: 4 },
  { prefix: '447', country: 'GB-MOBILE', perMinuteCents: 6, smsCents: 4 },
  { prefix: '49', country: 'DE', perMinuteCents: 2, smsCents: 8 },
  { prefix: '33', country: 'FR', perMinuteCents: 2, smsCents: 7 },
  { prefix: '91', country: 'IN', perMinuteCents: 3, smsCents: 2 },
  { prefix: '52', country: 'MX', perMinuteCents: 3, smsCents: 5 },
  { prefix: '61', country: 'AU', perMinuteCents: 4, smsCents: 6 },
  { prefix: '81', country: 'JP', perMinuteCents: 9, smsCents: 8 },
];

export function findRate(e164: string, rates: Rate[] = DEFAULT_RATES): Rate | undefined {
  const d = e164.replace('+', '');
  return rates.filter((r) => d.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/** Calls are billed per started minute (60/60 increments). */
export function rateCall(e164: string, durationSeconds: number, rates?: Rate[]): number {
  const rate = findRate(e164, rates);
  if (!rate || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60) * rate.perMinuteCents;
}

export interface InvoiceLine { description: string; quantity: number; unitCents: number; amountCents: number }
export interface InvoiceInput {
  planId: PlanId; interval: 'month' | 'year'; seats: number;
  usage: { minutes: number; sms: number; internationalCents: number; tollFreeMinutes: number };
  couponPercentOff?: number; taxRatePercent?: number;
}
export function computeInvoice(i: InvoiceInput): { lines: InvoiceLine[]; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number } {
  const plan = PLANS[i.planId];
  const unit = i.interval === 'year' ? plan.annualPerUserCents * 12 : plan.monthlyPerUserCents;
  const lines: InvoiceLine[] = [{ description: `${plan.name} plan (${i.interval}ly) per user`, quantity: i.seats, unitCents: unit, amountCents: unit * i.seats }];
  const overMinutes = Math.max(0, i.usage.minutes - plan.includedMinutesPerUser * i.seats);
  if (overMinutes) lines.push({ description: 'Domestic minutes overage', quantity: overMinutes, unitCents: 2, amountCents: overMinutes * 2 });
  const overSms = Math.max(0, i.usage.sms - plan.includedSmsPerUser * i.seats);
  if (overSms) lines.push({ description: 'SMS overage', quantity: overSms, unitCents: 1, amountCents: overSms });
  if (i.usage.tollFreeMinutes) lines.push({ description: 'Toll-free inbound minutes', quantity: i.usage.tollFreeMinutes, unitCents: 2, amountCents: i.usage.tollFreeMinutes * 2 });
  if (i.usage.internationalCents) lines.push({ description: 'International usage', quantity: 1, unitCents: i.usage.internationalCents, amountCents: i.usage.internationalCents });
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const discountCents = Math.round(subtotalCents * (i.couponPercentOff ?? 0) / 100);
  const taxCents = Math.round((subtotalCents - discountCents) * (i.taxRatePercent ?? 0) / 100);
  return { lines, subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}
