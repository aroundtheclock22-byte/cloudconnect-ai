import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Logger, NotFoundException, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { computeInvoice, PlanId, PLANS } from '@cloudconnect/shared';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth';
import { Db } from '../../common/db.service';
import { z$ } from '../../common/validation';
import { config } from '../../config';

const Checkout = z.object({ planId: z.enum(['starter', 'pro', 'business', 'enterprise']), interval: z.enum(['month', 'year']), seats: z.number().int().min(1).max(100_000), coupon: z.string().max(40).optional() });

/** Converts USD cents to the org's display currency (rates refreshed daily by the FX job in prod). */
const FX: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.52, INR: 83.2, JPY: 151, MXN: 17.1, BRL: 5.0 };
export const toCurrency = (cents: number, currency: string) => Math.round(cents * (FX[currency] ?? 1));

@ApiTags('billing')
@Controller('v1/billing')
export class BillingController {
  private log = new Logger('Billing');
  private stripe = config().STRIPE_SECRET_KEY ? new Stripe(config().STRIPE_SECRET_KEY!) : null;
  constructor(private db: Db) {}

  @Public() @Get('plans')
  plans(@Query('currency') currency = 'USD') {
    return Object.values(PLANS).map((p) => ({ ...p, currency, monthlyPerUser: toCurrency(p.monthlyPerUserCents, currency), annualPerUser: toCurrency(p.annualPerUserCents, currency) }));
  }

  @Public() @Get('rates')
  rates(@Query('country') country?: string) {
    return this.db.query(`SELECT prefix, country, per_minute_cents "perMinuteCents", sms_cents "smsCents" FROM rates WHERE ($1::text IS NULL OR country ILIKE $1 || '%') ORDER BY country, prefix`, [country ?? null]);
  }

  @RequirePermissions('billing:read') @Get('subscription')
  async subscription(@CurrentUser() u: AuthUser) {
    const s = await this.db.one(`SELECT s.plan_id "planId", s.interval, s.seats, s.status, s.trial_ends_at "trialEndsAt", s.current_period_start "periodStart", s.current_period_end "periodEnd", s.coupon_code "coupon",
      (SELECT count(*)::int FROM users WHERE org_id=s.org_id AND deleted_at IS NULL) "activeUsers", o.currency FROM subscriptions s JOIN organizations o ON o.id=s.org_id WHERE s.org_id=$1`, [u.orgId]);
    if (!s) throw new NotFoundException();
    return { ...s, plan: PLANS[s.planId as PlanId] };
  }

  /** Usage-based invoice preview for the current period (plan + overage + intl + toll-free + tax + coupon). */
  @RequirePermissions('billing:read') @Get('invoice-preview')
  async preview(@CurrentUser() u: AuthUser) {
    const s = await this.db.one(`SELECT s.*, o.currency, o.country, o.settings FROM subscriptions s JOIN organizations o ON o.id=s.org_id WHERE s.org_id=$1`, [u.orgId]);
    const usage = await this.db.one(`SELECT
        COALESCE(sum(quantity) FILTER (WHERE kind='minutes_domestic'),0)::int minutes, COALESCE(sum(quantity) FILTER (WHERE kind IN ('sms','mms')),0)::int sms,
        COALESCE(sum(cost_cents) FILTER (WHERE kind='minutes_international'),0)::int intl, COALESCE(sum(quantity) FILTER (WHERE kind='minutes_toll_free'),0)::int tf
      FROM usage_records WHERE org_id=$1 AND occurred_at >= $2`, [u.orgId, s.current_period_start]);
    const coupon = s.coupon_code ? await this.db.one(`SELECT percent_off FROM coupons WHERE code=$1`, [s.coupon_code]) : null;
    const inv = computeInvoice({ planId: s.plan_id, interval: s.interval, seats: s.seats, usage: { minutes: usage.minutes, sms: usage.sms, internationalCents: usage.intl, tollFreeMinutes: usage.tf },
      couponPercentOff: coupon?.percent_off, taxRatePercent: s.settings?.taxRatePercent ?? 0 });
    return { ...inv, currency: s.currency, displayTotal: toCurrency(inv.totalCents, s.currency), periodStart: s.current_period_start, periodEnd: s.current_period_end };
  }

  @RequirePermissions('billing:read') @Get('invoices')
  invoices(@CurrentUser() u: AuthUser) {
    return this.db.query(`SELECT id, number, currency, period_start "periodStart", period_end "periodEnd", subtotal_cents "subtotalCents", discount_cents "discountCents", tax_cents "taxCents", total_cents "totalCents", status, created_at "createdAt" FROM invoices WHERE org_id=$1 ORDER BY created_at DESC`, [u.orgId]);
  }

  @RequirePermissions('billing:read') @Get('usage')
  usage(@CurrentUser() u: AuthUser, @Query('days') days = '30') {
    return this.db.query(`SELECT date_trunc('day', occurred_at) day, kind, sum(quantity)::float quantity, sum(cost_cents)::int "costCents" FROM usage_records WHERE org_id=$1 AND occurred_at > now() - make_interval(days => $2) GROUP BY 1,2 ORDER BY 1`,
      [u.orgId, Math.min(Number(days) || 30, 400)]);
  }

