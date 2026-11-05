/**
 * Desktop shell around the CloudConnect web app: native notifications, tray presence, click-to-call
 * protocol handlers (tel:, callto:, sip:, cloudconnect:), global answer/hang-up shortcuts, screen-share
 * picker for meetings, auto-update, and a locked-down renderer (contextIsolation, sandbox, no node).
 */
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';

const APP_URL = process.env.CLOUDCONNECT_URL ?? 'https://app.cloudconnect.ai';
const ORIGIN = new URL(APP_URL).origin;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let pendingDial: string | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
for (const p of ['cloudconnect', 'tel', 'callto', 'sip']) app.setAsDefaultProtocolClient(p);

function numberFromUrl(url: string): string | null {
  const m = /^(?:tel|callto|sip):\/?\/?([^?;@]+)/i.exec(url) ?? /^cloudconnect:\/\/call\/([^?]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]).replace(/[^\d+*#]/g, '') : null;
}
function dial(number: string | null) {
  if (!number) return;
  if (!win) { pendingDial = number; return; }
  win.show(); win.focus();
  win.webContents.send('cc:dial', number);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 380, minHeight: 600, title: 'CloudConnect', backgroundColor: '#f8fafc',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.loadURL(`${APP_URL}/dashboard`);
  // Only our origin may load in the app window; everything else opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (new URL(url).origin !== ORIGIN) shell.openExternal(url); else win?.loadURL(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => { if (process.platform !== 'linux' && !(app as any).quitting) { e.preventDefault(); win?.hide(); } });
  win.webContents.once('did-finish-load', () => { if (pendingDial) { dial(pendingDial); pendingDial = null; } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png')).resize({ width: 16, height: 16 }));
  const setPresence = (status: string) => win?.webContents.send('cc:presence', status);
  tray.setToolTip('CloudConnect');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CloudConnect', click: () => win?.show() },
    { label: 'Dial…', click: () => { win?.show(); win?.webContents.send('cc:dial', ''); } },
    { type: 'separator' },
    ...['available', 'busy', 'dnd', 'away'].map((s) => ({ label: `Set status: ${s}`, click: () => setPresence(s) })),
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as any).quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => win?.show());
}

app.whenReady().then(() => {
  // Grant mic/camera/screen only to our origin.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(new URL(wc.getURL()).origin === ORIGIN && ['media', 'notifications', 'clipboard-sanitized-write', 'display-capture'].includes(perm)));
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    cb({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
  }, { useSystemPicker: true });

  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+A', () => win?.webContents.send('cc:hotkey', 'answer'));
  globalShortcut.register('CommandOrControl+Shift+H', () => win?.webContents.send('cc:hotkey', 'hangup'));
  globalShortcut.register('CommandOrControl+Shift+M', () => win?.webContents.send('cc:hotkey', 'mute'));
  dial(numberFromUrl(process.argv.find((a) => /^(tel|callto|sip|cloudconnect):/i.test(a)) ?? ''));
  autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
});

app.on('second-instance', (_e, argv) => { win?.show(); dial(numberFromUrl(argv.find((a) => /^(tel|callto|sip|cloudconnect):/i.test(a)) ?? '')); });
app.on('open-url', (e, url) => { e.preventDefault(); dial(numberFromUrl(url)); }); // macOS
app.on('activate', () => win ? win.show() : createWindow());
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.handle('cc:notify', (_e, n: { title: string; body: string; kind?: 'call' | 'message' | 'voicemail' }) => {
  const notification = new Notification({ title: n.title, body: n.body, urgency: n.kind === 'call' ? 'critical' : 'normal', silent: n.kind !== 'call' });
  notification.on('click', () => win?.show());
  notification.show();
});
ipcMain.handle('cc:badge', (_e, count: number) => { app.setBadgeCount(count); tray?.setTitle(count ? String(count) : ''); });
