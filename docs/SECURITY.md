# Security & compliance

## Implemented controls
| Area | Control | Where |
|---|---|---|
| Authentication | bcrypt (12 rounds) passwords with complexity policy; TOTP MFA (secrets AES-256-GCM encrypted); Google/Microsoft/Apple OIDC with JWKS signature, issuer & audience checks; short-lived JWT + rotating refresh tokens with reuse detection | `modules/auth` |
| Sessions | Session list/revoke per user, admin "revoke all", suspension revokes sessions, httpOnly SameSite=Strict cookie | `auth.controller.ts`, `admin.controller.ts` |
| Authorization | 10 roles → 40+ permissions; privilege-escalation guard (`canAssignRole`); scoped API keys; ownership checks on calls/recordings/voicemail/conversations | `packages/shared/src/rbac.ts`, `common/auth.ts` |
| Tenant isolation | `org_id` scoping in every query + Postgres RLS | `002_rls.sql`, integration test "isolates tenants" |
| Carrier webhooks | Twilio/SignalWire HMAC-SHA1, Telnyx ed25519 + 5-min replay window; unknown providers fail closed | `telephony/signature.ts` |
| Outbound webhooks | HMAC-SHA256 signatures; SSRF guard (https only, DNS-resolved private/link-local/CGNAT ranges blocked, no redirects, 10 s timeout) | `platform/webhooks.service.ts` |
| Abuse | Global + per-route rate limits (Nest throttler, NGINX `limit_req`, Cloudflare WAF); toll-fraud/IRSF prefix blocking, outbound velocity limits, country allowlists, fraud event log | `platform/fraud.service.ts` |
| Spam | Inbound spam scoring (neighbor spoofing, robocall patterns, cross-tenant block reputation), anonymous-caller blocking, per-org blocklists | `fraud.service.ts`, routing `screenCall` |
| Messaging compliance | STOP/START/HELP keyword handling, opt-out enforcement on single & bulk sends | `messaging.service.ts` |
| Data protection | TLS 1.2+ everywhere, SRTP media, KMS encryption at rest (RDS, S3, Redis, OpenSearch, EKS secrets), AES-GCM field encryption for MFA secrets, port PINs, integration credentials | Terraform `modules/region`, `common/crypto.ts` |
| Input handling | zod validation, parameterized SQL only, XML escaping in TwiML, CSV formula-injection protection, GraphQL depth/size limits | throughout |
| Audit | Every mutation + auth event (login, failure, MFA, refresh-reuse) recorded with actor, IP, UA, redacted body | `common/audit.ts` |
| Privacy (GDPR) | Data export (Art. 15/20) and erasure for external parties (Art. 17); EU data residency via eu-west-1 region | `admin.controller.ts` |
| Supply chain | CodeQL, Trivy, gitleaks in CI; SBOM + provenance + cosign-signed images | `.github/workflows/ci.yml` |
| Runtime | Non-root, read-only root FS, dropped capabilities, seccomp, restricted Pod Security, default-deny NetworkPolicy, IRSA least-privilege | `infra/k8s/base` |
| Desktop | Sandboxed renderer, context isolation, origin-locked navigation & permissions | `apps/desktop/src/main.ts` |

## Compliance readiness (what remains organizational)
* **SOC 2** — technical controls above map to CC6 (logical access), CC7 (monitoring), CC8 (change management via CI + approvals). Still needed: policies, vendor reviews, access reviews, evidence collection (e.g. Vanta/Drata), a type I then type II audit.
* **HIPAA** — encryption, audit logs, access controls and AI opt-out exist; still needed: BAAs with AWS, carriers (Twilio offers one), OpenAI (zero-retention / BAA) and LiveKit; enforce `hipaa_enabled` to disable SMS content previews in push notifications and email voicemail attachments.
* **PCI DSS** — card data never touches CloudConnect (Stripe Checkout/Portal, SAQ A). For agents taking payments by phone, enable recording pause (`record_pause`/`record_resume`) or carrier DTMF masking (Twilio `<Pay>`).
* **GDPR** — DPA, records of processing, subprocessor list, EU-only tenant pinning (route EU tenants' data to the EU region; current schema stores `data_region`).
* **STIR/SHAKEN & A2P 10DLC** — carrier-side attestation and campaign registration are required for US calling/SMS at scale.

## Known gaps before production
* Plivo and Vonage webhook signature verification is not implemented — those providers **fail closed** (requests rejected) until added.
* JWTs are HS256 with a shared secret; move to KMS-backed RS256/ES256 with key rotation and JWKS for multi-service verification.
* SAML SSO is modeled (`organizations.sso_config`) but only OIDC providers are wired.
* Penetration test and threat model review have not been performed.
