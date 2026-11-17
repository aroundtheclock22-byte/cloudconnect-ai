import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, OAuthProvider, OAUTH_PROVIDERS, TokenPair } from './auth.service';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth';
import { z$ } from '../../common/validation';
import { config } from '../../config';

const Signup = z.object({ orgName: z.string().min(2).max(100), email: z.string().email().toLowerCase(), password: z.string().max(200), firstName: z.string().min(1).max(60), lastName: z.string().max(60).optional(), timezone: z.string().optional(), country: z.string().length(2).optional() });
const Login = z.object({ email: z.string().email().toLowerCase(), password: z.string().max(200), mfaCode: z.string().regex(/^\d{6}$/).optional() });
const Code = z.object({ code: z.string().regex(/^\d{6}$/) });
const ApiKey = z.object({ name: z.string().min(1).max(80), scopes: z.array(z.string()).default([]) });

const COOKIE = 'cc_refresh';
const OAUTH_COOKIE = 'cc_oauth';
const meta = (req: Request) => ({ ip: req.ip, ua: req.headers['user-agent'] });

function setRefreshCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: config().NODE_ENV === 'production', sameSite: 'strict', path: '/v1/auth', maxAge: config().REFRESH_TOKEN_TTL_DAYS * 86400_000 });
}
/** Web clients get the refresh token as an httpOnly cookie; native apps read it from the body and store it in Keychain/Keystore. */
function respond(res: Response, pair: TokenPair) {
  setRefreshCookie(res, pair.refreshToken);
  return pair;
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Throttle({ default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 5), ttl: 60_000 } })
  @Post('signup')
  async signup(@Body(z$(Signup)) body: z.infer<typeof Signup>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return respond(res, await this.auth.signup(body, meta(req)));
  }

  @Public() @Throttle({ default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } }) @HttpCode(200)
  @Post('login')
  async login(@Body(z$(Login)) body: z.infer<typeof Login>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body, meta(req));
    return 'mfaRequired' in r ? r : respond(res, r);
  }

  @Public() @HttpCode(200)
  @Post('refresh')
  async refresh(@Body() body: { refreshToken?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = body?.refreshToken ?? req.cookies?.[COOKIE];
    return respond(res, await this.auth.refresh(String(token ?? ''), meta(req)));
  }

  @HttpCode(204) @Post('logout')
  async logout(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(u.sessionId);
    res.clearCookie(COOKIE, { path: '/v1/auth' });
  }

  @Get('me') me(@CurrentUser() u: AuthUser) { return this.auth.me(u.userId!); }

  @Post('mfa/setup') mfaSetup(@CurrentUser() u: AuthUser) { return this.auth.mfaSetup(u.userId!); }
  @HttpCode(200) @Post('mfa/enable') mfaEnable(@CurrentUser() u: AuthUser, @Body(z$(Code)) b: { code: string }) { return this.auth.mfaEnable(u.userId!, b.code); }
  @HttpCode(200) @Post('mfa/disable') mfaDisable(@CurrentUser() u: AuthUser, @Body(z$(Code)) b: { code: string }) { return this.auth.mfaDisable(u.userId!, b.code); }

  @Get('sessions') sessions(@CurrentUser() u: AuthUser) { return this.auth.sessions(u.userId!); }
  @HttpCode(204) @Delete('sessions/:id') revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.auth.revokeSession(u.userId!, id); }

  /** Which social logins are configured, so the login page only shows working buttons. */
  @Public() @Get('oauth-providers')
  oauthProviders() { return { providers: this.auth.oauthProviders() }; }

  @Public() @Get('oauth/:provider')
  oauthStart(@Param('provider') p: string, @Res({ passthrough: true }) res: Response) {
    if (!(p in OAUTH_PROVIDERS)) throw new BadRequestException('Unsupported sign-in provider');
    const { url, nonce } = this.auth.oauthStart(p as OAuthProvider);
    // Binds the sign-in to this browser. SameSite=None so Apple's cross-site form_post still carries it.
    res.cookie(OAUTH_COOKIE, nonce, { httpOnly: true, secure: config().NODE_ENV === 'production', sameSite: config().NODE_ENV === 'production' ? 'none' : 'lax', path: '/v1/auth/oauth', maxAge: 10 * 60_000 });
    return { url };
  }

  /** Google/Microsoft return via GET, Apple via form_post. Success → web app with session cookie; failure → login page with a message. */
  @Public() @Get('oauth/:provider/callback')
  async oauthCallbackGet(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    return this.finishOAuth(p, q, req, res);
  }
  @Public() @Post('oauth/:provider/callback')
  oauthCallbackPost(@Param('provider') p: string, @Body() b: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    return this.finishOAuth(p, b ?? {}, req, res);
  }

  private async finishOAuth(p: string, params: Record<string, string>, req: Request, res: Response) {
    const web = config().WEB_URL.replace(/\/$/, '');
    res.clearCookie(OAUTH_COOKIE, { path: '/v1/auth/oauth' });
    try {
      if (!(p in OAUTH_PROVIDERS)) throw new BadRequestException('Unsupported sign-in provider');
      if (params.error) throw new UnauthorizedException(params.error === 'access_denied' || params.error === 'user_cancelled_authorize' ? 'Sign-in was cancelled.' : 'The provider reported an error during sign-in.');
      const pair = await this.auth.oauthCallback(p as OAuthProvider, params.code, params.state, req.cookies?.[OAUTH_COOKIE], meta(req));
      setRefreshCookie(res, pair.refreshToken);
      res.redirect(`${web}/auth/callback`);
    } catch (e) {
      const msg = e instanceof HttpException ? String((e.getResponse() as any)?.message ?? e.message) : 'Sign-in failed. Please try again.';
      res.redirect(`${web}/login?error=${encodeURIComponent(msg)}`);
    }
  }

  @RequirePermissions('apikeys:manage') @Get('api-keys') listKeys(@CurrentUser() u: AuthUser) { return this.auth.listApiKeys(u.orgId); }
  @RequirePermissions('apikeys:manage') @Post('api-keys') createKey(@CurrentUser() u: AuthUser, @Body(z$(ApiKey)) b: z.infer<typeof ApiKey>) { return this.auth.createApiKey(u.orgId, u.userId!, b.name, b.scopes); }
  @RequirePermissions('apikeys:manage') @HttpCode(204) @Delete('api-keys/:id') revokeKey(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.auth.revokeApiKey(u.orgId, id); }
}
