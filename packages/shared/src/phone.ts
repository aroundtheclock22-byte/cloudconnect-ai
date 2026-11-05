/** Minimal E.164 helpers. Production deployments should additionally use libphonenumber. */
export function normalizeE164(input: string, defaultCountryCode = '1'): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  let e164: string;
  if (trimmed.startsWith('+')) e164 = '+' + digits;
  else if (trimmed.startsWith('00')) e164 = '+' + digits.slice(2);
  else if (defaultCountryCode === '1' && digits.length === 10) e164 = '+1' + digits;
  else if (defaultCountryCode === '1' && digits.length === 11 && digits.startsWith('1')) e164 = '+' + digits;
  else e164 = '+' + defaultCountryCode + digits;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

const TOLL_FREE_NANP = ['800', '833', '844', '855', '866', '877', '888'];
export function isTollFree(e164: string): boolean {
  return e164.startsWith('+1') && TOLL_FREE_NANP.includes(e164.slice(2, 5));
}

/** Map a vanity string like 1-800-FLOWERS to digits. */
export function vanityToDigits(vanity: string): string {
  const map: Record<string, string> = {
    A: '2', B: '2', C: '2', D: '3', E: '3', F: '3', G: '4', H: '4', I: '4', J: '5', K: '5', L: '5',
    M: '6', N: '6', O: '6', P: '7', Q: '7', R: '7', S: '7', T: '8', U: '8', V: '8', W: '9', X: '9', Y: '9', Z: '9',
  };
  return vanity.toUpperCase().replace(/[A-Z]/g, (c) => map[c]).replace(/[^\d+]/g, '');
}

/** Very small country-prefix table used for rating & caller-ID selection (longest prefix wins). */
export const COUNTRY_PREFIXES: Record<string, string> = {
  '1': 'US', '44': 'GB', '33': 'FR', '49': 'DE', '34': 'ES', '39': 'IT', '61': 'AU', '81': 'JP',
  '91': 'IN', '52': 'MX', '55': 'BR', '86': 'CN', '27': 'ZA', '234': 'NG', '971': 'AE', '65': 'SG',
  '353': 'IE', '31': 'NL', '46': 'SE', '64': 'NZ', '63': 'PH', '82': 'KR',
};
export function countryOf(e164: string): string | null {
  const d = e164.replace('+', '');
  for (let len = 3; len >= 1; len--) {
    const c = COUNTRY_PREFIXES[d.slice(0, len)];
    if (c) return c;
  }
  return null;
}
