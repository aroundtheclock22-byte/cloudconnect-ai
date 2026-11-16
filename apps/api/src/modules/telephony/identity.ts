/**
 * Twilio (and most WebRTC carriers) only accept letters, digits and underscores in browser
 * "client" names, so a user UUID can't be used directly. We use `u` + the UUID's 32 hex digits on
 * the wire and convert back when the carrier reports which client placed a call.
 * Names that aren't UUIDs (e.g. "park") pass through unchanged.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIRE = /^u([0-9a-f]{32})$/i;

export function toClientName(id: string): string {
  return UUID.test(id) ? `u${id.replace(/-/g, '').toLowerCase()}` : id;
}

export function fromClientName(name: string): string {
  const m = WIRE.exec(name);
  if (!m) return name;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normalizes a `client:<id>` dial target; other targets are returned as-is. */
export function toClientTarget(target: string): string {
  return target.startsWith('client:') ? `client:${toClientName(target.slice(7))}` : target;
}
