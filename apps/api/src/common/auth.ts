import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { hasPermission, Permission, Role } from '@cloudconnect/shared';
import { config } from '../config';
import { Db } from './db.service';
import { sha256 } from './crypto';

export interface AuthUser { userId: string | null; orgId: string; role: Role; sessionId?: string; apiKeyId?: string; scopes?: string[] }
export interface AccessClaims { sub: string; org: string; role: Role; sid: string }

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const PERMS = 'permissions';
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMS, p);
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign(c, config().JWT_SECRET, { algorithm: 'HS256', expiresIn: config().ACCESS_TOKEN_TTL_SECONDS, issuer: 'cloudconnect', audience: 'cloudconnect-api' });
}
export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config().JWT_SECRET, { algorithms: ['HS256'], issuer: 'cloudconnect', audience: 'cloudconnect-api' }) as AccessClaims;
}

/** Resolves a bearer JWT or API key (cc_live_...) into req.user. */
export async function authenticate(db: Db, header: string | undefined): Promise<AuthUser | null> {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (token.startsWith('cc_')) {
    const key = await db.one(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id, org_id, scopes`, [sha256(token)]);
    if (!key) return null;
    return { userId: null, orgId: key.org_id, role: 'ADMINISTRATOR', apiKeyId: key.id, scopes: key.scopes };
  }
  try {
    const c = verifyAccessToken(token);
    return { userId: c.sub, orgId: c.org, role: c.role, sessionId: c.sid };
  } catch {
    return null;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest();
    const user = await authenticate(this.db, req.headers.authorization);
    if (user) req.user = user;
    if (isPublic) return true;
    if (!user) throw new UnauthorizedException();
    const perms = this.reflector.getAllAndOverride<Permission[]>(PERMS, [ctx.getHandler(), ctx.getClass()]) ?? [];
    for (const p of perms) {
      if (!hasPermission(user.role, p)) throw new ForbiddenException(`Missing permission ${p}`);
      if (user.apiKeyId && user.scopes?.length && !user.scopes.some((s) => s === p || (s.endsWith(':*') && p.startsWith(s.slice(0, -1))))) {
        throw new ForbiddenException(`API key lacks scope ${p}`);
      }
    }
    return true;
  }
}

export function can(user: AuthUser, p: Permission) { return hasPermission(user.role, p); }
