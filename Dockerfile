# 純靜態網站：用 Caddy 直接服務 public/，不需要任何建置步驟。
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY public/ /srv/

# 提早驗證設定檔，設定寫錯時在建置階段就會失敗，而不是部署後才掛掉
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
