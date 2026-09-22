FROM node:22-alpine

WORKDIR /app


RUN apk add --no-cache wget





COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js worker.js ./



RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'URL="https://raw.githubusercontent.com/pingmike2/freebuff2api-wokers/main/worker.js"' \
  'if wget -q -T 20 -O /app/worker.js.tmp "$URL" && [ -s /app/worker.js.tmp ]; then' \
  '  mv /app/worker.js.tmp /app/worker.js' \
  '  echo "[entrypoint] worker.js updated"' \
  'else' \
  '  rm -f /app/worker.js.tmp' \
  '  echo "[entrypoint] fetch failed, keeping bundled worker.js"' \
  'fi' \
  'exec node /app/server.js' \
  > /app/entrypoint.sh && chmod +x /app/entrypoint.sh


RUN mkdir -p /app/credentials && chown -R node:node /app

USER node
EXPOSE 8787

ENTRYPOINT ["/app/entrypoint.sh"]
