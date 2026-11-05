#!/usr/bin/env bash
# One-time bootstrap of the CloudConnect Railway project (staging + production environments).
# Requires: railway CLI (npm i -g @railway/cli) logged in with an account token (RAILWAY_API_TOKEN), openssl, jq.
# Usage: infra/railway/setup.sh [project-name]
set -euo pipefail
PROJECT="${1:-cloudconnect-ai}"
API="https://backboard.railway.com/graphql/v2"
gql() { curl -fsS "$API" -H "Authorization: Bearer ${RAILWAY_API_TOKEN}" -H 'content-type: application/json' -d "$(jq -nc --arg q "$1" --argjson v "${2:-{\}}" '{query:$q,variables:$v}')"; }

railway init --name "$PROJECT"
railway environment new staging 2>/dev/null || true      # "production" exists by default
PROJECT_ID=$(railway status --json | jq -r '.id')

for ENV in staging production; do
  railway environment "$ENV"
  railway add --database postgres || true
  railway add --database redis || true
  railway add --service api || true
  railway add --service web || true

  SEED=false; AUTH_LIMIT=10; [ "$ENV" = staging ] && { SEED=true; AUTH_LIMIT=60; }
  railway variables --service api --skip-deploys \
    --set "NODE_ENV=production" --set "PORT=4000" \
    --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --set 'REDIS_URL=${{Redis.REDIS_URL}}' \
    --set "JWT_SECRET=$(openssl rand -hex 48)" --set "ENCRYPTION_KEY=$(openssl rand -hex 32)" \
    --set 'PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
    --set 'WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}' --set 'CORS_ORIGINS=https://${{web.RAILWAY_PUBLIC_DOMAIN}}' \
    --set "TELEPHONY_PROVIDER=mock" --set "SEED_DEMO=$SEED" --set "AUTH_RATE_LIMIT=$AUTH_LIMIT" \
    --set "RAILWAY_DOCKERFILE_PATH=infra/docker/api.Dockerfile"
  railway variables --service web --skip-deploys \
    --set 'API_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}' \
    --set 'NEXT_PUBLIC_WS_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}' \
    --set "RAILWAY_DOCKERFILE_PATH=infra/docker/web.Dockerfile"
  railway domain --service api
  railway domain --service web

  # Point each service at its config-as-code file (pre-deploy migrations, health checks, watch paths).
  ENV_ID=$(gql 'query($p:String!){project(id:$p){environments{edges{node{id name}}}}}' "{\"p\":\"$PROJECT_ID\"}" | jq -r ".data.project.environments.edges[].node|select(.name==\"$ENV\").id")
  for SVC in api web; do
    SVC_ID=$(gql 'query($p:String!){project(id:$p){services{edges{node{id name}}}}}' "{\"p\":\"$PROJECT_ID\"}" | jq -r ".data.project.services.edges[].node|select(.name==\"$SVC\").id")
    gql 'mutation($s:String!,$e:String!,$f:String!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:{railwayConfigFile:$f})}' \
      "{\"s\":\"$SVC_ID\",\"e\":\"$ENV_ID\",\"f\":\"infra/railway/$SVC.railway.json\"}" >/dev/null
  done
done
echo "Done. Create a project token per environment (Project → Settings → Tokens) and save them as GitHub secrets"
echo "RAILWAY_TOKEN_STAGING / RAILWAY_TOKEN_PRODUCTION, plus repo variables STAGING_WEB_URL, STAGING_API_URL, PRODUCTION_WEB_URL, PRODUCTION_API_URL."
