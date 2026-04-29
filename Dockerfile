FROM oven/bun:1.3-debian

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		git \
		iproute2 \
		openssh-client \
		procps \
		ripgrep \
		util-linux \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
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
CMD ["/usr/local/bin/bun", "server/web-server.ts"]
