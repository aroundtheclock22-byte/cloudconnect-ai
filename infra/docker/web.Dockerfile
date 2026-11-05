# syntax=docker/dockerfile:1.7
FROM node:22.12-alpine AS base
# corepack bundled with node 22.12 has stale npm signing keys; install pnpm directly
RUN npm install -g pnpm@10.28.0
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @cloudconnect/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_WS_URL=https://api.cloudconnect.ai
# Rewrites (/v1, /graphql → API) are resolved at build time. In k8s/compose the ingress routes these paths
# to the API directly; this is the in-cluster fallback.
ARG API_URL=http://api.cloudconnect.svc.cluster.local
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL API_URL=$API_URL
RUN pnpm --filter @cloudconnect/shared build && pnpm --filter @cloudconnect/web build

FROM node:22.12-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
