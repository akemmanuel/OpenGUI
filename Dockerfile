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

ENV PATH=/app/node_modules/.bin:$PATH

COPY . .
RUN corepack enable \
	&& corepack prepare pnpm@11.8.0 --activate \
	&& pnpm install --frozen-lockfile \
	&& pnpm vp build
COPY docker/host-exec /usr/local/bin/opengui-host-exec
COPY docker/entrypoint.sh /usr/local/bin/opengui-entrypoint
RUN chmod +x /usr/local/bin/opengui-host-exec /usr/local/bin/opengui-entrypoint \
	&& mkdir -p /usr/local/host-bin /workspace \
	&& for cmd in node npm pnpm python python3 bash sh rg fd make gcc g++; do ln -sf /usr/local/bin/opengui-host-exec /usr/local/host-bin/$cmd; done

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV OPENGUI_ALLOWED_ROOTS=/workspace

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/opengui-entrypoint"]
CMD ["/usr/local/bin/node", "--experimental-strip-types", "server/web-server.ts"]
