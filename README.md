# CloudConnect AI

AI-powered cloud business communications — phone system, SMS & team chat, video meetings, contacts,
analytics and administration — for teams from one person to the enterprise.

| | |
|---|---|
| **Monorepo** | pnpm workspaces · TypeScript everywhere |
| **Backend** | NestJS (Express) · PostgreSQL 16 (+RLS) · Redis · Socket.IO · REST + GraphQL · OpenAPI |
| **Telephony** | Provider adapters for Twilio, Telnyx, SignalWire (+ Plivo/Vonage markup); WebRTC softphone; SIP trunks & devices |
| **AI** | OpenAI GPT + Whisper with deterministic offline fallback |
| **Frontend** | Next.js 14 · React 18 · Tailwind CSS |
| **Apps** | Expo/React Native (iOS/Android), Electron (Windows/macOS/Linux) |
| **Infra** | Docker · Kubernetes (kustomize) · Terraform (AWS multi-region) · NGINX · Cloudflare · Prometheus/Grafana · GitHub Actions |

## Quick start (local)

```bash
pnpm install
pnpm --filter @cloudconnect/shared build
docker compose up -d postgres redis          # or use local Postgres 16 + Redis 7
pnpm db:migrate && pnpm db:seed              # demo tenant "Northwind Traders"
pnpm dev:api                                 # http://localhost:4000  (Swagger: /docs, GraphQL: /graphql)
pnpm dev:web                                 # http://localhost:3000
```
Sign in as **demo@cloudconnect.ai / DemoPassw0rd!** (14 days of calls, AI insights, SMS threads, voicemail, meetings).
With `TELEPHONY_PROVIDER=mock` (default) every carrier operation is simulated; set Twilio credentials and `PUBLIC_URL` (e.g. an ngrok URL) to take real calls.

Full stack in containers: `docker compose up --build` → http://localhost:8080.

## Tests

```bash
pnpm lint                 # typecheck shared, api, web
pnpm test                 # unit: routing engine, schedules/TZ/DST, RBAC, billing, renderers, signatures, AI analyzer, SMS, CSV, SSRF, crypto
pnpm test:integration     # API against real Postgres: auth/MFA/refresh-reuse, RBAC & tenancy, full IVR call lifecycle,
                          # outbound + fraud, SMS + STOP, team chat, contacts import/merge, meetings, billing, webhooks, GraphQL, search
pnpm test:e2e             # Playwright (desktop + mobile viewport) against running API (seeded) + web
```
Current results: **22 shared unit · 16 API unit · 14 API integration · 10 e2e — all passing.**

## Documentation
| Doc | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | system diagram, call flow, scaling to 1M+ users, HA/DR (99.99%), decomposition path |
| [Database](docs/DATABASE.md) | schema, tenancy & RLS, partitioning |
| [API](docs/API.md) · [OpenAPI](docs/api/openapi.json) · [GraphQL SDL](docs/api/schema.graphql) | auth, endpoints, webhooks |
| [Security & compliance](docs/SECURITY.md) | controls, SOC 2 / HIPAA / GDPR / PCI readiness, known gaps |
| [Deployment](docs/DEPLOYMENT.md) | production rollout & runbook |
| [User & admin guide](docs/USER_GUIDE.md) | end-user documentation |
| [Mobile](apps/mobile/README.md) · [Desktop](apps/desktop/README.md) | native app notes |

## Implementation status

Honest map of what is built and verified vs. what is scaffolded and needs work before launch.

| Area | Status |
|---|---|
| Routing engine (IVR, hours/holidays/TZ, language select, ring/hunt groups, forward, queue, AI receptionist, voicemail) | ✅ Implemented, unit + integration tested |
| Carrier webhooks, TwiML/TeXML rendering, signature verification (Twilio/SignalWire/Telnyx) | ✅ Tested against mock carrier; ⚠️ not yet exercised against live carrier accounts |
| Call control (hold, blind/warm transfer, conference, park/pickup, record pause/resume, monitor/whisper/barge) | ✅ API implemented (Twilio-family REST); ⚠️ monitor/whisper/barge require calls to be bridged via conference |
| Auth (JWT, rotating refresh, MFA, API keys, Google/Microsoft/Apple OIDC), RBAC (10 roles), RLS tenancy, audit | ✅ Implemented & tested (OIDC flow not tested against live IdPs) |
| SMS/MMS, group, scheduled, templates, bulk/broadcast, auto-replies, STOP compliance, team chat, AI replies | ✅ Implemented & tested |
| Contacts (CRUD, directory, presence, import/export, dedupe/merge, tags, favorites) | ✅ Implemented & tested |
| Meetings (scheduling, ICS, waiting room, passcodes, webinar roles, breakouts, AI notes, analytics) | ✅ Backend + lobby UI; ⚠️ in-room video uses LiveKit tokens — the LiveKit client room UI (`livekit-client`) still needs wiring |
| AI (summaries, sentiment, action items, keywords, scoring, coaching, translation, receptionist) | ✅ With OpenAI or heuristic fallback; ⚠️ real-time streaming receptionist (OpenAI Realtime) not built — turn-based speech gather is |
| Billing (plans, seats, monthly/annual, usage rating, intl/toll-free, coupons, tax %, invoices, Stripe checkout/portal/webhooks) | ✅ Implemented; ⚠️ Stripe paths not exercised against a live account; taxes rely on Stripe Tax |
| Analytics & dashboard widgets | ✅ Implemented |
| Search | ✅ Postgres fallback tested; Elasticsearch/OpenSearch path implemented, not integration-tested |
| Web portal (user + admin) | ✅ Built, e2e tested (desktop + mobile viewport) |
| Mobile apps | 🟡 Source written (CallKit/ConnectionService, VoIP push, offline cache, widget/Siri/Watch Swift); **not compiled here** — needs Xcode/Android SDK + `expo prebuild` |
| Desktop app | 🟡 Source written; **not built here** (needs Electron binaries/signing) |
| Integrations | 🟡 Catalog + encrypted credential storage + webhooks; per-vendor sync (Salesforce/HubSpot logging, calendar sync) not yet implemented |
| Notifications worker (voicemail email via SES, push fan-out) | ❌ Not built — events are emitted for it |
| Docker images | ✅ Both images built and smoke-tested (API migrates + serves, web serves + proxies) |
| Kubernetes manifests | 🟡 YAML validated; not applied to a cluster |
| Terraform | 🟡 `terraform fmt` clean; `validate`/`plan` not run (registry unreachable from the build sandbox) — CI runs `validate` |
| Compliance (SOC 2, HIPAA, PCI, GDPR) | 🟡 Technical controls in place; organizational/audit work outstanding — see SECURITY.md |
