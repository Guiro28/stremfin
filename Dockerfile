FROM node:24-alpine3.24 AS node

FROM node AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Client web officiel de Jellyfin : servi sur /web (utilise par l'app Android et Jellyfin Media Player).
FROM jellyfin/jellyfin:10.11.11 AS jellyfin

FROM alpine:3.24

WORKDIR /app

RUN apk add --no-cache ca-certificates libstdc++ su-exec \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=jellyfin /jellyfin/jellyfin-web ./web
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node vendor ./vendor
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown node:node /app/data

ENV PORT=8096
ENV DATA_DIR=/app/data
EXPOSE 8096
EXPOSE 7359/udp

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
