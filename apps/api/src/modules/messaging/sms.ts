/** GSM-7 vs UCS-2 segment calculation for SMS billing. */
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
export function smsSegments(body: string): { encoding: 'GSM-7' | 'UCS-2'; segments: number; length: number } {
  const chars = [...body];
  const gsm = chars.every((c) => GSM7.includes(c) || GSM7_EXT.includes(c));
  if (gsm) {
    const len = chars.reduce((n, c) => n + (GSM7_EXT.includes(c) ? 2 : 1), 0);
    return { encoding: 'GSM-7', length: len, segments: len <= 160 ? 1 : Math.ceil(len / 153) };
  }
  const len = body.length; // UTF-16 code units
  return { encoding: 'UCS-2', length: len, segments: len <= 70 ? 1 : Math.ceil(len / 67) };
}

export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
export const START_WORDS = ['START', 'YES', 'UNSTOP'];
export const HELP_WORDS = ['HELP', 'INFO'];

export function renderTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => vars[k] ?? '');
}

/** Plain-English explanations for common carrier delivery errors (Twilio codes). */
const SMS_ERRORS: Record<string, string> = {
  '30034': 'Not delivered: this number is not registered for US business texting yet (A2P 10DLC). Texting starts working once the 10DLC campaign is approved.',
  '30032': 'Not delivered: this toll-free number is not verified for texting yet.',
  '30007': 'Blocked by the recipient\'s carrier as possible spam. Avoid link shorteners and add opt-out wording.',
  '30005': 'Not delivered: the destination number does not exist or is unreachable.',
  '30006': 'Not delivered: the destination is a landline or cannot receive texts.',
  '30003': 'Not delivered: the recipient\'s phone is off or unreachable.',
  '21610': 'Not sent: the recipient replied STOP and has opted out.',
  '30008': 'Not delivered: unknown carrier error. Try again later.',
};
export function smsErrorMessage(code?: string | null): string | null {
  if (!code) return null;
  return SMS_ERRORS[String(code)] ?? `Not delivered (carrier error ${code}).`;
}
