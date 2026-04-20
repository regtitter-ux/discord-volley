# Open Questions

## Stage 7 (Railway/Hathora Split) - 2026-04-20

- [ ] **Hathora App ID и credentials** — нужен аккаунт Hathora с созданным приложением до Stage 7.2. Без этого pairHathora не может вызвать REST API. Тесты работают через DV_LOCAL_ROOMS=1.
- [ ] **Region strategy** — сейчас план хардкодит один регион (Frankfurt). Если аудитория мультирегиональная, нужен RTT-picker. Когда приоритизировать?
- [ ] **Coin awards migration** — rally.hit/combo/round.win остаются client-driven через menu-WS. Перенос в room-server повысит integrity, но добавит scope. Когда/если делать?
- [ ] **Hathora billing model** — эфемерные процессы тарифицируются по CPU-time. При 10k concurrent matches нужна оценка стоимости до production switchover.
- [ ] **Room-server healthcheck** — Hathora предоставляет healthcheck endpoint? Если room-server умер mid-match, Railway должен обнаружить и начислить forfeit обоим. Механизм TBD.
- [ ] **TLS на room-server WS** — Hathora терминирует TLS сам или room-server должен обслуживать WSS? Влияет на Dockerfile.room.
