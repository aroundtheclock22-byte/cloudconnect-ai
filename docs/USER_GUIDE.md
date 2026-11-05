# CloudConnect AI — User & Admin Guide

## Getting started
1. **Sign up** at app.cloudconnect.ai → you become the *Company Owner*, get extension 101, a voicemail box and a 14-day Pro trial.
2. **Get a number**: *Admin → Phone numbers → Get a number* (local, toll-free, vanity word, international, or temporary), or *Port numbers* to bring existing ones.
3. **Invite your team**: *Admin → Users & teams → Invite user*; each user gets the next free extension.
4. **Set up call routing**: *Admin → Call routing & IVR* — start from a flow, then assign it to a number (*Phone numbers → Routing*).
5. Install the **desktop** and **mobile** apps and sign in.

## Everyday use
### Calls
* Click **Dial** (top right) to open the softphone; type a number or extension. Your caller ID is chosen automatically (your number, or a local number in the destination country).
* In a call: **Mute**, **Hold**, **Record / Pause recording**, **Transfer** (blind) or **Warm** transfer (talk first), **Park** (anyone picks up from the park orbit), **Add to call** (three-way/conference).
* **Calls** shows history; click any call for details, the routing path, the recording, and **AI insights** — summary, sentiment, action items, keywords, call score and coaching tips.
* Click-to-call works from contacts, voicemail, the directory, and (desktop) any `tel:` link.

### Voicemail
Visual voicemail lists messages with transcription and a one-line AI summary. Play, mark read/unread, call back, or delete. Each mailbox can send an SMS alert for new messages; email delivery is available once your administrator enables the email service.

### Messages
* **SMS**: one-to-one, group and MMS from your business number. ✨ suggests AI replies. Schedule messages, use templates, or broadcast to many recipients (opted-out recipients are skipped automatically).
* **Team chat**: direct and group chats with file attachments, typing indicators and read receipts.

### Contacts
Personal and shared contacts, company directory with live presence, favorites, tags, CSV import/export, duplicate detection & merge. CRM connections (Salesforce, HubSpot, Zoho) are configured under *Integrations*.

### Meetings
**Meet now** or **Schedule** (download the .ics invite for any calendar). Options: waiting room, passcode, webinar mode, auto-record, live captions. Hosts admit guests, create breakout rooms and get AI meeting notes when the meeting ends.

### Presence
Click your avatar to set Available, Busy, In a meeting, Away or Do not disturb. You're shown as available when you sign in and offline when you close all CloudConnect apps.

## Administrators
| Task | Where |
|---|---|
| Roles & permissions | *Users & teams* — Owner, Administrator, Billing admin, Manager, Supervisor, Agent, Receptionist, Employee, Read-only. Admins can't grant roles above their own. |
| Business hours, holidays, IVR, ring/hunt groups, AI receptionist | *Call routing & IVR* — visual editor or JSON; **Test call simulator** walks the exact production logic for any caller and time. |
| Supervisor tools | Monitor (listen), whisper (coach the agent), barge (join) on live calls — Manager/Supervisor roles. |
| Blocked numbers & spam | Block from call details or via API; spam-likely calls are flagged on the incoming-call toast; anonymous callers can be rejected per flow. |
| Billing | *Billing* — plan, seats, monthly/annual, coupon codes, invoice preview with usage, international rates, invoices, payment methods (Stripe). |
| Security | *Security & audit* — MFA (and org-wide MFA requirement), sessions, call-recording policy, fraud events, audit log. |
| Integrations & API | *Integrations & API* — connect apps, create API keys, add webhooks. Developers: see `docs/API.md`. |
| Analytics | *Analytics* — call volume, answer rate, durations, busiest hours, queue performance, geography, SMS usage, user activity, AI keywords & coaching trends. |

## Mobile & desktop extras
* **iOS**: calls ring on the lock screen (CallKit), appear in Recents, work in **CarPlay**, "Hey Siri, call Olivia with CloudConnect", Home-screen **widget**, **Apple Watch** recents/call-back, Face ID unlock.
* **Android**: native call screen (ConnectionService), Android Auto, push notifications, offline drafts.
* **Desktop**: native notifications, tray status menu, global shortcuts ⌘/Ctrl+Shift+A (answer), H (hang up), M (mute).

## Troubleshooting
* *No audio*: allow microphone access in the browser/OS; check the headset is the default device.
* *Can't call internationally*: your admin may restrict countries (*Security → Allowed calling countries*), or the destination is blocked by fraud protection.
* *Recipient didn't get SMS*: they may have replied STOP; they can reply START to opt back in.
