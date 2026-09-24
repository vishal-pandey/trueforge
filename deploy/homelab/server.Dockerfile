# Homelab server image: the published upstream image for the base release, with this fork's
# rebuilt server/core/frontend bundles and extra runtime deps overlaid.
#
# Why an overlay: the homelab's kubelet pulls large GHCR images very slowly (serially, blocking
# other apps) while tfy.jfrog.io is fast, so only the small fork delta ships through GHCR.
# Bump BASE_IMAGE together with the fork's upstream rebase.
ARG BASE_IMAGE=tfy.jfrog.io/tfy-images/trueforge:0.2.1-de68a16

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && pnpm config set store-dir /pnpm/store
WORKDIR /app

FROM base AS store
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Same build stages as the repo's Dockerfile.dev (keep in sync on upstream rebase).
FROM store AS workspace
COPY package.json .npmrc tsconfig.base.json ./
COPY scripts scripts
COPY packages/trueforge-core/package.json packages/trueforge-core/package.json
COPY packages/trueforge/package.json packages/trueforge/package.json
COPY packages/trueforge-sdk/package.json packages/trueforge-sdk/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY packages/trueforge-ui/package.json packages/trueforge-ui/package.json
COPY packages/trueforge-core/scripts packages/trueforge-core/scripts
COPY packages/trueforge-core/src/core/sandbox/scripts packages/trueforge-core/src/core/sandbox/scripts

FROM workspace AS builder
RUN pnpm install --frozen-lockfile --offline --filter @truefoundry/trueforge...
COPY packages/trueforge-core packages/trueforge-core
COPY packages/trueforge-sdk packages/trueforge-sdk
RUN pnpm --filter @truefoundry/trueforge-sdk build
COPY packages/trueforge packages/trueforge
RUN pnpm --filter @truefoundry/trueforge-core build && pnpm --filter @truefoundry/trueforge build

FROM workspace AS frontend-builder
RUN pnpm install --frozen-lockfile --offline --filter frontend...
COPY packages/trueforge-sdk packages/trueforge-sdk
COPY packages/trueforge-ui packages/trueforge-ui
RUN pnpm --filter @truefoundry/trueforge-ui build
COPY packages/frontend packages/frontend
RUN pnpm --filter frontend build

# Runtime deps the fork adds on top of the base release (resolved from trueforge-core's dist).
# Nested install keeps client-node's own deps (e.g. undici 8) under it, so core's pinned
# undici 7 at /app/node_modules is not shadowed.
FROM node:24-slim AS extra-deps
WORKDIR /deps
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund --install-strategy=nested @kubernetes/client-node@2.0.0

FROM ${BASE_IMAGE}
USER root
COPY --from=builder /app/packages/trueforge-core/dist /app/node_modules/@truefoundry/trueforge-core/dist
COPY --from=builder /app/packages/trueforge/dist /app/node_modules/@truefoundry/trueforge/dist
COPY --from=frontend-builder /app/packages/frontend/dist /app/node_modules/@truefoundry/trueforge/dist/_frontend
COPY --from=extra-deps /deps/node_modules/@kubernetes /app/node_modules/@truefoundry/trueforge-core/node_modules/@kubernetes
USER 10001:10001
