# CloudConnect desktop (Windows · macOS · Linux)

Electron shell around the web portal with native integrations: notifications, tray presence menu,
`tel:`/`callto:`/`sip:`/`cloudconnect:` click-to-call handlers, global hotkeys (⌘/Ctrl+Shift+A/H/M),
system screen-share picker, badge counts and auto-update. The renderer is sandboxed with context
isolation; only the CloudConnect origin can load in the window or receive mic/camera permission.

```bash
cd apps/desktop && npm install
CLOUDCONNECT_URL=http://localhost:3000 npm start
npm run dist:all      # dmg/zip, nsis/msi, AppImage/deb/rpm (sign with CSC_LINK / WIN_CSC_LINK)
```
The web app detects `window.cloudconnectDesktop` to route incoming-call toasts to native notifications.
