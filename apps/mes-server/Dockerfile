# MES server: ingest, state intervals, REST API and WebSocket push (port 4700). It connects as
# mes_app and reports ready once the database is migrated; the same image runs the `migrate` step
# (`node apps/mes-server/src/db/cli.ts`, ADR-0016 amended, ADR-0027).
# Build from the repository root: docker build -f apps/mes-server/Dockerfile .
# Node.js runs the TypeScript sources directly (ADR-0003), so there is no build step.
# The workspace packages copied below must match the server's dependencies:
# `node scripts/check-dockerfiles.ts` (part of `pnpm verify`) checks it.

FROM node:26.11.1-alpine3.23 AS base
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.11.2
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mes-server/package.json apps/mes-server/
COPY packages/alarm-core/package.json packages/alarm-core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/oee-core/package.json packages/oee-core/
COPY packages/plant-config/package.json packages/plant-config/
COPY packages/shift-calendar/package.json packages/shift-calendar/
COPY packages/spc-core/package.json packages/spc-core/
# Production dependencies of the server and its workspace packages only; no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @shopfloor/mes-server...

FROM node:26.11.1-alpine3.23 AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/db/migrations \
    PLANT_CONFIG_DIR=/app/config/plant
WORKDIR /app
COPY --from=deps /app ./
COPY db/migrations db/migrations
COPY config/plant config/plant
COPY packages/alarm-core/src packages/alarm-core/src
COPY packages/contracts/src packages/contracts/src
COPY packages/oee-core/src packages/oee-core/src
COPY packages/plant-config/src packages/plant-config/src
COPY packages/shift-calendar/src packages/shift-calendar/src
COPY packages/spc-core/src packages/spc-core/src
COPY apps/mes-server/src apps/mes-server/src
USER node
EXPOSE 4700
# Ready once migrated, the database answers and the UNS subscription is granted.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT ?? 4700) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "apps/mes-server/src/main.ts"]
