# ── 建置階段：snapshot/ + content/ + src/ → public/ ──────────────
# build.mjs 零相依，所以不需要 npm install，建置很快。
FROM node:22-alpine AS build

WORKDIR /app
COPY src/ ./src/
COPY content/ ./content/
COPY snapshot/ ./snapshot/
COPY scripts/build.mjs ./scripts/

RUN node scripts/build.mjs

# ── 服務階段：Caddy 提供靜態檔案 ────────────────────────────────
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/public /srv

# 提早驗證設定檔：寫錯時在建置階段就失敗，而不是部署後才掛掉
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
