# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# pg_dump / pg_restore for backups, and the server binaries (postgres, pg_basebackup, pg_archivecleanup) for point-in-time
# recovery, which replays WAL in a short-lived scratch server. Keep the major version equal to the Postgres server's.
# No cluster is created: nothing here runs a database except during a recovery. en_US.UTF-8 is the locale the official
# postgres image creates databases with, and a recovery server cannot open them without it.
RUN mkdir -p /etc/postgresql-common && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-15 locales && rm -rf /var/lib/apt/lists/* \
 && sed -i '/^# *en_US.UTF-8 UTF-8/s/^# *//' /etc/locale.gen && locale-gen en_US.UTF-8
WORKDIR /app
ENV NODE_ENV=production BAAS_PG_BIN_DIR=/usr/lib/postgresql/15/bin \
    BAAS_STORAGE_DIR=/data/storage BAAS_BACKUP_DIR=/data/backups BAAS_PITR_BASE_DIR=/data/pitr/base BAAS_PITR_SCRATCH_DIR=/data/pitr/scratch
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY dashboard ./dashboard
COPY bin ./bin
RUN mkdir -p /data/storage /data/backups /data/pitr && chown -R node:node /data
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
