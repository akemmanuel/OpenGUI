FROM node:24-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		curl \
		git \
		iproute2 \
		openssh-client \
		procps \
		ripgrep \
		unzip \
		util-linux \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV BUN_INSTALL=/root/.bun
ENV PATH=/app/node_modules/.bin:$PNPM_HOME:$BUN_INSTALL/bin:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
RUN curl -fsSL https://bun.sh/install | bash

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN vp build
COPY docker/host-exec /usr/local/bin/opengui-host-exec
COPY docker/entrypoint.sh /usr/local/bin/opengui-entrypoint
RUN chmod +x /usr/local/bin/opengui-host-exec /usr/local/bin/opengui-entrypoint \
	&& mkdir -p /usr/local/host-bin \
	&& for cmd in git opencode claude codex pi bun node npm python python3 bash sh rg fd make gcc g++; do ln -sf /usr/local/bin/opengui-host-exec /usr/local/host-bin/$cmd; done

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV OPENGUI_ALLOWED_ROOTS=/workspace

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/opengui-entrypoint"]
CMD ["/root/.bun/bin/bun", "server/web-server.ts"]
