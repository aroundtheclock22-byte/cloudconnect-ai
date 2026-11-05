/** Minimal, typed bridge exposed to the web app as window.cloudconnectDesktop. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cloudconnectDesktop', {
  platform: process.platform,
  notify: (title: string, body: string, kind?: 'call' | 'message' | 'voicemail') => ipcRenderer.invoke('cc:notify', { title, body, kind }),
  setBadge: (count: number) => ipcRenderer.invoke('cc:badge', count),
  onDial: (cb: (number: string) => void) => ipcRenderer.on('cc:dial', (_e, n) => cb(n)),
  onHotkey: (cb: (action: 'answer' | 'hangup' | 'mute') => void) => ipcRenderer.on('cc:hotkey', (_e, a) => cb(a)),
  onPresence: (cb: (status: string) => void) => ipcRenderer.on('cc:presence', (_e, s) => cb(s)),
});
