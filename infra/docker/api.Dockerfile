# syntax=docker/dockerfile:1.7
FROM node:22.12-alpine AS base
# corepack bundled with node 22.12 has stale npm signing keys; install pnpm directly
RUN npm install -g pnpm@10.28.0
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @cloudconnect/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cloudconnect/shared build && pnpm --filter @cloudconnect/api build \
 && pnpm --filter @cloudconnect/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/db /out/ && mkdir -p /out/scripts && cp apps/api/scripts/migrate.ts /out/scripts/ \
 && npx -y -p typescript@5.6.3 tsc --outDir /out/scripts --module commonjs --target es2022 --esModuleInterop --skipLibCheck apps/api/scripts/migrate.ts

FROM node:22.12-alpine AS runtime
ENV NODE_ENV=production PORT=4000
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /out ./
USER app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/main.js"]
