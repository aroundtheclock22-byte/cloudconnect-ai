# API reference

* **REST** — base `https://api.cloudconnect.ai/v1`. Machine-readable spec: [`docs/api/openapi.json`](api/openapi.json) (108 paths; live at `/docs` and `/openapi.json`).
* **GraphQL** — `POST /graphql`. Schema: [`docs/api/schema.graphql`](api/schema.graphql). Same auth/RBAC; depth ≤ 6, size ≤ 10 KB.
* **Realtime** — Socket.IO at `/ws` (`auth: { token }`).

## Authentication
| Method | Use |
|---|---|
| `POST /v1/auth/login` → `{accessToken, refreshToken}` | Users. Access JWT (HS256, 15 min, `iss=cloudconnect`, `aud=cloudconnect-api`). Refresh token is opaque, rotated on every use; replaying an old one revokes the whole session family. Web gets it as an `httpOnly; SameSite=Strict` cookie. |
| MFA | `POST /v1/auth/mfa/setup` → secret; `POST /v1/auth/mfa/enable {code}`; login then returns `{mfaRequired:true}` until `mfaCode` is supplied. |
| SSO | `GET /v1/auth/oauth/{google|microsoft|apple}` → redirect URL; callback verifies the ID token against the provider JWKS. |
| API keys | `POST /v1/auth/api-keys {name, scopes}` → `cc_live_…` (shown once, stored as SHA-256). Send as `Authorization: Bearer cc_live_…`. Scopes are permission names, e.g. `contacts:read`, `calls:*`. |

## Conventions
* JSON bodies validated with zod; `400 {message, issues}` on validation errors.
* Lists: `?limit=` (≤200) `&offset=` → `{data, total, limit, offset}`.
* Rate limits: 600 req/min per client (configurable), 5 signups / 10 logins per minute per IP → `429`.
* All mutations are written to the audit log (secrets redacted).

## Endpoint groups (abridged)
| Group | Endpoints |
|---|---|
| Users & teams | `GET/POST /users`, `PATCH/DELETE /users/:id`, `GET /directory`, `PUT /me/presence`, `PUT /me/call-handling`, `GET/POST /teams`, `GET/POST /devices` |
| Numbers & routing | `GET /numbers`, `GET /numbers/available?country&type&areaCode&vanity`, `POST /numbers`, `PATCH/DELETE /numbers/:id`, `POST /numbers/port-requests`, `GET/POST/PUT /routing-flows`, `POST /routing-flows/validate`, `GET/POST /sip-trunks`, `GET/POST/DELETE /blocked-numbers` |
| Calls | `POST /calls {to, from?}` (click-to-call), `POST /calls/:id/{hold,unhold,transfer,warm_transfer,conference,park,record_start,record_pause,record_resume,monitor,whisper,barge,hangup}`, `POST /park/:orbit/pickup`, `GET /calls`, `GET /calls/active`, `GET /calls/:id`, `POST /calls/:id/analyze`, `GET /recordings/:id`, `GET /telephony/token` |
| Voicemail | `GET /voicemails`, `GET /voicemails/:id/audio`, `PATCH/DELETE /voicemails/:id` |
| Messaging | `POST /messages`, `POST /messages/bulk`, `POST /messages/segments`, `GET /conversations`, `GET /conversations/:id/messages`, `POST /conversations/:id/read`, `POST /conversations/:id/suggest-replies`, `POST /chats`, `POST /chats/:id/messages`, `GET/POST /sms-templates`, `GET/PUT /auto-replies` |
| Contacts | `GET/POST /contacts`, `PATCH/DELETE /contacts/:id`, `GET /contacts/lookup?phone`, `GET /contacts/duplicates`, `POST /contacts/merge`, `POST /contacts/import`, `GET /contacts/export.csv`, `GET/POST /contacts/groups` |
| Meetings | `GET/POST /meetings`, `PATCH/DELETE /meetings/:id`, `POST /meetings/:code/join`, `GET /meetings/:code/ics`, `POST /meetings/:id/participants/:pid/{admit,deny,promote}`, `POST /meetings/:id/breakouts`, `POST /meetings/:id/end`, `POST /meetings/:id/notes`, `GET /meetings/:id/analytics` |
| Analytics | `GET /analytics/dashboard`, `/analytics/calls`, `/analytics/messaging`, `/analytics/users`, `/analytics/ai` (`?days=` or `?from&to`) |
| Billing | `GET /billing/plans?currency`, `GET /billing/rates`, `GET /billing/subscription`, `GET /billing/invoice-preview`, `GET /billing/invoices`, `GET /billing/usage`, `POST /billing/checkout`, `POST /billing/portal`, `POST /billing/stripe/webhook` |
| Admin | `GET/PATCH /organization`, `GET /audit-logs`, `GET /security/overview`, `POST /security/users/:id/revoke-sessions`, `GET /privacy/users/:id/export`, `POST /privacy/erase`, `GET/POST/DELETE /webhooks`, `GET /webhooks/:id/deliveries`, `GET/POST/DELETE /integrations`, `POST /ai/{translate,draft,analyze}`, `GET /search?q` |
| Carrier webhooks | `POST /telephony/:provider/{voice,voice/continue,status,recording,voicemail,transcription,ai,bridge,conference,sms,sms/status}` — signature-verified |

## Webhooks (outbound)
Events: `call.ringing`, `call.answered`, `call.completed`, `call.missed`, `call.recording.ready`, `call.analyzed`,
`voicemail.received`, `message.received`, `message.sent`, `meeting.started`, `meeting.ended`, `user.created`, `number.purchased`.

```http
POST https://your.app/hooks
X-CloudConnect-Signature: t=1793918994,v1=5f1c…
{"id":"…","type":"call.completed","created_at":"…","data":{"callId":"…","durationSeconds":184}}
```
Verify: `hex(HMAC_SHA256(secret, t + "." + rawBody)) == v1` and `|now − t| < 300`. Non-2xx responses are retried at 30 s, 2 min, 10 min, 1 h, 6 h.

## GraphQL example
```graphql
query { me { firstName extension } calls(limit: 5, direction: "inbound") { from durationSeconds insight { sentiment callScore } } callStats(days: 7) { answered missed } }
```
