FROM node:24-slim AS base

# Prisma's query engine needs libssl present at generate time to detect the
# right binary target (node:24-slim/Debian bookworm ships OpenSSL 3.x, not
# 1.1) — without this, generate silently defaults to the wrong engine binary
# and the container fails at runtime with "libssl.so.1.1: cannot open shared
# object file".
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @potato-corner/shared build
RUN pnpm --filter @potato-corner/api exec prisma generate
RUN pnpm --filter @potato-corner/api build

WORKDIR /app/apps/api

EXPOSE 4000

CMD ["node", "dist/server.js"]
