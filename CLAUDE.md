# Discord Volley — project shortcuts for agents

## Команды

```bash
npm test             # node --test tests/*.test.js — интеграция через spawn server.js
npm run test:e2e     # playwright test — desktop-chrome + mobile-chrome
npx playwright install chromium   # первый запуск
```

Dev-login для локальных/интеграционных тестов: `GET /dev/login?id=<userId>&name=<name>`
(активен при `DV_DEV_LOGIN=1`).

## Harness

`tests/helpers/harness.js` поднимает реальный `server.js` child-процессом на
свободном порту с уникальным `DATA_DIR` на прогон, dummy secrets и
`DV_DEV_LOGIN=1`. Параллельное исполнение node:test безопасно —
sqlite-файлы не пересекаются.

Env-оверрайды, которые тесты используют:

- `STATS_INTERVAL_MS` — частота stats-broadcast (дефолт 2000, тесты ставят 400).
- `QUEUE_TIMEOUT_MS` — fallback-в-бот таймер (дефолт 10000, тесты ставят 400-5000).
- `WALLET_RALLY_MAX` — per-match cap rally.hit (дефолт 200, тесты ставят 5).
- `WALLET_MATCHWIN_GLOBAL_MS` — global cooldown match.win (дефолт 30000, тесты 800).
- `TEST_REDIS_URL` — skip-gate для redis-broker.test.js и будущих cluster-тестов.

## Wire-format и БД

Править wire-format (JSON-типы фреймов) и схему БД — по договору только в
отдельных PR с миграцией. Env-оверрайды выше — это внутренний конфиг,
default = прод-поведение.

## Где что живёт

- `server.js` — HTTP + WebSocket + wallet + matchmaking вокруг broker.
- `broker.js` — LocalBroker (single-instance, in-memory) + RedisBroker (cluster).
- `game.js` — клиент: ввод, физика, AI, рендер, WS-клиент, UI.
- `auth.js` — сессии через cookie-signature, Discord OAuth + dev-login.
- `tests/helpers/harness.js` — spawn-harness для интеграции.
- `tests/e2e/*.spec.js` — Playwright (webServer через `playwright.config.js`).
- `.omc/prd.json` — текущий PRD user-stories (night-run).
- `.omc/plans/night.md` — приоритизированный backlog.
- `.omc/plans/blockers.md` — что отложено и почему.

## Решённые баги-ориентиры (куда смотреть при regression)

- **leave → ws.roomId оставшегося пира** (коммит 4f9c650): `server.js` leaveRoom
  чистит ws.roomId у локальных пиров, `broker.js` RedisBroker снифает peer_left
  frame для той же цели в cross-instance. Тест: `tests/replay-race.test.js`.
- **queue_timeout посреди матча** (ec614f1): `_queueTimer` чистится на
  pairLocal. Тест: `tests/queue-timeout-regression.test.js`.
- **onPeerLeft → двойной форфейт-трофей** (18670f6): broker.claimOutcome
  кросс-отказывает противоположный outcome. Тесты: `tests/broker.test.js`,
  `tests/server-leave.test.js`.
- **Пустой canvas после replay** (065d81e): resizeCanvas rAF-throttle +
  onPeerLeft matchOver-ветка. Тесты: `tests/e2e/replay.spec.js`,
  `tests/e2e/resize-throttle.spec.js`.

## Push-policy

- **Пушить сразу после каждого коммита** (`git push` в свою ветку) — пользователь
  хочет, чтобы любое локальное обновление немедленно уходило на remote.

## Не делать

- Не трогать wire-format / БД без миграции.
- Не добавлять `setTimeout(..., 500)` в тесты — искать источник race и
  закрывать через `waitFor`/`collectFor`.
