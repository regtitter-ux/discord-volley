FROM caddy:2-alpine
WORKDIR /srv
COPY index.html styles.css auth.js game.js i18n.js /srv/
COPY assets /srv/assets
COPY Caddyfile /etc/caddy/Caddyfile
