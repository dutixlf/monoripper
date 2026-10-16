# Linux amd64, Bun 1.3.13, Debian/glibc. Update only with compatibility evidence.
FROM docker.io/oven/bun:1.3.13-debian@sha256:550178b0d9fefc73c8758eb1ee9bb7eff90747ba1008d80a5bb76695b3fd9265 AS base
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && mkdir -p /var/lib/monoripper /run/secrets \
    && chown 1000:1000 /var/lib/monoripper
COPY --from=build /app/dist ./dist
COPY examples/container ./example
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/app/dist/cli.js"]
CMD ["serve", "--config", "/app/example/monoripper.config.ts"]
