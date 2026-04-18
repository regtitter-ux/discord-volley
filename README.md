# Discord Volley

Лёгкая волейбольная мини-игра в стилистике Discord. Ванильный HTML + CSS + Canvas 2D, без фреймворков и сборки.

## Запуск (локально)

Любой статический сервер:

```
npx serve .
# или
python -m http.server 8080
```

Открыть `http://localhost:8080`. Можно и просто двойным кликом по `index.html`, но `localStorage` и аватары по URL лучше работают на http://.

## Управление

- **ПК:** `A` — влево, `D` — вправо, `W` / `Space` / `↑` — прыжок.
- **Мобилки:** экранные кнопки появляются автоматически при тач-устройствах.

## Правила

- Первый до выбранной планки (5 / 10 / 15), побеждает с разницей в 2 очка.
- 4 подряд касания одной стороной = фол, очко сопернику.
- Мяч на полу — очко стороне, на которой мяч **не** упал.

## Производительность

- Один HTML + один CSS + два JS (суммарно ~20 KB без сжатия).
- Нет зависимостей, нет шрифтов по сети, нет картинок-ассетов — всё рисуется на Canvas.
- Физика с фиксированным шагом 120 Гц, рендер через `requestAnimationFrame`.
- DPR ограничен 2.0, чтобы не убить слабые GPU на Retina-устройствах.
- `alpha:false` у контекста + плоская заливка — минимум перерисовок.
- Letterbox-масштабирование логического мира 1000×500 → физика одинакова на любом экране.

## Tests

Два независимых слоя.

### Unit / интеграция (node:test)

```
npm test
```

Запускает `node --test "tests/*.test.js"` против локального harness, который
поднимает настоящий `server.js` в child-процессе на свободном порту с
`DV_DEV_LOGIN=1` и уникальным `DATA_DIR` на прогон. Тесты говорят с сервером
по WebSocket, без браузера.

Покрывает: broker.claimOutcome (один win на матч), leave/форфейт-трофеи,
wallet rate-limit (minGapMs + per-match cap), queue_timeout regression,
Play-Again race (leave→queue без cancel), online-counter broadcast.

### E2E (Playwright)

```
npx playwright install chromium    # первый запуск
npm run test:e2e
```

Playwright сам поднимает `server.js` на порту 18099 (через `webServer` в
`playwright.config.js`) с `DV_DEV_LOGIN=1`, `QUEUE_TIMEOUT_MS=5000` и
прочими dev-secrets. Проекты: `desktop-chrome`, `mobile-chrome` (Pixel 7).
`workers: 1` — замокать PvP-очередь двумя A/B-парами накрест нельзя.

Покрывает: загрузку UI, запуск бот-матча, replay-сценарий (два контекста
→ matched → один уходит → второй жмёт «Играть снова» → canvas получает
размеры), throttle resizeCanvas под залпом ResizeObserver-событий.

## Структура

```
index.html   — разметка и экраны (login / menu / game)
styles.css   — Discord-палитра, адаптив
auth.js      — мок-авторизация (localStorage)
game.js      — ввод, физика, AI, рендер
```

## Интеграция с Discord-ботом (план)

Сейчас `auth.js` использует локальный мок. Для продакшна:

1. На бекенде завести OAuth2 приложение Discord с scope `identify`.
2. Эндпойнты:
   - `GET  /auth/discord` → редирект на `https://discord.com/oauth2/authorize?...`.
   - `GET  /auth/discord/callback` → обмен кода на токен, установить httpOnly cookie сессии.
   - `GET  /api/me` → `{ id, username, global_name, avatar_url }`.
3. В `auth.js` заменить `login()` на редирект к `/auth/discord`, а `current()` — на `fetch('/api/me')`.
4. Контракт `user` менять не нужно — `game.js` ничего, кроме `avatar_url` / `global_name` / `username`, не читает.

`avatar_url` формируется как:
`https://cdn.discordapp.com/avatars/<user_id>/<avatar>.png?size=128`

## Дальнейшее (сетевой PvP)

Для онлайна на слабых каналах:
- WebSocket + делта-пакеты (позиции игроков + состояние мяча раз в 30 тиков).
- Серверная физика — авторитативная, клиент рендерит по снэпшотам с интерполяцией.
- Ввод отправлять как битовую маску (3 бита: left/right/jump) — ~120 байт/с в пике.
