# Stage 7 — Railway / Hathora Split

> Разделение монолита `server.js` на API-ноду (Railway) и эфемерный room-runtime (Hathora).
> Каждый Stage — один коммит, одна env-gated киллер-функция. Откат = убрать / не ставить env-флаг.

---

## Context

- **Прод**: netcode DV_AUTH_PHYSICS=1 на Railway с 2026-04-20, пользователи играют.
- **Цель**: вынести WS + бинарный codec + серверную физику в отдельный Hathora room-process, оставив на Railway HTTP/OAuth/sqlite/matchmaking/статику.
- **Инвариант**: `DV_ROOMS=local` (дефолт) = текущее поведение, ничего не ломается. `DV_ROOMS=hathora` = новый путь.

## Guardrails

### Must Have
- Каждый Stage деплоится независимо и не ломает прод при дефолтных env.
- Wire-format изменения — только с backward-compatible fallback на клиенте.
- Все существующие тесты проходят на каждом Stage без правок (кроме тех, которые Stage явно расширяет).

### Must NOT Have
- Не менять sqlite-схему (db.js) — остаётся на Railway as-is.
- Не трогать broker.js Redis-логику (enqueue/dequeue/publishPair) на этапах до Stage 7.5.
- Не удалять старый room-путь до полного smoke-pass на Hathora.

---

## Task Flow

### Stage 7.1 — Extract room-server entry point

**Что делает**: Выносит WS-сервер + shadowsim + relay-логику в отдельный файл `room-server.js`, который может запускаться как standalone процесс. Не меняет server.js — просто создаёт параллельный entry point, переиспользуя существующий код.

**Файлы**:
- `room-server.js` (новый) — standalone WS-сервер: принимает WS-коннекты, валидирует join-token, гоняет ShadowRegistry (authoritative), relay emote, отправляет match-result webhook.
- `room-auth.js` (новый) — `signRoomToken(secret, {userId, roomId, role, matchId})` / `verifyRoomToken(secret, token)` на HMAC-SHA256. Shared между Railway и room-server.
- `server.js` — без изменений.

**Acceptance criteria**:
- `node room-server.js --port 9000 --secret testkey` стартует, слушает WS на `/ws`, логирует ready.
- Unit-тест `tests/room-auth.test.js`: sign → verify round-trip, tampered token → reject, expired token → reject (TTL 60s).
- `room-server.js` импортирует `shadowsim.js`, `codec.js`, `physics.js` — ровно тот же код, что прод.

**Как откатывается**: Файл не используется, пока `DV_ROOMS` не переключён.

**Критерий перехода к 7.2**: room-server.js стартует, принимает WS, unit-тест room-auth проходит.

---

### Stage 7.2 — DV_ROOMS router in server.js

**Что делает**: Добавляет в `server.js` ветвление по `DV_ROOMS` (env). При `DV_ROOMS=hathora` matchmaking после pair вместо локального join создаёт Hathora-комнату через REST API, получает `{host, port}`, подписывает room-token для каждого клиента и отдаёт расширенный `matched`-фрейм. При `DV_ROOMS=local` (дефолт) — старый путь, код не трогается.

**Файлы**:
- `server.js` — новая функция `pairHathora(host, guest)` рядом с существующей `pairLocal`; `onQueue` вызывает одну из двух по `DV_ROOMS`. Расширенный `matched`-фрейм: `{ ...existing, roomHost, roomPort, roomToken }`.
- `hathora-client.js` (новый) — обёртка `createRoom(appId, region, roomConfig)` → `{roomId, host, port}` через Hathora REST API `POST /rooms/v2/{appId}/create`. Env: `HATHORA_APP_ID`, `HATHORA_TOKEN`.
- `room-auth.js` — без изменений (уже создан в 7.1).

**Acceptance criteria**:
- При `DV_ROOMS=local` (дефолт) — `npm test` проходит без изменений.
- При `DV_ROOMS=hathora` + мок Hathora API — pairHathora генерирует matched-фрейм с `roomHost`/`roomPort`/`roomToken`.
- Тест `tests/rooms-router.test.js`: stub Hathora API (nock или simple HTTP mock), два клиента queue → оба получают matched с roomHost.

