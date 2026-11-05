/** Minimal stroke icon set (24×24, 1.75 stroke), lucide-style geometry. */
const P: Record<string, string> = {
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  calls: 'M3 6h18M3 12h18M3 18h12',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  voicemail: 'M6 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM18 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM6 15.5h12',
  contacts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  video: 'm22 8-6 4 6 4V8zM2 6h14v12H2z',
  chart: 'M3 3v18h18M7 16V9M12 16V5M17 16v-4',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  flow: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  card: 'M2 5h20v14H2zM2 10h20',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
  sparkles: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM19 3v4M21 5h-4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6M17 16.9A7 7 0 0 1 5 12v-2m14 0v2c0 .8-.1 1.5-.4 2.2M12 19v3',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  transfer: 'M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3',
  record: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  hangup: 'M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8M22 2 2 22',
  incoming: 'M16 2v6h6M22 2l-6 6',
  outgoing: 'M22 8V2h-6M16 8l6-6',
  missed: 'M22 2l-6 6M16 2l6 6',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z',
  check: 'M20 6 9 17l-5-5',
  keypad: 'M5 4h2v2H5zM11 4h2v2h-2zM17 4h2v2h-2zM5 10h2v2H5zM11 10h2v2h-2zM17 10h2v2h-2zM5 16h2v2H5zM11 16h2v2h-2zM17 16h2v2h-2z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  play: 'M6 3l14 9-14 9z',
  menu: 'M3 6h18M3 12h18M3 18h18',
};
export function Icon({ name, className = 'h-5 w-5' }: { name: keyof typeof P | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={P[name] ?? P.dashboard} />
    </svg>
  );
}
