# Operators supply and record an immutable BASE_IMAGE digest for deployments.
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates chromium curl git openssh-client python3 ripgrep procps fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.8.0 --activate \
    && mkdir -p /opt/opengui-tools /home/opengui
COPY shell-tools.package.json /opt/opengui-tools/package.json
COPY shell-tools.pnpm-lock.yaml /opt/opengui-tools/pnpm-lock.yaml
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm --dir /opt/opengui-tools install --frozen-lockfile --ignore-scripts \
    && pnpm store prune
ENV HOME=/home/opengui \
    CHROMIUM_PATH=/usr/bin/chromium \
    OPENGUI_PLAYWRIGHT_MODULE=/opt/opengui-tools/node_modules/playwright/index.mjs \
    PATH=/opt/opengui-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
    ASTRO_TELEMETRY_DISABLED=1
WORKDIR /workspace
CMD ["/bin/sh"]
