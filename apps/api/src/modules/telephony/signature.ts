import { createHmac, createPublicKey, verify } from 'crypto';
import { safeEqual } from '../../common/crypto';

/** Twilio / SignalWire: base64(HMAC-SHA1(authToken, url + concat(sorted(key+value)))) */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}
export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  return !!header && safeEqual(twilioSignature(authToken, url, params), header);
}

/** Telnyx: ed25519 signature over `${timestamp}|${rawBody}`; rejects stale (>5 min) timestamps. */
export function verifyTelnyx(publicKeyB64: string, rawBody: string, signatureB64: string | undefined, timestamp: string | undefined, now = Date.now()): boolean {
  if (!signatureB64 || !timestamp) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signatureB64, 'base64'));
}
