# Simulator in live mode: five OPC UA servers (4841–4845), the WSH-01 Modbus TCP server (5020)
# and the control API (4800).
# Build from the repository root: docker build -f apps/simulator/Dockerfile .
# Node.js runs the TypeScript sources directly (ADR-0003), so there is no build step.

FROM node:26.11.1-alpine3.23 AS base
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.11.2
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/simulator/package.json apps/simulator/
COPY packages/contracts/package.json packages/contracts/
COPY packages/oee-core/package.json packages/oee-core/
COPY packages/plant-config/package.json packages/plant-config/
COPY packages/shift-calendar/package.json packages/shift-calendar/
COPY packages/sim-core/package.json packages/sim-core/
# Production dependencies of the simulator and its workspace packages only; no lifecycle scripts.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @shopfloor/simulator...

FROM node:26.11.1-alpine3.23 AS runtime
ENV NODE_ENV=production \
    CONTROL_HOST=0.0.0.0 \
    MODBUS_HOST=0.0.0.0 \
    OPCUA_PKI_DIR=/var/lib/simulator/pki
WORKDIR /app
COPY --from=deps /app ./
COPY config/plant config/plant
COPY packages/contracts/src packages/contracts/src
COPY packages/oee-core/src packages/oee-core/src
COPY packages/plant-config/src packages/plant-config/src
COPY packages/shift-calendar/src packages/shift-calendar/src
COPY packages/sim-core/src packages/sim-core/src
COPY apps/simulator/src apps/simulator/src
RUN mkdir -p /var/lib/simulator/pki && chown node:node /var/lib/simulator/pki
USER node
EXPOSE 4800 4841 4842 4843 4844 4845 5020
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.CONTROL_PORT ?? 4800) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "apps/simulator/src/main.ts"]
