FROM node:22-alpine

WORKDIR /app

# package-lock.json — чтобы npm ci поднял тот же граф зависимостей, что и
# локально. Без него npm ci упадёт, и тогда это откатится к npm install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# --experimental-sqlite: node:sqlite на Node 22 требует флаг (в 24 он уже
# стабилен, флаг остаётся совместимо-проходным). Перенесёт весь лидерборд
# и кошельки с data/leaderboard.json на data/volley.sqlite при первом старте.
CMD ["node", "--experimental-sqlite", "server.js"]
