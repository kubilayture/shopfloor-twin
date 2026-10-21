# Web app: the Vite build of apps/web served by nginx, which proxies /api (REST and the WebSocket
# at /api/v1/ws) to the MES and, since #237, the console's allowlisted /sim/ routes to the
# simulator's control API with SIM_CONTROL_TOKEN (non-root). HTTPS only on 8443 since P9-14
# (ADR-0039): the certificate and key come from the pki step's `web-tls` volume at /etc/nginx/tls.
# Build from the repository root: docker build -f apps/web/Dockerfile .
# The workspace packages copied below must match the app's dependencies:
# `node scripts/check-dockerfiles.ts` (part of `pnpm verify`) checks it.

FROM node:26.11.1-alpine3.23 AS base
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@12.11.2
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/oee-core/package.json packages/oee-core/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/fc-seed/package.json packages/fc-seed/
COPY packages/tsconfig/package.json packages/tsconfig/
# The build needs the app's dev dependencies (Vite, Tailwind), which take in the dev dependencies
# of its workspace packages (`contracts` → `fc-seed`); no lifecycle scripts.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @shopfloor/web...
COPY packages/tsconfig/base.json packages/tsconfig/
COPY packages/contracts/src packages/contracts/src
COPY packages/oee-core/src packages/oee-core/src
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts apps/web/
COPY apps/web/src apps/web/src
RUN pnpm --filter @shopfloor/web build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24 AS runtime
# The server is a template (#237): the image's entrypoint renders it into conf.d at start with
# SIM_CONTROL_TOKEN, the only variable substituted, after checking that the token is set (the
# check script is executable in the repository; COPY keeps the mode, the classic builder has no
# --chmod).
ENV NGINX_ENVSUBST_FILTER=^SIM_CONTROL_TOKEN$
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY apps/web/nginx/sim-proxy.conf /etc/nginx/snippets/sim-proxy.conf
COPY apps/web/nginx/mes-headers.conf /etc/nginx/snippets/mes-headers.conf
COPY apps/web/nginx/15-require-sim-token.sh /docker-entrypoint.d/15-require-sim-token.sh
COPY apps/web/nginx/16-require-tls.sh /docker-entrypoint.d/16-require-tls.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8443
# Over HTTPS, verifying the certificate against the dev CA for the name localhost: a missing,
# foreign or misnamed certificate makes the container unhealthy.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD ["curl", "-fsS", "-o", "/dev/null", "--cacert", "/etc/nginx/tls/ca.pem", "https://localhost:8443/healthz"]
# SIGTERM is nginx's fast shutdown. A graceful SIGQUIT would wait for open WebSockets (a browser
# tab keeps one open) until Docker kills the container; the app reconnects either way.
STOPSIGNAL SIGTERM
