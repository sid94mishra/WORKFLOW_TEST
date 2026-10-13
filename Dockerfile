FROM node:22-alpine3.24 AS base
RUN corepack enable
WORKDIR /repo

FROM node:22-alpine3.24 AS build
RUN corepack enable && apk add --no-cache python3~=3.14 make~=4.4 g++~=15.2
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/checker/package.json packages/checker/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm -r build && pnpm --filter @pulse/api deploy --prod --legacy /out && cp -R apps/web/dist /out/web

FROM node:22-alpine3.24 AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/pulse.db PULSE_WEB_DIR=/app/web
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
