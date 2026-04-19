"use strict";
// Shared physics tuning. Клиент (game.js) и server-side physics (будущий
// Этап 2 netcode-плана) обязаны читать одни и те же числа — любое
// расхождение разъезжает prediction и авторитет за секунды. Здесь только
// pure-данные без DOM/браузер-зависимостей, чтобы файл грузился и через
// <script>, и через require() без трансформации.
(function(root){
  const PHYSICS = Object.freeze({
    GRAV:           1250,
    MOVE:           620,
    JUMP:           590,   // peak ≈ JUMP²/(2·GRAV) ≈ 139 px (~28% поля)
    BALL_R:         17,
    PLR_R:          42,
    NET_W:          14,
    NET_H:          152,
    E_WALL:         0.85,
    E_NET:          0.85,
    E_GROUND:       0.60,
    // Пассивный отскок от стоящего игрока: мяч теряет энергию мягче, чем от
    // пола, активный удар компенсирует до 1.0 через push-term в collideBallPlayer.
    E_PLAYER_IDLE:  0.78,
    MAX_BSPD:       1300,
    SERVE_SPAWN_Y:  -60,
    POST_POINT_TIME: 1.5,
    COYOTE:         0.10,  // grace после схода с земли
    JUMP_BUFFER:    0.12,  // предпосадочный буфер прыжка
    STUCK_SPEED:    55,
    STUCK_TIME:     2.8,
    // Тикрейт физики: 120 Гц на PC, 60 Гц на мобиле/под нагрузкой (см.
    // _switchStep в game.js). Wire-format и snapshot-loop не завязаны на
    // STEP: rate-контроль снапшотов у хоста — SNAP_STEP 1/30, независимый.
    STEP_HI:        1/120,
    STEP_LO:        1/60
  });
  if(typeof module !== "undefined" && module.exports){
    module.exports = PHYSICS;
  }
  if(root) root.DVPhysics = PHYSICS;
})(typeof window !== "undefined"
     ? window
     : (typeof globalThis !== "undefined" ? globalThis : null));
