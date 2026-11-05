# Launching on GitHub + Railway

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
| `api` | `infra/docker/api.Dockerfile`, config `infra/railway/api.railway.json` | Pre-deploy `release.sh` runs migrations (+ demo seed when `SEED_DEMO=true`); health check `/health/ready`; public domain for carriers, websockets and the API |
| `web` | `infra/docker/web.Dockerfile`, config `infra/railway/web.railway.json` | Proxies `/v1` + `/graphql` to `api` over Railway private networking (`API_URL`, baked at build time) |
| `Postgres` | Railway PostgreSQL | `DATABASE_URL=${{Postgres.DATABASE_URL}}` |
| `Redis` | Railway Redis | `REDIS_URL=${{Redis.REDIS_URL}}` |

## One-time setup
1. Push this repo to GitHub.
2. Create a Railway account token, then run `RAILWAY_API_TOKEN=… infra/railway/setup.sh` (creates project, environments, databases, services, variables with freshly generated `JWT_SECRET`/`ENCRYPTION_KEY`, domains, and config-file paths).
3. In Railway → Project → Settings → Tokens, create one **project token per environment**.
4. In GitHub → Settings:
   * Secrets: `RAILWAY_TOKEN_STAGING`, `RAILWAY_TOKEN_PRODUCTION`
   * Variables: `STAGING_WEB_URL`, `STAGING_API_URL`, `PRODUCTION_WEB_URL`, `PRODUCTION_API_URL` (the `*.up.railway.app` domains)
   * Environments: `staging`, `production` (add required reviewers to `production` to gate launches)
5. Push to `main` (or run **Railway** workflow manually).

## Going live with real services
Set on the `api` service (production environment): `TELEPHONY_PROVIDER=twilio` + `TWILIO_*`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_IDS`, `LIVEKIT_*`, OAuth client IDs, and `SEED_DEMO=false`. `PUBLIC_URL` must exactly match the API's public origin (Twilio signs the full URL). Add custom domains (e.g. `app.` / `api.`) in Railway and update `WEB_URL`/`CORS_ORIGINS`/`PUBLIC_URL`.

## Verified locally
The exact Railway configuration (production `NODE_ENV`, generated secrets, pre-deploy `release.sh`, web built with
`API_URL`/`NEXT_PUBLIC_WS_URL` build args) was rehearsed with the same images: release step is idempotent,
health checks pass, and the full Playwright suite (10/10) passes against the containers.

## When to move to AWS
Railway suits launch and early growth. For the multi-region 99.99% / 1M-user target, use the EKS + Aurora Global
path in `docs/DEPLOYMENT.md` (`.github/workflows/deploy.yml`, manual trigger).
