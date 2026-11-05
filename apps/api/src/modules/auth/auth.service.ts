import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { createPublicKey, randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import { Role } from '@cloudconnect/shared';
import { Db } from '../../common/db.service';
import { decrypt, encrypt, randomToken, sha256 } from '../../common/crypto';
import { signAccessToken } from '../../common/auth';
import { AuditService } from '../../common/audit';
import { config } from '../../config';

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }
export interface PublicUser { id: string; orgId: string; email: string; firstName: string; lastName: string; role: Role; mfaEnabled: boolean; extension?: string | null }

const BCRYPT_ROUNDS = 12;
authenticator.options = { window: 1 };

export const OAUTH_PROVIDERS = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', iss: ['https://accounts.google.com', 'accounts.google.com'] },
  microsoft: { auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/common/discovery/v2.0/keys', iss: null },
  apple: { auth: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'] },
} as const;
export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

@Injectable()
export class AuthService {
  constructor(private db: Db, private audit: AuditService) {}

  private toPublic(u: any): PublicUser {
    return { id: u.id, orgId: u.org_id, email: u.email, firstName: u.first_name, lastName: u.last_name, role: u.role, mfaEnabled: u.mfa_enabled, extension: u.extension ?? null };
  }

  validatePassword(pw: string) {
    if (pw.length < 10 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
      throw new BadRequestException('Password must be at least 10 characters with upper, lower case letters and a digit');
    }
  }

  async signup(p: { orgName: string; email: string; password: string; firstName: string; lastName?: string; timezone?: string; country?: string }, meta: { ip?: string; ua?: string }): Promise<TokenPair> {
    this.validatePassword(p.password);
    const exists = await this.db.one(`SELECT 1 FROM users WHERE email=$1 AND deleted_at IS NULL`, [p.email]);
    if (exists) throw new ConflictException('An account with this email already exists');
    const hash = await bcrypt.hash(p.password, BCRYPT_ROUNDS);
    const user = await this.db.tx(null, async (c) => {
      const slug = p.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '');
      const org = (await c.query(`INSERT INTO organizations (name, slug, timezone, country) VALUES ($1,$2,$3,$4) RETURNING id`, [p.orgName, slug, p.timezone ?? 'UTC', p.country ?? 'US'])).rows[0];
      const u = (await c.query(`INSERT INTO users (org_id, email, password_hash, first_name, last_name, role, timezone) VALUES ($1,$2,$3,$4,$5,'COMPANY_OWNER',$6) RETURNING *`,
        [org.id, p.email, hash, p.firstName, p.lastName ?? '', p.timezone ?? null])).rows[0];
      await c.query(`INSERT INTO extensions (org_id, number, user_id) VALUES ($1,'101',$2)`, [org.id, u.id]);
      await c.query(`INSERT INTO voicemail_boxes (org_id, user_id, name) VALUES ($1,$2,$3)`, [org.id, u.id, `${p.firstName}'s voicemail`]);
      await c.query(`INSERT INTO subscriptions (org_id, plan_id, status, trial_ends_at, current_period_end) VALUES ($1,'pro','trialing', now() + interval '14 days', now() + interval '14 days')`, [org.id]);
      return { ...u, extension: '101' };
    });
    await this.audit.log({ orgId: user.org_id, actorId: user.id, action: 'auth.signup', ip: meta.ip, userAgent: meta.ua });
    return this.issue(user, meta);
  }

  async login(p: { email: string; password: string; mfaCode?: string }, meta: { ip?: string; ua?: string }): Promise<TokenPair | { mfaRequired: true }> {
    const u = await this.db.one(`SELECT u.*, e.number extension FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user' WHERE u.email=$1 AND u.deleted_at IS NULL`, [p.email]);
    // constant-ish time: always run bcrypt
    const ok = await bcrypt.compare(p.password, u?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!u || !ok || u.status === 'suspended') {
      if (u) await this.audit.log({ orgId: u.org_id, actorId: u.id, action: 'auth.login_failed', ip: meta.ip, userAgent: meta.ua });
      throw new UnauthorizedException('Invalid email or password');
    }
    if (u.mfa_enabled) {
      if (!p.mfaCode) return { mfaRequired: true };
      if (!authenticator.verify({ token: p.mfaCode, secret: decrypt(u.mfa_secret) })) throw new UnauthorizedException('Invalid MFA code');
    }
    await this.db.query(`UPDATE users SET last_login_at=now(), status = CASE WHEN status='invited' THEN 'active' ELSE status END WHERE id=$1`, [u.id]);
    await this.audit.log({ orgId: u.org_id, actorId: u.id, action: 'auth.login', ip: meta.ip, userAgent: meta.ua });
    return this.issue(u, meta);
  }

  async issue(u: any, meta: { ip?: string; ua?: string; familyId?: string; deviceId?: string }): Promise<TokenPair> {
    const refreshToken = randomToken(48);
    const s = await this.db.one(
      `INSERT INTO sessions (user_id, refresh_token_hash, family_id, device_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval) RETURNING id`,
      [u.id, sha256(refreshToken), meta.familyId ?? randomUUID(), meta.deviceId ?? null, meta.ip ?? null, meta.ua ?? null, String(config().REFRESH_TOKEN_TTL_DAYS)]);
    return {
      accessToken: signAccessToken({ sub: u.id, org: u.org_id, role: u.role, sid: s.id }),
      refreshToken, expiresIn: config().ACCESS_TOKEN_TTL_SECONDS, user: this.toPublic(u),
    };
  }

  /** Refresh-token rotation with reuse detection: replaying a rotated token revokes the whole family. */
  async refresh(refreshToken: string, meta: { ip?: string; ua?: string }): Promise<TokenPair> {
    const s = await this.db.one(`SELECT * FROM sessions WHERE refresh_token_hash=$1`, [sha256(refreshToken)]);
    if (!s) throw new UnauthorizedException();
    if (s.revoked_at) {
      await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL`, [s.family_id]);
      const u = await this.db.one(`SELECT org_id FROM users WHERE id=$1`, [s.user_id]);
      await this.audit.log({ orgId: u?.org_id, actorId: s.user_id, action: 'auth.refresh_reuse_detected', ip: meta.ip, actorType: 'system' });
      throw new UnauthorizedException('Session revoked');
    }
    if (new Date(s.expires_at) < new Date()) throw new UnauthorizedException('Session expired');
    await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [s.id]);
    const u = await this.db.one(`SELECT u.*, e.number extension FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user' WHERE u.id=$1 AND u.deleted_at IS NULL AND u.status <> 'suspended'`, [s.user_id]);
    if (!u) throw new UnauthorizedException();
    return this.issue(u, { ...meta, familyId: s.family_id, deviceId: s.device_id });
  }

  async logout(sessionId: string | undefined) {
    if (sessionId) await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [sessionId]);
  }

  async me(userId: string) {
    const u = await this.db.one(`SELECT u.*, e.number extension FROM users u LEFT JOIN extensions e ON e.user_id=u.id AND e.kind='user' WHERE u.id=$1`, [userId]);
    if (!u) throw new UnauthorizedException();
    const org = await this.db.one(`SELECT o.id, o.name, o.timezone, o.country, o.currency, s.plan_id, s.status subscription_status FROM organizations o LEFT JOIN subscriptions s ON s.org_id=o.id WHERE o.id=$1`, [u.org_id]);
    return { ...this.toPublic(u), presence: u.presence, organization: org };
  }

  async mfaSetup(userId: string) {
    const u = await this.db.one(`SELECT email, mfa_enabled FROM users WHERE id=$1`, [userId]);
    if (u.mfa_enabled) throw new BadRequestException('MFA already enabled');
    const secret = authenticator.generateSecret();
    await this.db.query(`UPDATE users SET mfa_secret=$2 WHERE id=$1`, [userId, encrypt(secret)]);
    return { secret, otpauthUrl: authenticator.keyuri(u.email, 'CloudConnect AI', secret) };
  }
  async mfaEnable(userId: string, code: string) {
    const u = await this.db.one(`SELECT org_id, mfa_secret FROM users WHERE id=$1`, [userId]);
    if (!u?.mfa_secret || !authenticator.verify({ token: code, secret: decrypt(u.mfa_secret) })) throw new BadRequestException('Invalid code');
    await this.db.query(`UPDATE users SET mfa_enabled=true WHERE id=$1`, [userId]);
    await this.audit.log({ orgId: u.org_id, actorId: userId, action: 'auth.mfa_enabled' });
    return { enabled: true };
  }
  async mfaDisable(userId: string, code: string) {
    const u = await this.db.one(`SELECT org_id, mfa_secret, mfa_enabled FROM users WHERE id=$1`, [userId]);
    if (!u?.mfa_enabled || !authenticator.verify({ token: code, secret: decrypt(u.mfa_secret) })) throw new BadRequestException('Invalid code');
    await this.db.query(`UPDATE users SET mfa_enabled=false, mfa_secret=NULL WHERE id=$1`, [userId]);
    await this.audit.log({ orgId: u.org_id, actorId: userId, action: 'auth.mfa_disabled' });
    return { enabled: false };
  }

  sessions(userId: string) {
    return this.db.query(`SELECT id, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [userId]);
  }
  async revokeSession(userId: string, id: string) {
    await this.db.query(`UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2`, [id, userId]);
  }

  // ───────────── OAuth / OIDC (Google, Microsoft, Apple) ─────────────
  private clientFor(p: OAuthProvider) {
    const c = config();
    const id = { google: c.GOOGLE_CLIENT_ID, microsoft: c.MICROSOFT_CLIENT_ID, apple: c.APPLE_CLIENT_ID }[p];
    const secret = { google: c.GOOGLE_CLIENT_SECRET, microsoft: c.MICROSOFT_CLIENT_SECRET, apple: c.APPLE_CLIENT_SECRET }[p];
    if (!id || !secret) throw new BadRequestException(`${p} login is not configured`);
    return { id, secret, redirect: `${c.PUBLIC_URL}/v1/auth/oauth/${p}/callback` };
  }

  oauthStart(p: OAuthProvider) {
    const cl = this.clientFor(p);
    const state = jwt.sign({ p, n: randomToken(12) }, config().JWT_SECRET, { expiresIn: 600 });
    const q = new URLSearchParams({ client_id: cl.id, redirect_uri: cl.redirect, response_type: 'code', scope: 'openid email profile', state, ...(p === 'apple' ? { response_mode: 'form_post', scope: 'name email' } : {}) });
    return { url: `${OAUTH_PROVIDERS[p].auth}?${q}` };
  }

  async oauthCallback(p: OAuthProvider, code: string, state: string, meta: { ip?: string; ua?: string }): Promise<TokenPair> {
    try { if ((jwt.verify(state, config().JWT_SECRET) as any).p !== p) throw new Error(); } catch { throw new UnauthorizedException('Invalid OAuth state'); }
    const cl = this.clientFor(p);
    const res = await fetch(OAUTH_PROVIDERS[p].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: cl.id, client_secret: cl.secret, redirect_uri: cl.redirect }) });
    if (!res.ok) throw new UnauthorizedException('OAuth code exchange failed');
    const { id_token } = (await res.json()) as { id_token: string };
    const claims = await this.verifyIdToken(p, id_token, cl.id);
    if (!claims.email || claims.email_verified === false || claims.email_verified === 'false') throw new UnauthorizedException('Verified email required');
    let u = await this.db.one(`SELECT u.* FROM oauth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.deleted_at IS NULL`, [p, claims.sub]);
    if (!u) {
      // Link to an existing invited/active account with the same verified email; self-service signup otherwise happens via /signup.
      u = await this.db.one(`SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL`, [claims.email]);
      if (!u) throw new UnauthorizedException('No CloudConnect account for this email. Ask your admin for an invite or sign up first.');
      await this.db.query(`INSERT INTO oauth_identities (user_id, provider, subject) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, p, claims.sub]);
    }
    await this.audit.log({ orgId: u.org_id, actorId: u.id, action: `auth.login_${p}`, ip: meta.ip, userAgent: meta.ua });
    return this.issue(u, meta);
  }

  private jwksCache = new Map<string, { at: number; keys: any[] }>();
  private async verifyIdToken(p: OAuthProvider, idToken: string, audience: string): Promise<any> {
    const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString());
    const url = OAUTH_PROVIDERS[p].jwks;
    let cached = this.jwksCache.get(url);
    if (!cached || Date.now() - cached.at > 3600_000) {
      cached = { at: Date.now(), keys: ((await (await fetch(url)).json()) as any).keys };
      this.jwksCache.set(url, cached);
    }
    const jwk = cached.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new UnauthorizedException('Unknown signing key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const claims: any = jwt.verify(idToken, key, { algorithms: ['RS256'], audience });
    const iss = OAUTH_PROVIDERS[p].iss;
    if (iss && !(iss as readonly string[]).includes(claims.iss)) throw new UnauthorizedException('Bad issuer');
    if (p === 'microsoft' && !/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0$/.test(claims.iss)) throw new UnauthorizedException('Bad issuer');
    return claims;
  }

  // ───────────── API keys ─────────────
  async createApiKey(orgId: string, userId: string, name: string, scopes: string[]) {
    const raw = `cc_live_${randomToken(32)}`;
    const k = await this.db.one(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, prefix, scopes, created_at`,
      [orgId, name, raw.slice(0, 14), sha256(raw), scopes, userId]);
    return { ...k, key: raw }; // shown once
  }
  listApiKeys(orgId: string) { return this.db.query(`SELECT id, name, prefix, scopes, last_used_at, created_at FROM api_keys WHERE org_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, [orgId]); }
  async revokeApiKey(orgId: string, id: string) { await this.db.query(`UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND org_id=$2`, [id, orgId]); }
}
