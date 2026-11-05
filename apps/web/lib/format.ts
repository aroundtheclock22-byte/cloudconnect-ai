export const fmtDuration = (s: number) => { const m = Math.floor(s / 60); const sec = s % 60; return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(sec).padStart(2, '0')}`; };
export const fmtPhone = (e: string) => {
  if (!e) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e.startsWith('client:') ? 'Internal' : e;
};
export const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtRelative = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
export const fmtMoney = (cents: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
export const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
