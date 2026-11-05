# Production deployment guide

## 0. Prerequisites
* AWS org with separate accounts for staging/production; Terraform state bucket + DynamoDB lock table.
* Cloudflare zone for `cloudconnect.ai` (WAF, load balancing add-on).
* Carrier account(s): Twilio (Voice, Messaging, TwiML App, API key/secret), and optionally Telnyx/SignalWire.
* OpenAI API key (zero-retention for HIPAA tenants), Stripe account (products/prices per plan & interval), LiveKit Cloud or self-hosted LiveKit.
* GitHub repo with environments `staging` and `production` (required reviewers), OIDC trust to an AWS deploy role.

## 1. Infrastructure (Terraform)
```bash
cd infra/terraform/envs/production
cp terraform.tfvars.example terraform.tfvars   # fill in Cloudflare + KMS admins
terraform init
terraform apply -target=module.us_east_1 -target=aws_rds_global_cluster.main
terraform apply                                  # secondary region, backups, Cloudflare LB
```
Creates per region: VPC (3 AZ, NAT per AZ, flow logs), EKS 1.31 (system/app/media node groups), Aurora PostgreSQL 16 (global DB), ElastiCache Redis cluster, OpenSearch, S3 media (KMS, versioned, CRR), IRSA role; globally: Aurora global cluster, AWS Backup with cross-region copies, Cloudflare geo-steered load balancers.

## 2. Cluster add-ons (per region)
ingress-nginx (NLB), cert-manager (DNS-01 via Cloudflare), External Secrets Operator (`ClusterSecretStore aws-secrets-manager`), kube-prometheus-stack + prometheus-adapter (exposes `cc_http_requests_per_second` for the API HPA), Karpenter, Sentry relay (optional), LiveKit (Helm, on `role=media` nodes) if self-hosting.

## 3. Secrets
Create `cloudconnect/production/api` in Secrets Manager (per region):
```
DATABASE_URL=postgres://cloudconnect_app:…@<aurora-writer>/cloudconnect?sslmode=require
REDIS_URL=rediss://<config-endpoint>:6379
ELASTICSEARCH_URL=https://<opensearch-endpoint>
JWT_SECRET=<64 random bytes>            ENCRYPTION_KEY=<32-byte hex, from KMS data key>
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID
OPENAI_API_KEY   STRIPE_SECRET_KEY   STRIPE_WEBHOOK_SECRET   STRIPE_PRICE_IDS={"pro_month":"price_…",…}
LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET   GOOGLE_/MICROSOFT_/APPLE_CLIENT_ID/SECRET   SENTRY_DSN
```
Create a non-owner DB role `cloudconnect_app` for the API so Postgres RLS applies; migrations run as the owner.

## 4. Carrier configuration
* Twilio TwiML App **Voice URL** → `https://api.cloudconnect.ai/v1/telephony/twilio/voice` (softphone outbound).
* Number webhooks are set automatically on purchase (`/voice`, `/sms`); for ported numbers set the same URLs.
* Status callbacks → `/v1/telephony/twilio/status`; enable Voice Insights for MOS/jitter.
* `PUBLIC_URL` must equal the exact public origin — Twilio signatures cover the full URL.

## 5. Deploy
Merges to `main` run CI (typecheck, unit, integration on Postgres, Playwright e2e, CodeQL/Trivy/gitleaks, Terraform validate, kustomize build), then build multi-arch signed images and deploy to **staging** automatically. **Production** requires approval and rolls out one region at a time (`deploy.yml`), running the `db-migrate` job first in the primary region and auto-rolling back on failed rollouts.

Manual equivalent:
```bash
cd infra/k8s/overlays/production-us-east-1
kustomize edit set image ghcr.io/cloudconnect-ai/api:<sha> ghcr.io/cloudconnect-ai/web:<sha>
kubectl apply -k . && kubectl -n cloudconnect rollout status deploy/api
```

## 6. Post-deploy checks
`curl https://api.cloudconnect.ai/health/ready` · place a test call to a staging number and walk the IVR · send/receive an SMS · join a meeting · verify Grafana dashboard "CloudConnect — API & Telephony" and that alerts route to PagerDuty.

## 7. Operations runbook
| Scenario | Action |
|---|---|
| Region outage | Cloudflare drains the region automatically. If the primary DB region is down: `aws rds failover-global-cluster --global-cluster-identifier cloudconnect-production --target-db-cluster-identifier <euw1-arn>` (RPO ≈ 1 s). Update `DATABASE_URL` writer secret; ESO syncs within the refresh interval (force with `kubectl annotate externalsecret … force-sync=$(date +%s)`). |
| Carrier outage | Re-point affected numbers' provider (bulk `PATCH /v1/numbers/:id` or carrier-level failover URL to the secondary provider). |
| Bad deploy | `kubectl rollout undo deploy/api` (automatic in pipeline). Migrations are forward-only; write expand/contract migrations. |
| Restore data | Aurora PITR to a new cluster (35 days) or restore from AWS Backup vault (cross-region copy, 90 days). |
| Toll-fraud spike | Check `GET /v1/security/overview` fraud events; set `settings.allowedCountries`; lower `FRAUD_MAX_CALLS_PER_10MIN`. |

## 8. Local & single-host
```bash
docker compose up --build                       # http://localhost:8080 (demo seed: see README)
docker compose --profile monitoring up -d       # + Prometheus :9090, Grafana :3001
```
