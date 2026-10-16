# ERP mock (#171, ADR-0028): orders, lots and the MES's confirmations and status messages over REST
# (port 4600: API, health and metrics). Build from the repository root:
# docker build -f apps/erp-mock/Dockerfile .
# Node.js runs the TypeScript sources directly (ADR-0003), so there is no build step.

FROM node:26.11.1-alpine3.23 AS base
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.11.2
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/erp-mock/package.json apps/erp-mock/
COPY packages/contracts/package.json packages/contracts/
COPY packages/oee-core/package.json packages/oee-core/
COPY packages/plant-config/package.json packages/plant-config/
COPY packages/shift-calendar/package.json packages/shift-calendar/
# Production dependencies of the ERP mock and its workspace packages only; no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @shopfloor/erp-mock...

FROM node:26.11.1-alpine3.23 AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    PLANT_CONFIG_DIR=/app/config/plant \
    ERP_DATASET=/app/config/erp/orders.yaml \
    ERP_STORE_PATH=/var/lib/erp/erp.db
WORKDIR /app
COPY --from=deps /app ./
COPY config/plant config/plant
COPY config/erp config/erp
COPY packages/contracts/src packages/contracts/src
COPY packages/oee-core/src packages/oee-core/src
COPY packages/plant-config/src packages/plant-config/src
COPY packages/shift-calendar/src packages/shift-calendar/src
COPY apps/erp-mock/src apps/erp-mock/src
RUN mkdir -p /var/lib/erp && chown -R node:node /var/lib/erp
USER node
EXPOSE 4600
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT ?? 4600) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "apps/erp-mock/src/main.ts"]
