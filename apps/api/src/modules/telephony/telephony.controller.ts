import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth';
import { z$ } from '../../common/validation';
import { config } from '../../config';
import { verifyTelnyx, verifyTwilio } from './signature';
import { normalizeParams, TelephonyService } from './telephony.service';

const PROVIDERS = ['mock', 'twilio', 'telnyx', 'signalwire', 'plivo', 'vonage'];

/** Verifies the carrier's webhook signature (Twilio/SignalWire HMAC-SHA1, Telnyx ed25519). */
export function verifyWebhook(provider: string, req: Request) {
  if (!PROVIDERS.includes(provider)) throw new ForbiddenException('Unknown provider');
  const c = config();
  if (!c.TELEPHONY_VERIFY_SIGNATURES) return;
  if (provider === 'mock' && c.NODE_ENV !== 'production') return;
  const url = `${c.PUBLIC_URL}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  let ok = false;
  if (provider === 'twilio') ok = !!c.TWILIO_AUTH_TOKEN && verifyTwilio(c.TWILIO_AUTH_TOKEN, url, params, req.header('x-twilio-signature'));
  else if (provider === 'signalwire') ok = !!c.SIGNALWIRE_TOKEN && verifyTwilio(c.SIGNALWIRE_TOKEN, url, params, req.header('x-signalwire-signature') ?? req.header('x-twilio-signature'));
  else if (provider === 'telnyx') ok = !!c.TELNYX_PUBLIC_KEY && verifyTelnyx(c.TELNYX_PUBLIC_KEY, (req as any).rawBody?.toString() ?? '', req.header('telnyx-signature-ed25519'), req.header('telnyx-timestamp'));
  // plivo (X-Plivo-Signature-V3) and vonage (signed JWT) verification follow the same pattern.
  if (!ok) throw new ForbiddenException('Invalid webhook signature');
}



/** Carrier webhooks. All endpoints verify the carrier signature before doing any work. */
@ApiExcludeController()
@Public() @SkipThrottle()
@Controller('v1/telephony/:provider')
export class TelephonyWebhookController {
  constructor(private svc: TelephonyService) {}

  private verify(provider: string, req: Request) { verifyWebhook(provider, req); }

  private send(res: Response, out: { contentType: string; body: string } | string) {
    const r = typeof out === 'string' ? { contentType: 'text/xml', body: out } : out;
    res.type(r.contentType).send(r.body);
  }

  @HttpCode(200) @Post('voice')
  async voice(@Param('provider') p: string, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    const params = normalizeParams(p, req.body);
    // Softphone-originated calls arrive on the same TwiML App URL with From=client:<userId>
    if (params.identity) return this.send(res, await this.svc.clientOutbound(p, params));
    this.send(res, await this.svc.inbound(p, params));
  }

  @HttpCode(200) @Post('voice/continue')
  async cont(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    this.send(res, await this.svc.continue(p, q, normalizeParams(p, req.body)));
  }

  @HttpCode(204) @Post('status')
  async status(@Param('provider') p: string, @Req() req: Request) {
    this.verify(p, req);
    const b = req.body ?? {};
    await this.svc.status(p, { ...normalizeParams(p, b), mos: b.Mos ? Number(b.Mos) : undefined, jitter: b.Jitter ? Number(b.Jitter) : undefined, loss: b.PacketLoss ? Number(b.PacketLoss) : undefined });
  }

  @HttpCode(204) @Post('recording')
  async recording(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request) {
    this.verify(p, req);
    await this.svc.recording(p, q, normalizeParams(p, req.body));
  }

  @HttpCode(200) @Post('voicemail')
  async voicemail(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    this.send(res, await this.svc.voicemail(p, q, normalizeParams(p, req.body)));
  }

  @HttpCode(204) @Post('transcription')
  async transcription(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request) {
    this.verify(p, req);
    await this.svc.transcription(q, normalizeParams(p, req.body));
  }

  @HttpCode(200) @Post('ai')
  async ai(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    this.send(res, await this.svc.aiTurn(p, q, normalizeParams(p, req.body)));
  }

  @HttpCode(200) @Post('bridge')
  async bridge(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    this.send(res, await this.svc.bridge(q));
  }

  @HttpCode(200) @Post('conference')
  conference(@Param('provider') p: string, @Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    this.verify(p, req);
    this.send(res, this.svc.conferenceTwiml(q));
  }
}

const Dial = z.object({ to: z.string().min(2).max(32), from: z.string().optional(), ringDevice: z.string().optional(), record: z.boolean().optional() });
const Control = z.object({ to: z.string().optional(), orbit: z.string().regex(/^\d{1,4}$/).optional() });

@ApiTags('calls')
@Controller('v1')
export class CallControlController {
  constructor(private svc: TelephonyService) {}

  @RequirePermissions('calls:make') @Post('calls')
  dial(@CurrentUser() u: AuthUser, @Body(z$(Dial)) b: z.infer<typeof Dial>) { return this.svc.outbound(u, b); }

  @RequirePermissions('calls:make') @HttpCode(200) @Post('calls/:id/:action')
  control(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('action') action: string, @Body(z$(Control)) b: z.infer<typeof Control>) {
    return this.svc.control(u, id, action, b);
  }

  @RequirePermissions('calls:make') @HttpCode(200) @Post('park/:orbit/pickup')
  pickup(@CurrentUser() u: AuthUser, @Param('orbit') orbit: string) { return this.svc.pickup(u, orbit); }

  /** WebRTC client token for the softphone (web, desktop, mobile). */
  @RequirePermissions('calls:make') @Get('telephony/token')
  async token(@CurrentUser() u: AuthUser) {
    return { provider: this.svc.provider.name, identity: u.userId, ...(await this.svc.provider.clientToken(u.userId!)) };
  }
}
