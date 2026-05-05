# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
RUN apk add --no-cache python3 make g++

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/coordinator/package.json packages/coordinator/tsconfig.json packages/coordinator/

RUN pnpm fetch && \
    pnpm install --frozen-lockfile \
      --filter @agentify/shared... \
      --filter @agentify/coordinator...

COPY packages/shared/src packages/shared/src
COPY packages/coordinator/src packages/coordinator/src

RUN pnpm --filter @agentify/shared build && \
    pnpm --filter @agentify/coordinator build && \
    pnpm deploy --filter @agentify/coordinator --legacy /out

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN apk add --no-cache tini

COPY --from=builder /out /app

# Non-root user for defense-in-depth.
RUN addgroup -S agentify && adduser -S -G agentify -h /app agentify && \
    mkdir -p /data && chown -R agentify:agentify /app /data
USER agentify

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
