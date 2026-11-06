# Launching on GitHub + Railway

## Live deployment
| | Production | Staging (demo data) |
|---|---|---|
| Web | https://web-production-0cf2f5.up.railway.app | https://web-staging-4270.up.railway.app |
| API | https://api-production-f43f6.up.railway.app (`/docs`, `/graphql`) | https://api-staging-ae0c.up.railway.app |
| Login | sign up a new company | `demo@cloudconnect.ai` / `DemoPassw0rd!` |

Railway project `cloudconnect-ai` (`ce6f9835-ae8d-43f2-9fa6-52a01d867914`). Telephony runs on the **mock** carrier until Twilio credentials are added.

The fastest path to a live CloudConnect: GitHub for source and CI, Railway for hosting
(API + web from the repo's Dockerfiles, managed PostgreSQL and Redis).

```
push to main ─▶ CI (typecheck · unit · integration on Postgres · e2e · security · IaC)
                 └─▶ Railway workflow: deploy staging ─▶ smoke tests ─▶ Playwright e2e vs. staging
                                         └─▶ (approval) deploy production ─▶ smoke tests
```

## Topology (per Railway environment: `staging`, `production`)
| Service | Source | Notes |
|---|---|---|
| `api` | `infra/docker/api.Dockerfile` | Pre-deploy `release.sh` runs migrations (+ demo seed when `SEED_DEMO=true`); health check `/health/ready`; public domain for carriers, websockets and the API |
| `web` | `infra/docker/web.Dockerfile` | Proxies `/v1` + `/graphql` to `api` over Railway private networking (`API_URL`, read at request time) |
| `Postgres` | Railway PostgreSQL | `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| `Redis` | Railway Redis | `REDIS_URL=${{Redis.REDIS_URL}}` |

## One-time setup (already done for the live project)
`RAILWAY_API_TOKEN=… infra/railway/setup.sh` creates a project like the live one via Railway's GraphQL API
(Railway deprecated `railway.json` config-as-code, so build/deploy settings — Dockerfile path, pre-deploy
`release.sh`, health checks, restart policy — are applied per service instance). Staging was created by
duplicating production, then giving it its own `JWT_SECRET`/`ENCRYPTION_KEY`, `SEED_DEMO=true`,
`AUTH_RATE_LIMIT=60`, and **its own Postgres/Redis volumes** (duplicated environments don't copy volumes).

## Connect GitHub (remaining step)
1. Push this repo to GitHub.
2. GitHub → Settings → Secrets → `RAILWAY_API_TOKEN` (a Railway account/workspace token).
3. GitHub → Settings → Environments: `staging`, `production` (add required reviewers to `production` to gate launches).
4. Push to `main` → CI → deploy staging → smoke + Playwright vs. staging → approval → production.
   Project/environment/service IDs and URLs are pinned in `.github/workflows/railway.yml`.

Manual deploy of the committed tree: `RAILWAY_API_TOKEN=… infra/railway/deploy.sh <projectId> <envId> <serviceId>`.

## Going live with real services
Set on the `api` service (production environment): `TELEPHONY_PROVIDER=twilio` + `TWILIO_*`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_IDS`, `LIVEKIT_*`, OAuth client IDs, and `SEED_DEMO=false`. `PUBLIC_URL` must exactly match the API's public origin (Twilio signs the full URL). Add custom domains (e.g. `app.` / `api.`) in Railway and update `WEB_URL`/`CORS_ORIGINS`/`PUBLIC_URL`.

## Verified on the live deployment
* Production: health/ready OK; real-browser run of signup → dashboard → reload (refresh cookie through the proxy) →
  buy number → softphone call + hold → SMS → IVR builder/analytics → websocket — all passing, no page errors.
  Carrier webhooks without valid signatures get 403; `/metrics` returns 404 publicly.
* Staging: full Playwright suite 10/10 against `web-staging-4270.up.railway.app`.
* Railway's dependency scanner blocked the first deploy on `next@14.2.21` (CVE-2025-55184, CVE-2025-67779) → upgraded to 14.2.35.

## When to move to AWS
Railway suits launch and early growth. For the multi-region 99.99% / 1M-user target, use the EKS + Aurora Global
path in `docs/DEPLOYMENT.md` (`.github/workflows/deploy.yml`, manual trigger).
