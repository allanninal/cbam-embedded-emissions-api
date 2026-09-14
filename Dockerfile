# syntax=docker/dockerfile:1
#
# Multi-stage build:
#   - builder:  Node toolchain to compile better-sqlite3 and run the static build;
#               produces dist/ and pruned production node_modules.
#   - runtime:  slim, no compiler, runs as the non-root `node` user.
#
# The CBAM calculator is pure JS (lookup + arithmetic) — no external engine binary
# is needed. Base images pinned to specific patch tags for reproducibility.
FROM node:20.18.1-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install workspace deps (layer-cached on manifests).
COPY package.json package-lock.json* ./
COPY packages/lib/package.json packages/lib/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm install --omit=optional

# Build the static dist/.
COPY . .
ARG BASE_PATH=""
ENV BASE_PATH=${BASE_PATH}
RUN npm run build

# Prune dev dependencies so only production deps are carried to runtime.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
FROM node:20.18.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8792 \
    STATIC_DIR=/app/dist \
    DB_PATH=/data/cbam.sqlite \
    DATA_DIR=/app/data \
    TMP_DIR=/tmp

WORKDIR /app

# Only what the runtime needs (no compiler, no dev deps, no build context).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/schemas ./schemas
COPY --from=builder /app/data ./data

# Data dir owned by the non-root user (SQLite writes here).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8792
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8792)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/src/server.mjs"]
