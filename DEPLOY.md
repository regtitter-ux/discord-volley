# Discord Volley — deploy (Railway + Hathora)

## Roles

- **Railway** (long-living API-node): OAuth, sqlite, wallet, matchmaking,
  статик, `/internal/match-result` webhook. Строится из корневого
  [`Dockerfile`](Dockerfile), entry — `server.js`.
- **Hathora** (ephemeral spawn-per-match, 1 container = 1 match):
  `room-server.js` + authoritative physics + WS binary codec. Строится из
  [`Dockerfile.room`](Dockerfile.room).

## Rollout порядок (safe)

1. **Сначала Hathora image.** Загрузить Dockerfile.room через Hathora
   Dashboard (Build → Upload Docker image) либо `hathora deploy`. Задать
   на app-уровне env:
   - `ROOM_SECRET` — тот же, что на Railway (общий HMAC).
   - `ROOM_RAILWAY_URL` — публичный URL Railway, напр. `https://volley.app`.
     Room-server POST'ит сюда `/internal/match-result` по окончании матча.
2. **Smoke на одной комнате.** `DV_ROOMS` на Railway пока `local`. Проверить
   руками: `hathora-cli rooms create` отдаёт host:port, WS-handshake с
   любым валидным room-token проходит, webhook долетает до Railway (видно
   по логу `[ws] match-result webhook ok`).
3. **Railway env**: выставить
   - `DV_ROOMS=hathora`
   - `HATHORA_APP_ID`, `HATHORA_TOKEN`, `HATHORA_REGION` — из Hathora dashboard.
   - `ROOM_SECRET` — как на Hathora (совпадение обязательно).
   - `PUBLIC_URL` — свой Railway-URL (он же проходит как webhook-callback
     в `RAILWAY_SELF_URL`).
4. Перезапуск Railway-инстанса. Первый матч уходит через Hathora.

## Экстренный rollback

`DV_ROOMS_ROLLBACK=1` на Railway → `DV_ROOMS` интерпретируется как `local`,
pairHathora не вызывается вообще, gameplay на Railway как до 7.2.

Ставим флаг, рестартим инстанс — ~10с downtime очереди, уже запущенные
матчи доигрываются на Hathora до конца.

Снять флаг: `DV_ROOMS_ROLLBACK=0` (или unset) + рестарт.

## Локальный dev без Hathora

`DV_ROOMS=hathora DV_LOCAL_ROOMS=1 ROOM_SECRET=... npm start` — `pairHathora`
spawn-ит `room-server.js` как child-process на 127.0.0.1 вместо Hathora
REST API. Полный цикл (matched → gameplay → webhook → trophies) идёт без
Hathora-account'а. Используется в `tests/hathora-flow.test.js`.

## Env-реестр

| var                  | где    | что делает                                     |
|----------------------|--------|------------------------------------------------|
| `DV_ROOMS`           | rly    | `hathora` включает Hathora-роутинг; дефолт `local`. |
| `DV_ROOMS_ROLLBACK`  | rly    | `1` — kill-switch, игнор `DV_ROOMS`.           |
| `DV_LOCAL_ROOMS`     | rly    | `1` — spawn child-process вместо Hathora REST. Для dev. |
| `DV_AUTH_PHYSICS`    | room   | `1` — auth-физика на room-server (в проде ставим). |
| `ROOM_SECRET`        | оба    | HMAC-секрет (токены + webhook). ≥32 байт.      |
| `ROOM_RAILWAY_URL`   | room   | base URL Railway для match-result webhook.     |
| `HATHORA_APP_ID`     | rly    | Hathora Cloud app ID.                          |
| `HATHORA_TOKEN`      | rly    | Hathora Cloud API token.                       |
| `HATHORA_REGION`     | rly    | `Frankfurt` и т.п., дефолт `Frankfurt`.        |
| `ROOM_TOKEN_TTL_MS`  | rly    | TTL room-token'а, дефолт 60s.                  |
| `ROOM_IDLE_TIMEOUT_MS` | room | idle-shutdown room-server'а, дефолт 5 мин.     |
| `ROOM_WEBHOOK_TS_WINDOW_MS` | rly | допустимый разброс `ts` в webhook, дефолт 5 мин. |

`rly` = Railway, `room` = Hathora.
