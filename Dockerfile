# Stage 1: Install dependencies
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Stage 2: Runtime
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN bun install -g @anthropic-ai/claude-code

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY package.json bunfig.toml ./
COPY src/ src/

ENV HOTO_HOST=0.0.0.0
ENV HOTO_PORT=7777
ENV HOTO_WORKSPACE=/data

VOLUME /data
EXPOSE 7777

CMD ["bun", "run", "src/index.ts", "daemon", "__serve"]
