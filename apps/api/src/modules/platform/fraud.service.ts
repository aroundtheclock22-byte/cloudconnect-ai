import { Injectable } from '@nestjs/common';
import { Db } from '../../common/db.service';
import { config } from '../../config';

/** International Revenue Share Fraud hot-spot prefixes (sample; production syncs a carrier feed). */
export const HIGH_RISK_PREFIXES = ['+881', '+882', '+883', '+979', '+8816', '+2392', '+2353', '+3732', '+6759', '+6794', '+675'];

export interface FraudVerdict { allowed: boolean; score: number; reasons: string[] }

@Injectable()
export class FraudService {
  constructor(private db: Db) {}

  /** Outbound call fraud screening: IRSF destinations, country allowlist, velocity. */
  async checkOutbound(orgId: string, to: string, allowedCountries?: string[], country?: string | null): Promise<FraudVerdict> {
    const reasons: string[] = [];
    let score = 0;
    if (HIGH_RISK_PREFIXES.some((p) => to.startsWith(p))) { score += 0.8; reasons.push('high_risk_destination'); }
    if (allowedCountries?.length && country && !allowedCountries.includes(country)) { score += 0.6; reasons.push('country_not_allowed'); }
    const v = await this.db.one<{ n: string }>(`SELECT count(*) n FROM calls WHERE org_id=$1 AND direction='outbound' AND started_at > now() - interval '10 minutes'`, [orgId]);
    if (Number(v?.n ?? 0) >= config().FRAUD_MAX_CALLS_PER_10MIN) { score += 0.7; reasons.push('velocity'); }
    score = Math.min(1, score);
    const allowed = score < 0.6;
    if (reasons.length) {
      await this.db.query(`INSERT INTO fraud_events (org_id, kind, score, details, action) VALUES ($1,$2,$3,$4,$5)`,
        [orgId, reasons[0], score, { to, reasons }, allowed ? 'flagged' : 'blocked']);
    }
    return { allowed, score, reasons };
  }

  /** Inbound spam likelihood (0..1). Combines platform-wide reputation with heuristics. */
  async spamScore(from: string, to: string): Promise<number> {
    if (!/^\+[1-9]\d{6,14}$/.test(from)) return 0.3;
    let score = 0;
    // Neighbor spoofing: same NPA-NXX as the destination
    if (from.startsWith('+1') && to.startsWith('+1') && from.slice(0, 8) === to.slice(0, 8) && from !== to) score += 0.35;
    // Robocall pattern: many short calls across tenants within the last hour
    const r = await this.db.one<{ n: string; short: string }>(
      `SELECT count(*) n, count(*) FILTER (WHERE duration_seconds < 10) short FROM calls WHERE from_number=$1 AND started_at > now() - interval '1 hour'`, [from]);
    const n = Number(r?.n ?? 0), short = Number(r?.short ?? 0);
    if (n >= 20) score += 0.4;
    if (n >= 5 && short / n > 0.8) score += 0.3;
    // Explicit blocks across orgs
    const b = await this.db.one<{ n: string }>(`SELECT count(DISTINCT org_id) n FROM blocked_numbers WHERE e164=$1`, [from]);
    score += Math.min(0.5, Number(b?.n ?? 0) * 0.1);
    return Math.min(1, Number(score.toFixed(2)));
  }
}