**Как откатывается**: `DV_ROOMS=local` или не задан.

**Критерий перехода к 7.3**: тест rooms-router проходит с мок-Hathora, все старые тесты зелёные.

---

### Stage 7.3 — Client-side dual-connect

**Что делает**: Клиент (`game.js`) при получении `matched` с `roomHost` открывает второй WS на Hathora room-server для gameplay, отправляя `roomToken` первым фреймом. Без `roomHost` — старое поведение (gameplay через location.host). Menu-WS на Railway остаётся для lobby/stats/wallet/trophies.

**Файлы**:
- `game.js` — в обработчике `matched`: если `msg.roomHost`, открыть `wss://msg.roomHost:msg.roomPort/ws`, отправить `{type:"join", token: msg.roomToken}`, перенаправить input/state на этот сокет. Без `roomHost` — текущий путь. Emote relay: через room-WS если он есть, иначе через menu-WS.
- `room-server.js` — обработка первого фрейма `{type:"join", token}`: verify, привязать userId/role, attachPeer в ShadowRegistry. Reject = close(4401).

**Acceptance criteria**:
- Ручной smoke в браузере: `DV_ROOMS=local` — оба клиента играют через один WS как раньше.
- E2E тест `tests/e2e/dual-connect.spec.js` (DV_ROOMS=local, пока без Hathora): два клиента queue → matched без roomHost → gameplay работает.
- Wire-format backward-compatible: клиент без обновления (кеш) получает matched без roomHost — ведёт себя как раньше.

**Как откатывается**: `DV_ROOMS=local`.

**Критерий перехода к 7.4**: E2E dual-connect проходит, старые E2E зелёные.

---

### Stage 7.4 — DV_LOCAL_ROOMS=1 — in-process room-server for tests

**Что делает**: Для интеграционного и E2E тестирования без живого Hathora: при `DV_LOCAL_ROOMS=1` server.js при pairHathora поднимает `room-server.js` как child-process (или in-process WS-сервер) на свободном порту, вместо вызова Hathora REST API. Клиенты получают `roomHost=127.0.0.1`, `roomPort=<free-port>`.

**Файлы**:
- `server.js` — в `pairHathora`: если `DV_LOCAL_ROOMS=1`, spawn `room-server.js` на free port вместо Hathora API. Передать `ROOM_SECRET`, `MATCH_ID`, etc через env/args.
- `tests/helpers/harness.js` — опциональный `extraEnv: { DV_ROOMS: "hathora", DV_LOCAL_ROOMS: "1" }`.
- `tests/hathora-flow.test.js` (новый) — полный цикл: два клиента → queue → matched с roomHost → WS к room-server → gameplay snapshot → match-result webhook.

**Acceptance criteria**:
- `DV_ROOMS=hathora DV_LOCAL_ROOMS=1 npm test` — hathora-flow.test.js проходит.
- `DV_ROOMS=local npm test` (дефолт) — все старые тесты проходят.
- Room-server child-process умирает после матча или timeout 5min (предохранитель).

**Как откатывается**: `DV_ROOMS=local`.

**Критерий перехода к 7.5**: hathora-flow integration test проходит end-to-end с локальным room-server.

---

### Stage 7.5 — Match-result webhook + broker cleanup

**Что делает**: Room-server по завершении матча POST-ит результат на Railway: `POST /internal/match-result` с HMAC-подписью. Railway применяет `applyMatchOutcome` по этому webhook вместо client-driven `match_win`/`match_loss`. Broker: при `DV_ROOMS=hathora` pub/sub по комнате (publishRoom, joinRoom, leaveRoom) не используется — комната живёт внутри одного room-server процесса. Matchmaking (enqueue/dequeue/publishPair/stakes) остаётся на Railway.

