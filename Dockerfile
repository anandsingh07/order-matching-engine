# One image build for the whole workspace, with a target per service:
#   docker build --target gateway -t ome-gateway .
# docker-compose.yml builds and runs all three.

FROM node:24-slim AS base
RUN npm install -g pnpm@10.34.8
WORKDIR /app

# Dependencies first, keyed on the lockfile alone, so a source change does not refetch them.
FROM base AS source
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

# Each service runs node directly (not through pnpm), so SIGTERM from
# "docker stop" reaches it and the gateway shuts down cleanly: in-flight
# commands finish and the journal is synced.

FROM source AS gateway
WORKDIR /app/services/gateway
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM source AS bots
WORKDIR /app/services/bots
ENTRYPOINT ["node", "--import", "tsx", "src/main.ts", "--url=http://gateway:8080"]

# The browser calls the gateway directly, so its public URL is fixed at build time.
FROM source AS terminal
WORKDIR /app/apps/terminal
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL NEXT_TELEMETRY_DISABLED=1
RUN ./node_modules/.bin/next build
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "--port", "3000"]