  /** Starts a Stripe Checkout session; without Stripe configured (dev), applies the plan directly. */
  @RequirePermissions('billing:write') @HttpCode(200) @Post('checkout')
  async checkout(@CurrentUser() u: AuthUser, @Body(z$(Checkout)) b: z.infer<typeof Checkout>) {
    let couponPct: number | null = null;
    if (b.coupon) {
      const c = await this.db.one(`SELECT * FROM coupons WHERE code=$1 AND (valid_until IS NULL OR valid_until > now()) AND (max_redemptions IS NULL OR redemptions < max_redemptions)`, [b.coupon.toUpperCase()]);
      if (!c) throw new BadRequestException('Invalid or expired coupon');
      couponPct = c.percent_off;
    }
    const users = await this.db.one(`SELECT count(*)::int n FROM users WHERE org_id=$1 AND deleted_at IS NULL`, [u.orgId]);
    if (b.seats < users.n) throw new BadRequestException(`Seats must cover your ${users.n} active users`);
    if (!this.stripe) {
      await this.db.query(`UPDATE subscriptions SET plan_id=$2, interval=$3, seats=$4, status='active', coupon_code=$5, current_period_start=now(), current_period_end=now() + CASE WHEN $3='year' THEN interval '1 year' ELSE interval '1 month' END WHERE org_id=$1`,
        [u.orgId, b.planId, b.interval, b.seats, b.coupon?.toUpperCase() ?? null]);
      if (b.coupon) await this.db.query(`UPDATE coupons SET redemptions=redemptions+1 WHERE code=$1`, [b.coupon.toUpperCase()]);
      return { mode: 'direct', planId: b.planId, couponPercentOff: couponPct };
    }
    const prices = JSON.parse(config().STRIPE_PRICE_IDS);
    const price = prices[`${b.planId}_${b.interval}`];
    if (!price) throw new BadRequestException('Plan is not available for online checkout');
    const sub = await this.db.one(`SELECT s.stripe_customer_id, o.name FROM subscriptions s JOIN organizations o ON o.id=s.org_id WHERE s.org_id=$1`, [u.orgId]);
    let customer = sub.stripe_customer_id;
    if (!customer) {
      customer = (await this.stripe.customers.create({ name: sub.name, metadata: { orgId: u.orgId } })).id;
      await this.db.query(`UPDATE subscriptions SET stripe_customer_id=$2 WHERE org_id=$1`, [u.orgId, customer]);
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription', customer, line_items: [{ price, quantity: b.seats }], automatic_tax: { enabled: true }, tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' }, allow_promotion_codes: !b.coupon, subscription_data: { metadata: { orgId: u.orgId, planId: b.planId } },
      success_url: `${config().WEB_URL}/admin/billing?status=success`, cancel_url: `${config().WEB_URL}/admin/billing?status=cancel`,
    });
    return { mode: 'stripe', url: session.url };
  }

  @RequirePermissions('billing:write') @HttpCode(200) @Post('portal')
  async portal(@CurrentUser() u: AuthUser) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');
    const s = await this.db.one(`SELECT stripe_customer_id FROM subscriptions WHERE org_id=$1`, [u.orgId]);
    if (!s?.stripe_customer_id) throw new BadRequestException('No billing account yet');
    return { url: (await this.stripe.billingPortal.sessions.create({ customer: s.stripe_customer_id, return_url: `${config().WEB_URL}/admin/billing` })).url };
  }

  @Public() @SkipThrottle() @HttpCode(200) @Post('stripe/webhook')
  async webhook(@Req() req: Request, @Headers('stripe-signature') sig: string) {
    if (!this.stripe || !config().STRIPE_WEBHOOK_SECRET) throw new BadRequestException('Stripe not configured');
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent((req as any).rawBody, sig, config().STRIPE_WEBHOOK_SECRET!); } catch { throw new BadRequestException('Invalid signature'); }
    switch (event.type) {
      case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted': {
        const s = event.data.object as Stripe.Subscription;
        const item = s.items.data[0];
        await this.db.query(`UPDATE subscriptions SET stripe_subscription_id=$2, status=$3, seats=$4, plan_id=COALESCE($5, plan_id), interval=$6,
          current_period_start=to_timestamp($7), current_period_end=to_timestamp($8) WHERE stripe_customer_id=$1`,
          [s.customer, s.id, s.status === 'active' || s.status === 'trialing' || s.status === 'past_due' || s.status === 'incomplete' ? s.status : 'canceled', item?.quantity ?? 1, s.metadata?.planId ?? null,
           item?.price?.recurring?.interval === 'year' ? 'year' : 'month', (s as any).current_period_start ?? (item as any)?.current_period_start, (s as any).current_period_end ?? (item as any)?.current_period_end]);
        break;
      }
      case 'invoice.paid': case 'invoice.finalized': case 'invoice.payment_failed': {
        const i = event.data.object as Stripe.Invoice;
        const org = await this.db.one(`SELECT org_id FROM subscriptions WHERE stripe_customer_id=$1`, [i.customer]);
        if (!org) break;
        await this.db.query(`INSERT INTO invoices (org_id, number, currency, period_start, period_end, lines, subtotal_cents, discount_cents, tax_cents, total_cents, status, stripe_invoice_id)
          VALUES ($1,$2,$3,to_timestamp($4),to_timestamp($5),$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (number) DO UPDATE SET status=EXCLUDED.status`,
          [org.org_id, i.number ?? i.id, (i.currency ?? 'usd').toUpperCase(), i.period_start, i.period_end, JSON.stringify(i.lines.data.map((l) => ({ description: l.description, amountCents: l.amount }))),
           i.subtotal, (i.total_discount_amounts ?? []).reduce((s, d) => s + d.amount, 0), (i as any).tax ?? 0, i.total, event.type === 'invoice.paid' ? 'paid' : event.type === 'invoice.payment_failed' ? 'uncollectible' : 'open', i.id]);
        if (event.type === 'invoice.payment_failed') await this.db.query(`UPDATE subscriptions SET status='past_due' WHERE org_id=$1`, [org.org_id]);
        break;
      }
      default: this.log.debug(`unhandled stripe event ${event.type}`);
    }
    return { received: true };
  }
}
