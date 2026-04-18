# Night plan — volleyballonline

Definition of done применяется к каждому пункту отдельно. Пункт закрыт,
если: (1) код закоммичен, (2) `npm test` проходит, (3) `node -c` по
затронутым файлам зелёный, (4) для серверных багов — есть автотест,
который падал до фикса и проходит после.

## Policy
- Коммитить после КАЖДОГО зелёного шага. Message: `fix(...)` / `test(...)`
  / `refactor(...)`. Не пушить принудительно, только `git push`.
- Если тест падает flaky — сначала стабилизировать тест, потом код. Flaky
  мажоритарно от race — искать источник гонки, не `setTimeout(..., 500)`.
- Любое изменение wire-format или схемы БД — откладывать до утра, пишу в
  `blockers.md` с обоснованием.
- Если зациклился на одном пункте > 40 мин без прогресса — пропустить и
  записать в `blockers.md`, переходить к следующему.

## Backlog (priority order)

### 1. Server-authoritative: стабильность форфейт-пути
- [ ] `tests/broker.test.js`: проверить, что второй `claimOutcome(loss)`
      от того же userId после `claimOutcome(win)` возвращает `null` (наш
      недавний фикс). Добавить RedisBroker-вариант за флагом
      `TEST_REDIS_URL` (пропускать, если не задан).
- [ ] `tests/leave-room.test.js`: подключить двух WS клиентов, провести
      match_win хостом, затем leave → проверить, что у хоста трофеи НЕ
      убавились, у гостя — убавились один раз.
- [ ] Форфейт-победа: хост match_win не отсылает (endByForfeit шлёт
      reportMatchWin до того, как endByForfeit выставит matchOver) —
      проверить, что +50 монет match.win начислились ровно один раз.

### 2. Canvas / resize-флейки
- [ ] `tests/e2e/replay.spec.js` (Playwright, mobile viewport): сыграть
      PvP матч с двух контекстов, один ливает, второй жмёт «Играть
      снова» → canvas.width >= 300, HUD diff text = "ONLINE" или "Бот"
      корректно для активного state.mode.
- [ ] Смоук `showLobby/hideLobby` race: если cancel нажать в первые 50ms
      после queue → соединение должно остаться живым, cancel уйти.
- [ ] ResizeObserver не должен дёргать resizeCanvas > 10 раз за секунду
      (throttle через rAF).

### 3. Rate-limit кошелька (не регрессии)
- [ ] `tests/wallet.test.js`: за один матч max rally.hit = 200, round.win = 100,
      match.win = 1. Отправлять 300 rally.hit с 10ms gap — ответ должен
      приходить первые 200 (с учётом minGapMs=250).
- [ ] 30-секундный global cooldown на match.win между разными matchId
      того же юзера.

### 4. Онлайн-счётчик и stats broadcast
- [ ] `tests/online-counter.test.js`: подключить 5 клиентов, проверить
      что `hello.online >= 5` к последнему; разъединить — через ~1s
      получить `stats` с меньшим числом.

### 5. Cross-instance (Redis) — только если TEST_REDIS_URL
- [ ] Матч между двумя инстансами: запускать два node server.js на
      разных портах с общим Redis, клиент 1 → 18084, клиент 2 → 18085,
      проверить что matched приходит обоим.

### 6. UI-фиксы из наблюдений
- [ ] Форфейт-путь НЕ сбрасывает HUD "ONLINE" → "Бот" если после replay
      сессия online продолжится. Наш фикс `8f70197` этого требует
      проверить E2E.
- [ ] "Играть снова" у бота vs онлайн — оба пути должны оставлять
      canvas не-пустым (w > 300, h > 300).

### 7. Docs
- [ ] README: добавить раздел `## Tests` с `npm test`, `npm run test:e2e`.
- [ ] CLAUDE.md проекта (создать): список командных shortcut'ов и
      решённых/нерешённых багов для будущих агентов.

## Hands-off checklist (ровно перед запуском)
- `npm test` зелёный baseline
- `git status` чистый
- В `.omc/logs/night.jsonl` писать по итогу каждой итерации
- `blockers.md` пустой

## Blockers (пополнять по ходу)
(empty)
