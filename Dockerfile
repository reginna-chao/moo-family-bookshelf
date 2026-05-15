FROM node:22-slim AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.0.8 --activate

WORKDIR /app

# Copy workspace config and lockfiles first (cache-friendly layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY extension/package.json extension/pnpm-lock.yaml* ./extension/
COPY worker/package.json worker/pnpm-lock.yaml* ./worker/

# Install dependencies (cached unless package.json changes)
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# --- Extension dev ---
FROM base AS extension-dev
WORKDIR /app/extension
CMD ["pnpm", "dev"]

# --- Worker dev ---
FROM base AS worker-dev
WORKDIR /app/worker
CMD ["pnpm", "dev"]
