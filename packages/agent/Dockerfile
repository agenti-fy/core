# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/

RUN pnpm fetch && \
    pnpm install --frozen-lockfile \
      --filter @agentify/shared... \
      --filter @agentify/agent...

COPY packages/shared/src packages/shared/src
COPY packages/agent/src packages/agent/src

RUN pnpm --filter @agentify/shared build && \
    pnpm --filter @agentify/agent build && \
    pnpm deploy --filter @agentify/agent --legacy /out

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WORKSPACES_DIR=/workspaces
# The Claude Code SDK's Bash tool refuses to execute commands when SHELL is
# unset OR points at a non-existent path. Alpine images don't set SHELL by
# default; we explicitly point at bash (installed below) so every gh / git /
# script invocation the model makes goes through a real POSIX shell.
ENV SHELL=/bin/bash

# tini for clean PID 1 signal handling. git for worktree ops. github-cli (gh)
# is the model's authenticated handle to the GitHub REST API — without it,
# skill prompts that say "create an issue / open a PR / post a review" have
# no tool that can actually do it. The credential helper authenticates git
# operations only; `gh` reads its token from GH_TOKEN env which the runner
# injects per-run from the App installation token cache. bash is required
# by the SDK's Bash tool (it explicitly rejects busybox sh).
RUN apk add --no-cache tini bash git github-cli

COPY --from=builder /out /app

# Non-root user. Agent needs to write into /workspaces (worktrees) and
# /app/.claude (Claude Code SDK conversation store — bind-mounted as a named
# volume in compose so sessions survive container recreates; the directory
# must exist with the right ownership at build time so Docker auto-populates
# the volume from it on first mount).
RUN addgroup -S agentify && adduser -S -G agentify -h /app agentify && \
    mkdir -p /workspaces /app/.claude && \
    chown -R agentify:agentify /app /workspaces
USER agentify

VOLUME ["/workspaces"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
