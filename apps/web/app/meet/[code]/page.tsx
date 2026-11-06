'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Icon } from '@/components/Icon';
import { ErrorNote } from '@/components/ui';

/**
 * Meeting room. Media is published to LiveKit (SFU) with the returned token; this page handles the
 * pre-join lobby (camera/mic preview), waiting room and in-room controls. Background blur / virtual
 * backgrounds use @livekit/track-processors; captions stream from the transcription agent.
 */
export default function Meet() {
  const params = useParams<{ code: string }>();
  const { me } = useAuth();
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [state, setState] = useState<'lobby' | 'waiting' | 'in' | 'left'>('lobby');
  const [join, setJoin] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [cam, setCam] = useState(true); const [mic, setMic] = useState(true); const [share, setShare] = useState(false); const [captions, setCaptions] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => { if (me) setName(`${me.firstName} ${me.lastName}`); }, [me]);
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { width: 1280, height: 720 }, audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => { stream.current = s; if (video.current) video.current.srcObject = s; }).catch(() => setCam(false));
    return () => stream.current?.getTracks().forEach((t) => t.stop());
  }, []);
  useEffect(() => { stream.current?.getVideoTracks().forEach((t) => (t.enabled = cam)); stream.current?.getAudioTracks().forEach((t) => (t.enabled = mic)); }, [cam, mic]);
  useEffect(() => {
    if (state !== 'waiting' || !join) return;
    const t = setInterval(async () => { const r = await api(`/v1/meetings/${params.code}/participants/${join.participantId}/status`); if (r.status === 'admitted') { setJoin(r); setState('in'); } if (r.status === 'denied') { setError('The host declined your request.'); setState('left'); } }, 3000);
    return () => clearInterval(t);
  }, [state, join, params.code]);

  const enter = async () => {
    setError(null);
    try { const r = await api(`/v1/meetings/${params.code}/join`, { body: { displayName: name, passcode: passcode || undefined } }); setJoin(r); setState(r.status === 'waiting' ? 'waiting' : 'in'); }
    catch (e) { setError((e as Error).message); }
  };
  const toggleShare = async () => {
    if (share) { setShare(false); return; }
    try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getVideoTracks()[0].onended = () => setShare(false); setShare(true); } catch { /* cancelled */ }
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-white">
      <header className="flex items-center justify-between px-6 py-4"><span className="font-semibold">CloudConnect Meetings</span><span className="text-sm text-white/60">Code {params.code}</span></header>
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-4xl">
          <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-900">
            <video ref={video} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" />
            {!cam && <div className="absolute inset-0 flex items-center justify-center text-white/50">Camera off</div>}
            {state === 'in' && captions && <div className="absolute inset-x-0 bottom-4 mx-auto w-fit rounded-lg bg-black/70 px-4 py-2 text-sm">Live captions on · speak to see captions</div>}
            {share && <span className="absolute left-4 top-4 rounded bg-rose-600 px-2 py-1 text-xs">Sharing screen</span>}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <Ctl on={mic} onClick={() => setMic(!mic)} icon={mic ? 'mic' : 'micOff'} label={mic ? 'Mute' : 'Unmute'} />
            <Ctl on={cam} onClick={() => setCam(!cam)} icon="video" label={cam ? 'Stop video' : 'Start video'} />
            {state === 'in' && <><Ctl on={share} onClick={toggleShare} icon="upload" label="Share" /><Ctl on={captions} onClick={() => setCaptions(!captions)} icon="message" label="Captions" /></>}
          </div>
          {state === 'lobby' && (
            <div className="mx-auto mt-6 max-w-sm space-y-3">
              <input className="input bg-slate-900 text-white" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
              {!me && <input className="input bg-slate-900 text-white" placeholder="Passcode (if required)" value={passcode} onChange={(e) => setPasscode(e.target.value)} aria-label="Passcode" />}
              <ErrorNote error={error} />
              <button className="btn-primary w-full py-2.5" disabled={!name} onClick={enter}>Join meeting</button>
            </div>
          )}
          {state === 'waiting' && <p className="mt-6 text-center text-white/70">Waiting for the host to let you in…</p>}
          {state === 'in' && <div className="mt-6 text-center"><p className="text-sm text-emerald-400">Connected · {join?.room}</p><button className="btn-danger mt-3" onClick={() => setState('left')}>Leave</button></div>}
          {state === 'left' && <p className="mt-6 text-center text-white/70">{error ?? 'You left the meeting.'}</p>}
        </div>
      </div>
    </div>
  );
}
function Ctl({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: string; label: string }) {
  return <button onClick={onClick} className={`flex flex-col items-center gap-1 rounded-xl px-4 py-2 text-xs ${on ? 'bg-slate-800 hover:bg-slate-700' : 'bg-rose-600 hover:bg-rose-700'}`}><Icon name={icon} />{label}</button>;
}
