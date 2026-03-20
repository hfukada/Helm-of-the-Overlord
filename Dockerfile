# Stage 1: Install dependencies
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY src/web/package.json src/web/bun.lock src/web/
RUN cd src/web && bun install --frozen-lockfile

# Stage 2: Build web UI
FROM deps AS web-build

COPY src/web/ src/web/
RUN cd src/web && bun run build

# Stage 3: Runtime
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (requires ANTHROPIC_API_KEY at runtime)
RUN bun install -g @anthropic-ai/claude-code

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/src/web/node_modules src/web/node_modules
COPY --from=web-build /app/src/web/dist src/web/dist
COPY package.json bunfig.toml ./
COPY src/ src/

ENV HOTO_HOST=0.0.0.0
ENV HOTO_PORT=7777
ENV HOTO_WORKSPACE=/data

VOLUME /data
EXPOSE 7777

CMD ["bun", "run", "src/index.ts", "daemon", "__serve"]
