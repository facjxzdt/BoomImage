FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml pnpm-lock.yaml
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY migrations migrations

RUN pnpm --filter @boomimage/web build \
  && pnpm --filter @boomimage/server build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=3000 \
    APP_DATA_DIR=/data \
    MIGRATIONS_DIR=/app/migrations \
    WEB_DIST_DIR=/app/apps/web/dist

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/migrations ./migrations

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

CMD ["node", "apps/server/dist/server.js"]
