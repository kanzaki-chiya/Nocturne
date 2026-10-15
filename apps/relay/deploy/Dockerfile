FROM node:24.21.0-bookworm-slim

ARG RELAY_TGZ
COPY ${RELAY_TGZ} /tmp/nocturne-relay.tgz
RUN npm install --global /tmp/nocturne-relay.tgz \
    && rm -f /tmp/nocturne-relay.tgz \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data

ENV NOCTURNE_RELAY_DATA_DIR=/data \
    NOCTURNE_RELAY_LISTEN=0.0.0.0:8787
VOLUME /data
USER node
EXPOSE 8787
CMD ["nocturne-relay", "serve"]