**Файлы**:
- `room-server.js` — при matchOver=true: POST `{matchId, winnerId, loserId, score1, score2}` на `RAILWAY_CALLBACK_URL + "/internal/match-result"` с HMAC header `X-Room-Signature`.
- `server.js` — новый Express route `POST /internal/match-result`: verify HMAC, вызвать `applyMatchOutcome` для winner (win) и loser (loss), отправить trophies-фрейм обоим через их menu-WS (они всё ещё подключены к Railway для lobby).
- `server.js` — при `DV_ROOMS=hathora`: `pairHathora` не вызывает `broker.joinRoom`, не регистрирует shadow — всё это делает room-server.
- `broker.js` — без изменений (pub/sub просто не вызывается в hathora-пути).

**Acceptance criteria**:
- Тест `tests/match-result-webhook.test.js`: POST с валидной HMAC → 200 + trophies applied; POST с невалидной HMAC → 401.
- `tests/hathora-flow.test.js` расширен: после match-over room-server шлёт webhook → Railway начислил trophies → оба клиента получили trophies-фрейм через menu-WS.
- Старый путь (`DV_ROOMS=local`): match_win/match_loss через клиент → работает как раньше.

**Как откатывается**: `DV_ROOMS=local`.

**Критерий перехода к 7.6**: webhook integration test проходит, trophies корректно начисляются через webhook.

---

### Stage 7.6 — Production deploy + decommission flag

**Что делает**: Deploy room-server.js на Hathora (Dockerfile / hathora.toml). Railway переключается на `DV_ROOMS=hathora` в продовых env. Добавлен `DV_ROOMS_ROLLBACK=1` — мгновенный откат на Railway без редеплоя room-server.

**Файлы**:
- `Dockerfile.room` или `hathora.toml` (новый) — билд/конфиг для Hathora deploy. Entry: `node room-server.js`.
- `server.js` — `DV_ROOMS_ROLLBACK=1` форсит `roomMode = "local"` даже если `DV_ROOMS=hathora`.
- Документация: `.omc/plans/stage7-deploy-checklist.md` — пошаговый чеклист для переключения.

**Acceptance criteria**:
- На staging (Railway + Hathora): два клиента играют матч, trophies начислены через webhook.
- Откат: `DV_ROOMS_ROLLBACK=1` на Railway → следующие матчи идут через old path, room-server idle.
- Мониторинг: room-server логирует match lifecycle (open, peer-join, match-over, webhook-sent, exit).

**Как откатывается**: `DV_ROOMS_ROLLBACK=1` на Railway или `DV_ROOMS=local`.

**Критерий готовности**: smoke-pass на staging, 24h soak без ошибок.

---

## Success Criteria (overall)

1. Все 8 существующих integration test файлов проходят на каждом Stage при `DV_ROOMS=local`.
2. Новые тесты (room-auth, rooms-router, hathora-flow, match-result-webhook) покрывают hathora-путь.
3. Wire-format изменение (roomHost/roomPort/roomToken в matched) backward-compatible: старый клиент без полей ведёт себя как раньше.
4. Нет SQLite на room-server — вся персистентность на Railway.
5. Rollback в прод за < 1 минуту через env-переключатель.

## Open architecture decisions captured

- **Region selection**: Stage 7.2 pairHathora хардкодит один регион на старте (e.g. `Frankfurt`). RTT-based region picker — follow-up задача, не блокер для split.
- **Room-server scale-down**: Hathora убивает idle rooms автоматически. Внутренний timeout 5min в room-server.js — предохранитель.
- **Wallet awards (rally.hit, round.win)**: на Stage 7.5 только trophies через webhook. Coin awards (rally.hit/combo) продолжают идти через menu-WS client-driven как сейчас. Перенос coin awards в room-server — follow-up.
- **Cross-instance pair (Redis broker)**: при `DV_ROOMS=hathora` cross-instance pair работает: оба Railway-инстанса имеют доступ к Hathora API. publishPair по-прежнему нужен для matchmaking, но pub/sub по комнате — нет.
