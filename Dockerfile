# Multi-arch index digest, taken 2026-10-28; the tag is kept for readability.
# Refresh with `docker buildx imagetools inspect node:22-slim`.
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS base

# Not corepack: a signing-key rotation broke older corepack outright, the "come back years later" case this image is for.
# Version mirrors root package.json `packageManager`; worker/tests/unit/nodeEngineFloor.test.ts pins the two equal.
RUN npm install -g pnpm@11.1.2

WORKDIR /app

# Whole context, so no workspace package can be left out of the install.
# Gives up the install-layer cache; acceptable for a rarely rebuilt image.
COPY . .

# No `|| pnpm install` fallback: a failed frozen install must fail the build, not re-resolve.
RUN pnpm install --frozen-lockfile

# --- Extension dev ---
FROM base AS extension-dev
WORKDIR /app/extension
CMD ["pnpm", "dev"]

# --- Worker dev ---
FROM base AS worker-dev
WORKDIR /app/worker
CMD ["pnpm", "dev"]

# --- PWA dev (Vite already listens on all interfaces: `server.host: true`) ---
FROM base AS pwa-dev
WORKDIR /app/pwa
CMD ["pnpm", "dev"]
