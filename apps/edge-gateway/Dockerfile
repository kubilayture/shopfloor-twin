# Edge gateway: OPC UA collectors, WSH-01 Modbus poller, store-and-forward, MQTT (port 4900: health
# and metrics). Build from the repository root: docker build -f apps/edge-gateway/Dockerfile .
# Node.js runs the TypeScript sources directly (ADR-0003), so there is no build step.

FROM node:26.11.1-alpine3.23 AS base
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.11.2
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/edge-gateway/package.json apps/edge-gateway/
COPY packages/contracts/package.json packages/contracts/
COPY packages/oee-core/package.json packages/oee-core/
COPY packages/plant-config/package.json packages/plant-config/
COPY packages/shift-calendar/package.json packages/shift-calendar/
# Production dependencies of the gateway and its workspace packages only; no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @shopfloor/edge-gateway...

FROM node:26.11.1-alpine3.23 AS runtime
ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    PLANT_CONFIG_DIR=/app/config/plant \
    BUFFER_PATH=/var/lib/gateway/buffer/gateway.db \
    OPCUA_PKI_DIR=/var/lib/gateway/pki
WORKDIR /app
COPY --from=deps /app ./
COPY config/plant config/plant
COPY packages/contracts/src packages/contracts/src
COPY packages/oee-core/src packages/oee-core/src
COPY packages/plant-config/src packages/plant-config/src
COPY packages/shift-calendar/src packages/shift-calendar/src
COPY apps/edge-gateway/src apps/edge-gateway/src
RUN mkdir -p /var/lib/gateway/buffer /var/lib/gateway/pki && chown -R node:node /var/lib/gateway
USER node
EXPOSE 4900
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HTTP_PORT ?? 4900) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "apps/edge-gateway/src/main.ts"]
