#!/usr/bin/env bash
# Deploy the committed tree (git archive HEAD) to a Railway service and wait for the result.
# Usage: RAILWAY_API_TOKEN=… infra/railway/deploy.sh <projectId> <environmentId> <serviceId>
set -euo pipefail
P=$1 E=$2 S=$3
AUTH=(); [ -n "${RAILWAY_API_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${RAILWAY_API_TOKEN}")
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP" HEAD
D=$(curl -fsS -X POST "https://backboard.railway.com/project/$P/environment/$E/up?serviceId=$S" "${AUTH[@]}" -H 'Content-Type: multipart/form-data' --data-binary @"$TMP" | jq -r .deploymentId)
echo "deployment $D"
for _ in $(seq 1 90); do
  ST=$(curl -fsS https://backboard.railway.com/graphql/v2 "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"query\":\"{ deployment(id:\\\"$D\\\"){ status } }\"}" | jq -r .data.deployment.status)
  case "$ST" in SUCCESS) echo "✔ $ST"; exit 0;; FAILED|CRASHED|REMOVED) echo "✘ $ST"; exit 1;; esac
  sleep 10
done
echo "timed out (last status $ST)"; exit 1
