# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/

RUN pnpm fetch && \
    pnpm install --frozen-lockfile \
      --filter @agenti-fy/shared... \
      --filter @agenti-fy/agent...

COPY packages/shared/src packages/shared/src
COPY packages/agent/src packages/agent/src

RUN pnpm --filter @agenti-fy/shared build && \
    pnpm --filter @agenti-fy/agent build && \
    pnpm deploy --filter @agenti-fy/agent --legacy /out

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

# Bake the nine default soul files into the image at a known path. The
# wizard-generated docker-compose.yml points each persona's `SOUL_PATH` env
# at `/app/souls/<persona>.md`, sidestepping bind-mounts entirely. Necessary
# because macOS Endpoint Security (Sonoma+) attaches the sticky
# `com.apple.provenance` xattr to files written by signed binaries (Node.js
# included), which Docker Desktop's virtiofs layer then rejects with `EPERM`
# on `open` regardless of file mode — the bind-mounted file becomes
# unreadable inside the container even with `chmod 0644`. `xattr -c` doesn't
# clear it on Sonoma+ (the xattr is kernel-managed, not user-space).
# In-tree `docker-compose.yml` still bind-mounts from `souls/<persona>.md`
# (souls come from git checkout, no xattr) so dev workflow is unchanged.
COPY souls /app/souls

# Install the agentify-kb shim.  Must run as root (writing to /usr/local/bin).
# Placed late in the runtime stage so unrelated code changes don't bust the
# layer.  The shim hard-codes the production path of the compiled CLI module
# so it works regardless of the invoking directory.
RUN cat >/usr/local/bin/agentify-kb <<'EOF' && chmod +x /usr/local/bin/agentify-kb
#!/usr/bin/env bash
exec node /app/dist/kb/cli.js "$@"
EOF

# Non-root user. Agent needs to write into /workspaces (worktrees) and
# /app/.claude (Claude Code SDK conversation store — bind-mounted as a named
# volume in compose so sessions survive container recreates; the directory
# must exist with the right ownership at build time so Docker auto-populates
# the volume from it on first mount).
RUN addgroup -S agentify && adduser -S -G agentify -h /app agentify && \
    mkdir -p /workspaces /app/.claude && \
    chown -R agentify:agentify /app /workspaces
USER agentify

# Smoke-test: verify the shim resolves and exits 0 as the agentify non-root
# user.  KB_CLONE_DIR is intentionally unset so every sub-command that needs
# it falls back to "KB unavailable → exit 0", making --help the safest choice.
RUN agentify-kb --help

VOLUME ["/workspaces"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
