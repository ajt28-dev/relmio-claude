# Claude Relay - private Docker sidecar for self-hosted n8n.
#
# Runs the same relay proven in Phases 1-3 (src/relay/main.js -> server.js ->
# providers/claude.js -> Claude Agent SDK -> Claude subscription). Build from
# the repository root:
#
#   docker build -f docker/claude-relay/Dockerfile -t claude-relay:local .
#
# No credential is ever baked into this image: CLAUDE_CODE_OAUTH_TOKEN and
# CLAUDE_RELAY_API_KEY arrive only through the container environment.

FROM node:22-bookworm-slim

# ca-certificates: outbound HTTPS from the bundled Claude runtime.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency manifests first for layer caching. The repository .npmrc keeps
# ignore-scripts=true; the Agent SDK's Linux runtime is an optional platform
# dependency (no install scripts), so npm ci installs it regardless.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY LICENSE NOTICE ./
COPY src ./src
COPY docker/claude-relay/verify-runtime.mjs ./verify-runtime.mjs

# Runtime defaults. The relay binds all interfaces INSIDE the container so
# other containers can reach it over Docker DNS; no host port is published.
ENV NODE_ENV=production \
    HOME=/home/node \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    CLAUDE_RELAY_HOST=0.0.0.0 \
    CLAUDE_RELAY_PORT=10532

# Prove the Linux Agent SDK runtime is present, executable, and runs - as the
# non-root runtime user - then drop the verifier from the image.
USER node
RUN node ./verify-runtime.mjs
USER root
RUN rm ./verify-runtime.mjs

EXPOSE 10532

# Process/config health only: /health is unauthenticated and never calls Claude.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:10532/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

USER node
ENTRYPOINT ["node", "src/relay/main.js"]
