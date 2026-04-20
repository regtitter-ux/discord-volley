"use strict";
// Shared physics tuning + pure-физ helpers. Клиент (game.js) и server-side
// physics (Этап 2+ netcode-плана) обязаны читать одни и те же числа и
// вычислять одно и то же, иначе prediction/reconciliation разъезжаются за
// секунды. Здесь только pure-код без DOM/sfx/particles — всё это остаётся
// на клиенте как visual feedback поверх результатов функций.
(function(root){
  const GRAV           = 1250;
  const MOVE           = 620;
  const JUMP           = 590;   // peak ≈ JUMP²/(2·GRAV) ≈ 139 px (~28% поля)
  const BALL_R         = 17;
  const PLR_R          = 42;
  const NET_W          = 14;
  const NET_H          = 152;
  const E_WALL         = 0.85;
  const E_NET          = 0.85;
  const E_GROUND       = 0.60;
  // Пассивный отскок от стоящего игрока: мяч теряет энергию мягче, чем от
  // пола, активный удар компенсирует до 1.0 через push-term в collideBallPlayer.
  const E_PLAYER_IDLE  = 0.78;
  const MAX_BSPD       = 1300;
  const SERVE_SPAWN_Y  = -60;
  const POST_POINT_TIME = 1.5;
  const COYOTE         = 0.10;  // grace после схода с земли
  const JUMP_BUFFER    = 0.12;  // предпосадочный буфер прыжка
  const STUCK_SPEED    = 55;
  const STUCK_TIME     = 2.8;
  // Тикрейт физики: 120 Гц на PC, 60 Гц на мобиле/под нагрузкой (см.
  // _switchStep в game.js). Wire-format и snapshot-loop не завязаны на
  // STEP: rate-контроль снапшотов у хоста — SNAP_STEP 1/30, независимый.
  const STEP_HI        = 1/120;
  const STEP_LO        = 1/60;

  // Pure-кинематика игрока: гравитация, интегрирование позиции, зажимы по
  // X, посадка на землю. Мутирует p.{x,y,vy,onGround}. Возвращает событие
  // посадки с импактной vy — клиент лепит на него squash-анимацию и
  // pufF-частицы, сервер-реплика будущего Этапа 2 будет игнорировать поле
  // landed (визуала нет). xMin/xMax/groundY приходят параметрами, потому
  // что поле (WORLD_W/H) — ответственность вызывающего слоя.
  function integratePlayerKinematics(p, dt, xMin, xMax, groundY){
    const wasInAir = !p.onGround;
    const impactVy = p.vy;
    p.vy += GRAV * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if(p.x < xMin + p.r) p.x = xMin + p.r;
    if(p.x > xMax - p.r) p.x = xMax - p.r;
    if(p.y + p.r >= groundY){
      p.y = groundY - p.r;
      p.vy = 0;
      p.onGround = true;
      return { landed: wasInAir, impactVy };
    }
    return { landed: false, impactVy: 0 };
  }

  // Pure-отскок мяча от боковых стен. Нет event'а — стена молчит, sfx
  // клиенту не нужны.
  function collideBallWalls(ball, worldW){
    if(ball.x < ball.r){               ball.x = ball.r;             ball.vx = -ball.vx * E_WALL; }
    if(ball.x > worldW - ball.r){       ball.x = worldW - ball.r;    ball.vx = -ball.vx * E_WALL; }
  }

  // Pure-отскок от пола: приземление + friction по vx. Возвращает {hit,
  // impactSpeed} — клиент решает, бомбить ли sfx/particles и awardPoint.
  function collideBallGround(ball, groundY){
    if(ball.y + ball.r >= groundY && ball.vy > 0){
      const impactSpeed = Math.abs(ball.vy);
      ball.y  = groundY - ball.r;
      ball.vy = -impactSpeed * E_GROUND;
      ball.vx *= 0.96;
      return { hit: true, impactSpeed };
    }
    return { hit: false, impactSpeed: 0 };
  }

  // Pure-столкновение мяча с сеткой (AABB + radius). Мутирует ball на
  // корректной нормали, возвращает hit-event для sfx/squash на клиенте.
  // netX — центр сетки по X, groundY — пол; NET_W/NET_H/E_NET читаем из
  // модульных констант.
  function collideBallNet(ball, netX, groundY){
    const left  = netX - NET_W*0.5, right = netX + NET_W*0.5;
    const top   = groundY - NET_H,  bot   = groundY;
    const cx = Math.max(left, Math.min(ball.x, right));
    const cy = Math.max(top,  Math.min(ball.y, bot));
    let nx = ball.x - cx, ny = ball.y - cy;
    const d2 = nx*nx + ny*ny;
    if(d2 >= ball.r*ball.r) return { hit: false, hitPower: 0 };
    let d = Math.sqrt(d2);
    if(d < 0.0001){
      // Ball center inside net AABB — pick shortest escape axis.
      // Top of net is the only face we prefer strongly (so deflections
      // go UP toward play, not sideways into a post).
      const overT = ball.y - top;
      const overL = ball.x - left;
      const overR = right - ball.x;
      if(overT <= overL && overT <= overR){ nx = 0; ny = -1; }
      else if(overL < overR){ nx = -1; ny = 0; }
      else                  { nx = 1;  ny = 0; }
      d = 0.0001;
    }else{
      nx /= d; ny /= d;
    }
    ball.x = cx + nx * ball.r;
    ball.y = cy + ny * ball.r;
    const vn = ball.vx*nx + ball.vy*ny;
    if(vn < 0){
      const hitPower = -vn;
      ball.vx -= (1+E_NET) * vn * nx;
      ball.vy -= (1+E_NET) * vn * ny;
      return { hit: true, hitPower };
    }
    return { hit: false, hitPower: 0 };
  }

  const PHYSICS = Object.freeze({
    GRAV, MOVE, JUMP, BALL_R, PLR_R, NET_W, NET_H,
    E_WALL, E_NET, E_GROUND, E_PLAYER_IDLE,
    MAX_BSPD, SERVE_SPAWN_Y, POST_POINT_TIME,
    COYOTE, JUMP_BUFFER, STUCK_SPEED, STUCK_TIME,
    STEP_HI, STEP_LO,
    integratePlayerKinematics,
    collideBallWalls,
    collideBallGround,
    collideBallNet
  });
  if(typeof module !== "undefined" && module.exports){
    module.exports = PHYSICS;
  }
  if(root) root.DVPhysics = PHYSICS;
})(typeof window !== "undefined"
     ? window
     : (typeof globalThis !== "undefined" ? globalThis : null));
