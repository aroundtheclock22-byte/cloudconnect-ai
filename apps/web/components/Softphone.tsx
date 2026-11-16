'use client';
import clsx from 'clsx';
import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ActiveCall, control, placeCall } from '@/lib/voice';
import { fmtDuration, fmtPhone } from '@/lib/format';
import { realtime } from '@/lib/realtime';
import { Call, Device, friendlyVoiceError, getVoiceDevice, resolveCallId } from '@/lib/twilioVoice';
import { micCheck } from '@/lib/voice';

const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void; dial: (n: string) => void }>(null as any);
export const useSoftphone = () => useContext(Ctx);

const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

export function SoftphoneProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [incoming, setIncoming] = useState<{ from: string; callId?: string; contact?: { first_name: string; last_name: string; company?: string }; spamScore?: number } | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [live, setLive] = useState(false);                    // true when real WebRTC calling is available
  const device = useRef<Device | null>(null);
  const sdkCall = useRef<Call | null>(null);                 // active real call
  const sdkIncoming = useRef<Call | null>(null);             // ringing real call

  // Real calling (Twilio Voice SDK) when the server's carrier supports WebRTC; otherwise simulated.
  useEffect(() => {
    let cancelled = false;
    getVoiceDevice().then((d) => {
      if (cancelled || !d) return;
      device.current = d; setLive(true);
      d.on('incoming', (c: Call) => {
        sdkIncoming.current = c;
        setIncoming((x) => x ?? { from: c.parameters.From ?? 'Unknown caller' });
        const clear = () => { if (sdkIncoming.current === c) { sdkIncoming.current = null; setIncoming(null); } };
        c.on('cancel', clear); c.on('disconnect', clear); c.on('reject', clear);
      });
    });
    return () => { cancelled = true; };
  }, []);

  /** Wire a real SDK call's lifecycle into the softphone UI. */
  const track = (c: Call, to: string, callId: string | null) => {
    sdkCall.current = c;
    setCall({ callId: callId ?? '', to, state: 'ringing', muted: false, recording: false });
    c.on('accept', async () => {
      setCall((x) => (x ? { ...x, state: 'in_call', startedAt: Date.now() } : x));
      if (!callId && c.parameters.CallSid) { const id = await resolveCallId(c.parameters.CallSid); if (id) setCall((x) => (x ? { ...x, callId: id } : x)); }
    });
    c.on('mute', (m: boolean) => setCall((x) => (x ? { ...x, muted: m } : x)));
    const end = () => { if (sdkCall.current === c) { sdkCall.current = null; setCall(null); setShowKeys(false); } };
    c.on('disconnect', end); c.on('cancel', end); c.on('reject', end);
    c.on('error', (e: any) => { setError(friendlyVoiceError(e)); end(); });
  };

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  // Desktop app: tel:/callto:/sip: links and tray "Dial…" route here.
  useEffect(() => { (window as any).cloudconnectDesktop?.onDial((n: string) => { setOpen(true); if (n) setNumber(n); }); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined); }, []);
  useEffect(() => {
    const s = realtime();
    if (!s) return;
    const desktop = (window as any).cloudconnectDesktop;
    const onRing = (e: any) => {
      setIncoming((x) => ({ ...e.data, from: e.data.from ?? x?.from }));
      const who = e.data.contact ? `${e.data.contact.first_name} ${e.data.contact.last_name}` : fmtPhone(e.data.from);
      if (desktop) desktop.notify('Incoming call', who, 'call');
      else if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Incoming call', { body: who });
    };
    const onDone = () => { if (!sdkIncoming.current) setIncoming(null); };
    s.on('call.ringing', onRing); s.on('call.answered', onDone); s.on('call.missed', onDone);
    return () => { s.off('call.ringing', onRing); s.off('call.answered', onDone); s.off('call.missed', onDone); };
  }, []);

  const dial = async (n: string) => {
    setOpen(true); setError(null); setNumber(n);
    if (!n) return;
    try {
      if (device.current) { track(await device.current.connect({ params: { To: n } }), n, null); return; }
      const c = await placeCall(n);
      setCall(c);
      // Mock carriers have no media; simulate answer so in-call controls can be exercised.
      setTimeout(() => setCall((x) => (x && x.callId === c.callId ? { ...x, state: 'in_call', startedAt: Date.now() } : x)), 1500);
    } catch (e) { setError(friendlyVoiceError(e)); }
  };

  // Microphone test: live input level + device name, so people can fix audio before a call.
  const [mic, setMic] = useState<{ level: number; label: string } | null>(null);
  const stopMic = useRef<(() => void) | null>(null);
  const testMic = async () => {
    if (stopMic.current) { stopMic.current(); stopMic.current = null; setMic(null); return; }
    setError(null);
    try {
      stopMic.current = await micCheck((level) => setMic((m) => ({ label: m?.label ?? '', level })));
      const devs = await navigator.mediaDevices.enumerateDevices();
      const label = devs.find((d) => d.kind === 'audioinput' && d.deviceId === 'default')?.label || devs.find((d) => d.kind === 'audioinput')?.label || 'Microphone';
      setMic({ level: 0, label });
      setTimeout(() => { stopMic.current?.(); stopMic.current = null; setMic(null); }, 15_000);
    } catch (e) { setError(friendlyVoiceError(e)); }
  };

  const act = async (action: string, patch: Partial<ActiveCall> = {}, body = {}) => {
    if (!call) return;
    if (!call.callId) { setError('Call is still connecting — try again in a moment.'); return; }
    try { await control(call.callId, action, body); setCall({ ...call, ...patch }); } catch (e) { setError((e as Error).message); }
  };
  const toggleMute = () => { if (!call) return; if (sdkCall.current) sdkCall.current.mute(!call.muted); else setCall({ ...call, muted: !call.muted }); };
  const hangup = async () => {
    if (sdkCall.current) { sdkCall.current.disconnect(); return; }
    await act('hangup', { state: 'ended' }).catch(() => undefined); setCall(null);
  };
  const answer = () => {
    const c = sdkIncoming.current;
    if (c) { sdkIncoming.current = null; setError(null); track(c, c.parameters.From ?? incoming?.from ?? '', incoming?.callId ?? null); c.accept(); setOpen(true); }
    setIncoming(null);
  };
  const decline = () => { sdkIncoming.current?.reject(); sdkIncoming.current = null; setIncoming(null); };

  return (
    <Ctx.Provider value={{ open, setOpen, dial }}>
      {children}
      {incoming && (
        <div className="fixed right-4 top-20 z-50 w-80 animate-[pulse_2s_ease-in-out_infinite] rounded-xl border border-emerald-200 bg-white p-4 shadow-xl dark:border-emerald-800 dark:bg-slate-900" role="alert">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Incoming call</p>
          <p className="mt-1 text-lg font-semibold">{incoming.contact ? `${incoming.contact.first_name} ${incoming.contact.last_name}` : fmtPhone(incoming.from)}</p>
          {incoming.contact?.company && <p className="text-sm text-slate-500">{incoming.contact.company}</p>}
          {(incoming.spamScore ?? 0) > 0.5 && <p className="mt-1 text-xs font-medium text-amber-600">⚠ Possible spam</p>}
          <div className="mt-3 flex gap-2"><button className="btn-primary flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={answer}>Answer</button><button className="btn-danger flex-1" onClick={decline}>Decline</button></div>
        </div>
      )}
      {open && (
        <aside className="fixed bottom-4 right-4 z-40 w-80 rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900" aria-label="Softphone">
          <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <span className="flex items-center gap-2 text-sm font-semibold"><Icon name="phone" className="h-4 w-4 text-brand-600" />Softphone<span className="rounded bg-emerald-50 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">HD</span>{!live && <span className="rounded bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" title="No WebRTC carrier configured — calls are simulated">Demo</span>}</span>
            <button className="btn-ghost p-1" onClick={() => setOpen(false)} aria-label="Close softphone"><Icon name="x" className="h-4 w-4" /></button>
          </header>
          {call && call.state !== 'ended' ? (
            <div className="p-5 text-center">
              <p className="text-xs uppercase tracking-wide text-slate-500">{call.state === 'ringing' ? 'Calling…' : call.state === 'on_hold' ? 'On hold' : 'Connected'}</p>
              <p className="mt-1 text-xl font-semibold">{fmtPhone(call.to)}</p>
              {call.callerId && <p className="text-xs text-slate-500">from {fmtPhone(call.callerId)}</p>}
              <p className="mt-2 font-mono text-2xl tabular-nums">{call.startedAt ? fmtDuration(Math.floor((now - call.startedAt) / 1000)) : '—'}</p>
              <div className="mt-5 grid grid-cols-3 gap-3">
                <CtlBtn icon={call.muted ? 'micOff' : 'mic'} label={call.muted ? 'Unmute' : 'Mute'} active={call.muted} onClick={toggleMute} />
                <CtlBtn icon="pause" label={call.state === 'on_hold' ? 'Resume' : 'Hold'} active={call.state === 'on_hold'} onClick={() => act(call.state === 'on_hold' ? 'unhold' : 'hold', { state: call.state === 'on_hold' ? 'in_call' : 'on_hold' })} />
                <CtlBtn icon="record" label={call.recording ? 'Pause rec' : 'Record'} active={call.recording} onClick={() => act(call.recording ? 'record_pause' : 'record_start', { recording: !call.recording })} />
              </div>
              <div className="mt-4 flex gap-2">
                <input className="input" placeholder="Transfer to ext or number" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} aria-label="Transfer target" />
                <button className="btn-outline px-2.5" title="Blind transfer" disabled={!transferTo} onClick={() => act('transfer', { state: 'ended' }, { to: transferTo })}><Icon name="transfer" className="h-4 w-4" /></button>
                <button className="btn-outline px-2 text-xs" title="Warm transfer" disabled={!transferTo} onClick={() => act('warm_transfer', {}, { to: transferTo })}>Warm</button>
              </div>
              <div className="mt-2 flex gap-2">
                <button className="btn-outline flex-1 text-xs" onClick={() => act('park', {}, {})}>Park</button>
                <button className="btn-outline flex-1 text-xs" disabled={!transferTo} onClick={() => act('conference', {}, { to: transferTo })}>Add to call</button>
              </div>
              {sdkCall.current && call.state === 'in_call' && (
                <div className="mt-3">
                  <button className="btn-ghost w-full text-xs" onClick={() => setShowKeys(!showKeys)}><Icon name="keypad" className="h-4 w-4" />{showKeys ? 'Hide keypad' : 'Keypad'}</button>
                  {showKeys && <div className="mt-2 grid grid-cols-3 gap-1">{KEYS.map(([k]) => <button key={k} className="rounded-lg bg-slate-50 py-1.5 text-sm hover:bg-slate-100 dark:bg-slate-800" onClick={() => sdkCall.current?.sendDigits(k)} aria-label={`Send ${k}`}>{k}</button>)}</div>}
                </div>
              )}
              {error && <p className="mt-3 text-center text-xs text-rose-600" role="alert">{error}</p>}
              <button className="btn-danger mt-5 w-full" onClick={hangup}><Icon name="hangup" className="h-4 w-4" />End call</button>
            </div>
          ) : (
            <div className="p-4">
              <input className="input text-center font-mono text-lg tracking-wider" placeholder="Enter number or ext" value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && dial(number)} aria-label="Number to dial" />
              <div className="mt-3 grid grid-cols-3 gap-2">
                {KEYS.map(([k, sub]) => (
                  <button key={k} className="rounded-xl bg-slate-50 py-2.5 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700" onClick={() => setNumber((n) => n + k)}>
                    <span className="block text-lg font-medium">{k}</span><span className="block h-3 text-[9px] tracking-widest text-slate-400">{sub}</span>
                  </button>
                ))}
              </div>
              {error && <p className="mt-3 text-center text-xs text-rose-600" role="alert">{error}</p>}
              {mic && (
                <div className="mt-3 rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800" aria-live="polite">
                  <p className="truncate text-slate-600 dark:text-slate-300">🎙 {mic.label} — speak now</p>
                  <div className="mt-1 h-2 rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-2 rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, Math.round(mic.level * 140))}%` }} /></div>
                  <p className="mt-1 text-slate-500">{mic.level > 0.05 ? 'Microphone is working ✓' : 'No sound yet — if the bar never moves, check the mic.'}</p>
                </div>
              )}
              <button className="btn-ghost mt-2 w-full text-xs" onClick={testMic}><Icon name="mic" className="h-4 w-4" />{mic ? 'Stop microphone test' : 'Test microphone'}</button>
              <button className="btn-primary mt-3 w-full bg-emerald-600 py-2.5 hover:bg-emerald-700" disabled={!number} onClick={() => dial(number)}><Icon name="phone" className="h-4 w-4" />Call</button>
            </div>
          )}
        </aside>
      )}
    </Ctx.Provider>
  );
}

function CtlBtn({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex flex-col items-center gap-1 rounded-xl py-2.5 text-xs', active ? 'bg-brand-600 text-white' : 'bg-slate-50 hover:bg-slate-100 dark:bg-slate-800')}>
      <Icon name={icon} className="h-5 w-5" />{label}
    </button>
  );
}
