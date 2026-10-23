# syncdeck — multi-arch image (amd64, arm64: Raspberry Pi 4/5).
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY examples ./examples

ENV NODE_ENV=production \
    SYNCDECK_HOST=0.0.0.0 \
    SYNCDECK_PORT=4321 \
    SYNCDECK_DATA=/data \
    SYNCDECK_STATE=/state \
    SYNCDECK_TRUST_PROXY=1

RUN mkdir -p /data /state && chown node:node /data /state
USER node
VOLUME ["/data", "/state"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:4321/health || exit 1

CMD ["node", "bin/syncdeck.js", "serve"]
