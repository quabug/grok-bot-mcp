# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git gh procps python3 unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY runtime/package.json runtime/package-lock.json ./runtime/
RUN npm ci --prefix runtime --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY package.json LICENSE ./
COPY runtime/src/ ./runtime/src/
COPY agent-bridge/package.json agent-bridge/mcp-tools.js ./agent-bridge/
RUN mkdir -p /workspace /app/agent-bridge/outbox /app/agent-bridge/inbox /app/agent-bridge/sent \
    && chown -R node:node /workspace /app/agent-bridge

ENV NODE_ENV=production \
    GROK_BOT_MCP_ROOT=/app \
    GROK_BOT_MCP_GENERAL_ONLY=true \
    AI_PC_MCP_HOME=/app/runtime \
    AI_PC_MCP_HOST=0.0.0.0 \
    AI_PC_MCP_PORT=3851 \
    AI_PC_MCP_ROOT=/workspace \
    AI_PC_MCP_DEFAULT_CWD=/workspace \
    AI_PC_MCP_BYPASS=false

USER node
WORKDIR /workspace
EXPOSE 3851
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e 'fetch(`http://127.0.0.1:${process.env.AI_PC_MCP_PORT}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "/app/runtime/src/server.js"]
