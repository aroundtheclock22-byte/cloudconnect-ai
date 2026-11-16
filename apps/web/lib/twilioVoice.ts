'use client';
/**
 * Real browser calling via the Twilio Voice JS SDK (WebRTC: Opus, DTLS-SRTP, browser AEC/NS/AGC).
 * The browser registers as `client:<userId>` with a short-lived AccessToken from /v1/telephony/token,
 * so ring groups and direct lines ring it, and outbound calls go through the TwiML App to our
 * /v1/telephony/twilio/voice webhook (caller-ID selection + fraud checks happen server-side).
 * Returns null when the server runs a non-WebRTC carrier (e.g. the mock carrier in staging/tests).
 */
import type { Call, Device } from '@twilio/voice-sdk';
import { api } from './api';

let devicePromise: Promise<Device | null> | null = null;

async function fetchToken(): Promise<{ provider: string; token: string } | null> {
  try { return await api('/v1/telephony/token'); } catch { return null; }
}

export function getVoiceDevice(): Promise<Device | null> {
  devicePromise ??= (async () => {
    const t = await fetchToken();
    if (!t || t.provider !== 'twilio') return null;
    const { Device } = await import('@twilio/voice-sdk');
    const device = new Device(t.token, {
      codecPreferences: ['opus', 'pcmu'] as any,
      closeProtection: 'A call is in progress. Leave anyway?',
      logLevel: 'warn',
    });
    device.on('tokenWillExpire', async () => { const n = await fetchToken(); if (n?.token) device.updateToken(n.token); });
    device.on('error', (e: any) => console.warn('voice device error', e?.code, e?.message));
    await device.register();
    return device;
  })().catch((e) => { console.warn('voice device unavailable', e); devicePromise = null; return null; });
  return devicePromise;
}

/** Our call id for a carrier CallSid (needed for hold/transfer/park/record on SDK calls). */
export async function resolveCallId(callSid: string, tries = 6): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try { return (await api<{ callId: string }>(`/v1/calls/by-provider/${encodeURIComponent(callSid)}`)).callId; }
    catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  return null;
}

/** Plain-English explanation for the Twilio/WebRTC errors people actually hit. */
export function friendlyVoiceError(e: any): string {
  const code = e?.code;
  if (code === 31401 || e?.name === 'NotAllowedError') return 'Microphone access is blocked. Click the lock icon in the address bar → allow Microphone, then try again.';
  if (code === 31402 || e?.name === 'NotReadableError' || e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError')
    return 'Your browser could not get audio from a microphone. Check that one is plugged in and not being used by another app (Zoom, Teams, another tab), then use "Test microphone" below.';
  if (code === 31208) return 'Your browser blocked the microphone for this call. Allow it and try again.';
  if (code === 31005 || code === 31009 || code === 53000) return 'Lost the connection to the phone network. Check your internet connection and try again.';
  if (code === 20101 || code === 20104 || code === 31204 || code === 31205) return 'The softphone session expired. Reload the page.';
  return e?.message ?? 'The call failed.';
}

export type { Call, Device };
