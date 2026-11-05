#!/usr/bin/env bash
# One-time bootstrap of the CloudConnect Railway project via Railway's public GraphQL API.
# (Railway's legacy railway.json config-as-code is deprecated, so service settings are applied directly.)
# Requires: curl, jq, openssl and a Railway account/workspace token in RAILWAY_API_TOKEN.
# Usage: RAILWAY_API_TOKEN=… infra/railway/setup.sh [project-name]   → prints project/env/service ids and URLs
set -euo pipefail
NAME="${1:-cloudconnect-ai}"
gql() { curl -fsS https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer ${RAILWAY_API_TOKEN}" -H 'content-type: application/json' \
  -d "$(jq -nc --arg q "$1" --argjson v "${2:-{\}}" '{query:$q,variables:$v}')"; }

PROJ=$(gql 'mutation($i:ProjectCreateInput!){projectCreate(input:$i){id environments{edges{node{id}}}}}' "$(jq -nc --arg n "$NAME" '{i:{name:$n,defaultEnvironmentName:"production"}}')")
P=$(jq -r .data.projectCreate.id <<<"$PROJ"); E=$(jq -r '.data.projectCreate.environments.edges[0].node.id' <<<"$PROJ")

for code in postgres redis; do   # Railway's official database templates (with volumes)
  T=$(gql 'query($c:String!){template(code:$c){id serializedConfig}}' "{\"c\":\"$code\"}")
  gql 'mutation($i:TemplateDeployV2Input!){templateDeployV2(input:$i){workflowId}}' \
    "$(jq -c --arg p "$P" --arg e "$E" '{i:{projectId:$p,environmentId:$e,templateId:.data.template.id,serializedConfig:.data.template.serializedConfig}}' <<<"$T")" >/dev/null
done

svc() { gql 'mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id}}' "{\"i\":{\"projectId\":\"$P\",\"name\":\"$1\"}}" | jq -r .data.serviceCreate.id; }
API=$(svc api); WEB=$(svc web)
domain() { gql 'mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}' "{\"i\":{\"serviceId\":\"$1\",\"environmentId\":\"$E\",\"targetPort\":$2}}" | jq -r .data.serviceDomainCreate.domain; }
API_DOMAIN=$(domain "$API" 4000); WEB_DOMAIN=$(domain "$WEB" 3000)

vars() { gql 'mutation($i:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$i)}' \
  "$(jq -nc --arg p "$P" --arg e "$E" --arg s "$1" --argjson v "$2" '{i:{projectId:$p,environmentId:$e,serviceId:$s,variables:$v,skipDeploys:true}}')" >/dev/null; }
vars "$API" "$(jq -nc --arg jwt "$(openssl rand -hex 48)" --arg enc "$(openssl rand -hex 32)" '{NODE_ENV:"production",PORT:"4000",
  DATABASE_URL:"${{Postgres.DATABASE_URL}}",REDIS_URL:"${{Redis.REDIS_URL}}",JWT_SECRET:$jwt,ENCRYPTION_KEY:$enc,
  PUBLIC_URL:"https://${{RAILWAY_PUBLIC_DOMAIN}}",WEB_URL:"https://${{web.RAILWAY_PUBLIC_DOMAIN}}",CORS_ORIGINS:"https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
  TELEPHONY_PROVIDER:"mock",SEED_DEMO:"false",AUTH_RATE_LIMIT:"10",RAILWAY_DOCKERFILE_PATH:"infra/docker/api.Dockerfile"}')"
vars "$WEB" '{"PORT":"3000","API_URL":"http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}","NEXT_PUBLIC_WS_URL":"https://${{api.RAILWAY_PUBLIC_DOMAIN}}","RAILWAY_DOCKERFILE_PATH":"infra/docker/web.Dockerfile"}'

inst() { gql 'mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}' \
  "$(jq -nc --arg s "$1" --arg e "$E" --argjson i "$2" '{s:$s,e:$e,i:$i}')" >/dev/null; }
inst "$API" '{"dockerfilePath":"infra/docker/api.Dockerfile","preDeployCommand":["sh release.sh"],"healthcheckPath":"/health/ready","healthcheckTimeout":120,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":5,"overlapSeconds":20,"drainingSeconds":30}'
inst "$WEB" '{"dockerfilePath":"infra/docker/web.Dockerfile","healthcheckPath":"/login","healthcheckTimeout":120,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":5}'

cat <<OUT
project=$P environment(production)=$E api=$API web=$WEB
API  https://$API_DOMAIN
Web  https://$WEB_DOMAIN
Next: deploy with infra/railway/deploy.sh (or GitHub Actions), then create a staging environment by
duplicating production in the Railway dashboard and set SEED_DEMO=true / AUTH_RATE_LIMIT=60 there.
OUT
