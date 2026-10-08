FROM docker:28-cli AS docker-cli
FROM oven/bun:1.4.2

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENV NODE_ENV=production HOME=/tmp
USER bun
ENTRYPOINT ["bun", "src/server.ts"]
