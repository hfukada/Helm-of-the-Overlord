# Stage 1: Install dependencies
FROM oven/bun:1 AS deps

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Stage 2: Runtime
FROM oven/bun:1-slim

USER root

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global user.email "hoto@localhost" \
    && git config --global user.name "hoto"

# Install Docker CLI (static binary -- no daemon, just the client for docker exec)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:$PATH"


RUN ln -s $(which bun) /usr/local/bin/node


WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY package.json bunfig.toml ./
COPY src/ src/
COPY Dockerfile.sandbox ./

COPY global_claude.md /root/.claude/CLAUDE.md

ENV HOTO_HOST=0.0.0.0
ENV HOTO_PORT=7777
ENV HOTO_WORKSPACE=/data

VOLUME /data
EXPOSE 7777

CMD ["bun", "run", "src/index.ts", "daemon", "__serve"]
