'use client';
/**
 * Softphone engine. With a WebRTC-capable carrier (Twilio Voice JS SDK / Telnyx WebRTC) the
 * browser registers as `client:<userId>` using a short-lived token from /v1/telephony/token and
 * media flows over DTLS-SRTP with Opus (HD voice), browser AEC/NS/AGC enabled.
 * In "mock" mode the call is placed via click-to-call and media is simulated.
 */
import { api } from './api';

export type CallState = 'idle' | 'connecting' | 'ringing' | 'in_call' | 'on_hold' | 'ended';
export interface ActiveCall { callId: string; to: string; callerId?: string; state: CallState; startedAt?: number; muted: boolean; recording: boolean }

export const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 },
};

export async function placeCall(to: string, from?: string): Promise<ActiveCall> {
  const r = await api<{ callId: string; callerId?: string; dial?: string }>('/v1/calls', { body: { to, from } });
  return { callId: r.callId, to, callerId: r.callerId, state: 'ringing', muted: false, recording: false };
}

export async function control(callId: string, action: string, body: Record<string, unknown> = {}) {
  return api(`/v1/calls/${callId}/${action}`, { body });
}

/** Microphone pre-flight: requests permission with HD voice constraints and returns an input level meter. */
export async function micCheck(onLevel: (v: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const tick = () => { analyser.getByteFrequencyData(buf); onLevel(buf.reduce((a, b) => a + b, 0) / buf.length / 128); raf = requestAnimationFrame(tick); };
  tick();
  return () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
}
