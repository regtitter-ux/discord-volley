"use strict";
// Shadow-physics observer + authoritative runner (server-authoritative netcode).
// Два режима в одном компоненте — чтобы не раздваивать код физики:
//
//   DV_SHADOW_PHYSICS=1 — observer. Host остаётся авторитетом, мы ловим
//   его бинарные фреймы из publishRoom и сравниваем drift/score. Нужен,
//   чтобы убедиться, что DVPhysics в node сходится с host-клиентом.
//
//   DV_AUTH_PHYSICS=1   — authoritative. Сервер САМ считает физику,
//   принимает бинарные input-фреймы от обоих клиентов, гонит сим 60 Гц,
//   каждые 33 мс шлёт снапшот обоим пирам. Relay input-фреймов
//   выключается для этой комнаты (см. server.js).
//
// Выключенные оба флага = нулевой оверхед: сим не создаётся, обработчики
// no-op'ят по guard'у this.enabled.
const DVPhysics = require("./physics.js");
const DVCodec   = require("./codec.js");

const TICK_HZ        = 60;
const TICK_MS        = 1000 / TICK_HZ;
const STATS_LOG_MS   = 30000;     // summary лог раз в 30 с
const DRIFT_WARN_PX  = 50;        // одноразовый варн, если drift > X
const SNAP_HZ        = 30;
const SNAP_STEP      = 1 / SNAP_HZ;

function makePlayer(side, worldW, groundY){
  const x = side === 1 ? worldW * 0.25 : worldW * 0.75;
  return {
    x, y: groundY - DVPhysics.PLR_R,
    vx: 0, vy: 0,
    r: DVPhysics.PLR_R,
    onGround: true,
    coyoteT: 0,
    side
  };
}

function makeSim(){
  const W = DVPhysics.WORLD_W, H = DVPhysics.WORLD_H;
  const NET_X = DVPhysics.NET_X, GROUND_Y = DVPhysics.GROUND_Y;
  return {
    W, H, NET_X, GROUND_Y,
    p1: makePlayer(1, W, GROUND_Y),
    p2: makePlayer(-1, W, GROUND_Y),
    ball: DVPhysics.serveBall(1, null, W, NET_X),
    // Authoritative flag: когда true, tickLoop применяет hostInput/guestInput
    // как авторитетные и эмитит снапшоты в peerSinks; observer-ветка в
    // observeFrame(state) становится no-op.
    authoritative: false,
    peerSinks: { host: null, guest: null },
    snapAcc: 0,
    lastWinnerSide: 0,
    guestInput: { left:false, right:false, jumpHeld:false },
    hostInput:  { left:false, right:false, jumpHeld:false },
    jumpBufG: 0,
    jumpBufH: 0,
    // Match state — независимая реплика счёта и режима. На 6b.1 мы
    // считаем это в shadow и сравниваем с host'овым s1/s2/rh в снапшоте.
    score1: 0, score2: 0,
    servingSide: 1,      // 1 = p1 подаёт, -1 = p2
    roundOver: false,
    roundTimer: 0,       // POST_POINT_TIME countdown после очка
    rallyHits: 0,
    lastHitSide: 0,
    matchOver: false,
    matchWinner: 0,
    _matchOverFired: false,  // Stage 7.5: страхуем от double-fire onMatchOver
    onMatchOver: null,       // Stage 7.5: room-server cb для webhook на Railway
    targetScore: 11,     // host может прислать другое в будущем; пока дефолт
    // Stats
    frames:        { stateFromHost: 0, inputFromGuest: 0 },
    driftSumPx:    0,    // sum of ball/p1/p2 euclidean drift per state frame
    driftMaxPx:    0,
    driftSamples:  0,
    scoreMismatches: 0,  // сколько раз state-фрейм принёс s1/s2, не совпавший с нашим
    warnedOnce:    false,
    openedAt:      Date.now(),
    lastStatsAt:   Date.now()
  };
}

// Helpers: match-rule mutations на sim. Вынесены из метода класса, чтобы
// tick-loop оставался читаемым и чтобы легко было тестить вне инстанса.
function _registerHit(sim, side){
  if (sim.roundOver) return;
  sim.rallyHits++;
  sim.lastHitSide = side;
  if (side === 1){ sim.ball.touches.left++;  sim.ball.touches.right = 0; }
  else           { sim.ball.touches.right++; sim.ball.touches.left  = 0; }
  // 4-touch rule: лишнее касание = фол, очко сопернику.
  if (sim.ball.touches.left  >= 4){ _awardPoint(sim, 2, "foul"); return; }
  if (sim.ball.touches.right >= 4){ _awardPoint(sim, 1, "foul"); return; }
}
function _awardPoint(sim, side, reason){
  if (sim.roundOver) return;
  sim.roundOver = true;
  sim.roundTimer = DVPhysics.POST_POINT_TIME;
  sim.rallyHits = 0;
  sim.lastWinnerSide = side;
  if (side === 1){ sim.score1++; sim.servingSide = 1;  }
  else           { sim.score2++; sim.servingSide = -1; }
  const t = sim.targetScore;
  if ((sim.score1 >= t || sim.score2 >= t) && Math.abs(sim.score1 - sim.score2) >= 2){
    sim.matchOver = true;
    sim.matchWinner = sim.score1 > sim.score2 ? 1 : 2;
    // Stage 7.5: хук для webhook-уведомления Railway. Эмитим ровно один
    // раз на matchOver-transition (см. sim._matchOverFired), даже если
    // sim переживёт ещё несколько тиков до закрытия комнаты.
    if (!sim._matchOverFired && typeof sim.onMatchOver === "function"){
      sim._matchOverFired = true;
      try {
        sim.onMatchOver({
          winnerSide: sim.matchWinner,
          score1: sim.score1,
          score2: sim.score2
        });
      } catch (e){
        console.error("[shadow] onMatchOver hook threw:", e && e.message || e);
      }
    }
  }
}
function _restartRound(sim){
  sim.roundOver = false;
  sim.roundTimer = 0;
  const server = sim.servingSide === 1 ? sim.p1 : sim.p2;
  sim.ball = DVPhysics.serveBall(sim.servingSide, server.x, sim.W, sim.NET_X);
  sim.rallyHits = 0;
  sim.lastHitSide = 0;
}
// Бинарный снапшот для обоих пиров. Клиент отправителя (host/guest)
// примет его через тот же Codec.decode-путь в onmessage(binary).
function _emitSnapshot(sim){
  const hostSink  = sim.peerSinks.host;
  const guestSink = sim.peerSinks.guest;
  if (!hostSink && !guestSink) return;
  const frame = DVCodec.encodeState(
    sim.p1, sim.p2, sim.ball,
    sim.score1, sim.score2, sim.rallyHits,
    sim.matchOver ? 1 : 0,
    sim.roundOver ? 1 : 0,
    sim.servingSide,
    sim.lastWinnerSide | 0,
    sim.lastHitSide | 0
  );
  // sendRaw на WS принимает Buffer/Uint8Array/ArrayBuffer. ws@8 съедает
  // Uint8Array без копирования, но если в пути есть Buffer.from — не
  // принципиально, всё это одна и та же память.
  if (hostSink)  try { hostSink(frame);  } catch {}
  if (guestSink) try { guestSink(frame); } catch {}
}

class ShadowRegistry {
  // opts = { shadow: boolean, auth: boolean } — флаги из env. enabled =
  // OR обоих; per-sim behaviour рулится флагом authoritative на комнате.
  constructor(opts){
    const shadow = !!(opts && opts.shadow);
    const auth   = !!(opts && opts.auth);
    this.shadowMode = shadow;
    this.authMode   = auth;
    this.enabled = shadow || auth;
    this.sims = new Map();     // roomId → sim
    this.wsRole = new Map();   // wsId → 'host' | 'guest'
    this.tickHandle = null;
    this.statsHandle = null;
  }
  start(){
    if (!this.enabled) return;
    this.tickHandle = setInterval(() => this._tickAll(), TICK_MS);
    this.statsHandle = setInterval(() => this._flushStats(), STATS_LOG_MS);
    this.tickHandle.unref?.();
    this.statsHandle.unref?.();
    const tags = [
      this.shadowMode ? "shadow" : null,
      this.authMode   ? "auth"   : null
    ].filter(Boolean).join("+");
    console.log(`[shadow] enabled (${tags}, tick=${TICK_HZ}Hz, stats=${STATS_LOG_MS/1000}s)`);
  }
  stop(){
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.statsHandle) clearInterval(this.statsHandle);
    this.tickHandle = this.statsHandle = null;
  }
  registerRole(wsId, role){
    if (!this.enabled) return;
    this.wsRole.set(wsId, role);
  }
  unregisterRole(wsId){
    if (!this.enabled) return;
    this.wsRole.delete(wsId);
  }
  // openRoom(roomId, { authoritative }) — флаг авторитетности ставим при
  // создании. Смена mid-match не нужна: матч либо auth, либо host-auth.
  openRoom(roomId, opts){
    if (!this.enabled) return;
    if (this.sims.has(roomId)) return;
    const sim = makeSim();
    if (opts && opts.authoritative) sim.authoritative = true;
    if (opts && typeof opts.onMatchOver === "function") sim.onMatchOver = opts.onMatchOver;
    this.sims.set(roomId, sim);
  }
  // Привязываем sendRaw пира к симу, чтобы server.js не знал про бинарный
  // snapshot-путь. В non-auth режиме sinks игнорятся.
  attachPeer(roomId, role, sendRawFn){
    if (!this.enabled) return;
    const sim = this.sims.get(roomId);
    if (!sim) return;
    if (role === "host" || role === "guest") sim.peerSinks[role] = sendRawFn || null;
  }
  detachPeer(roomId, role){
    if (!this.enabled) return;
    const sim = this.sims.get(roomId);
    if (!sim) return;
    if (role === "host" || role === "guest") sim.peerSinks[role] = null;
  }
  isAuthoritative(roomId){
    if (!this.enabled) return false;
    const sim = this.sims.get(roomId);
    return !!(sim && sim.authoritative);
  }
  closeRoom(roomId){
    if (!this.enabled) return;
    const s = this.sims.get(roomId);
    if (!s) return;
    const durSec = ((Date.now() - s.openedAt) / 1000).toFixed(1);
    const avg = s.driftSamples ? (s.driftSumPx / s.driftSamples).toFixed(1) : "0.0";
    const modeTag = s.authoritative ? "auth" : "shadow";
    console.log(`[shadow] ${modeTag} room ${roomId} closed after ${durSec}s — host/guest frames=${s.frames.stateFromHost}/${s.frames.inputFromGuest} drift avg=${avg}px max=${s.driftMaxPx.toFixed(1)}px score-mismatch=${s.scoreMismatches} finalScore=${s.score1}:${s.score2}`);
    this.sims.delete(roomId);
  }
  // Главный перехват: каждый бинарный фрейм, который идёт через publishRoom.
  // senderWsId — кто отправил; мы смотрим его role, чтобы знать input это
  // (guest→host) или state (host→guest). frame — Buffer или Uint8Array.
  observeFrame(roomId, senderWsId, frame){
    if (!this.enabled) return;
    const sim = this.sims.get(roomId);
    if (!sim) return;
    const role = this.wsRole.get(senderWsId);
    if (!role) return;
    const dec = DVCodec.decode(frame);
    if (!dec) return;
    if (dec.kind === "input"){
      if (role === "guest"){
        // Guest клиент шлёт (keys.right, keys.left, keys.jump) — т.е. уже
        // зеркалит под мировые координаты (p2=справа). dec.left → p2 влево.
        sim.guestInput.left  = !!dec.left;
        sim.guestInput.right = !!dec.right;
        sim.guestInput.jumpHeld = !!dec.jump;
        sim.frames.inputFromGuest++;
      } else if (role === "host" && sim.authoritative){
        // В auth-режиме host тоже шлёт свой input серверу, БЕЗ зеркала:
        // host = p1 = левый, dec.left → p1 влево напрямую.
        sim.hostInput.left  = !!dec.left;
        sim.hostInput.right = !!dec.right;
        sim.hostInput.jumpHeld = !!dec.jump;
      }
      return;
    }
    if (sim.authoritative) return; // в auth-режиме state от host'а не ждём
    if (dec.kind === "state" && role === "host"){
      sim.frames.stateFromHost++;
      // Infer host input из vx (на host'е p.vx = ax*MOVE после applyHumanInput).
      const MOVE = DVPhysics.MOVE;
      sim.hostInput.left  = dec.p1.vx < -MOVE*0.5;
      sim.hostInput.right = dec.p1.vx >  MOVE*0.5;
      sim.hostInput.jumpHeld = (dec.p1.g === 0) && (dec.p1.vy < 0); // inflight with upward vy = recent jump
      // Сравнение drift'а: euclid(p1) + euclid(p2) + euclid(ball)
      const dp1 = Math.hypot(sim.p1.x - dec.p1.x, sim.p1.y - dec.p1.y);
      const dp2 = Math.hypot(sim.p2.x - dec.p2.x, sim.p2.y - dec.p2.y);
      const db  = Math.hypot(sim.ball.x - dec.b.x, sim.ball.y - dec.b.y);
      const drift = dp1 + dp2 + db;
      sim.driftSumPx += drift;
      sim.driftMaxPx = Math.max(sim.driftMaxPx, drift);
      sim.driftSamples++;
      if (!sim.warnedOnce && drift > DRIFT_WARN_PX){
        sim.warnedOnce = true;
        console.log(`[shadow] room ${roomId} first drift ${drift.toFixed(1)}px (p1=${dp1.toFixed(0)} p2=${dp2.toFixed(0)} b=${db.toFixed(0)}) — инференс host-инпута через vx груб`);
      }
      // Сравнение счёта: если host'овые s1/s2 не совпали с нашими —
      // это прямой сигнал, что серверные score-rules расходятся с клиентскими.
      if (dec.s1 !== sim.score1 || dec.s2 !== sim.score2){
        sim.scoreMismatches++;
      }
      // Resync к snapshot'у — shadow-режим не претендует быть авторитетом.
      // Без resync drift только растёт (host-input инференс через vx груб).
      sim.p1.x = dec.p1.x; sim.p1.y = dec.p1.y; sim.p1.vx = dec.p1.vx; sim.p1.vy = dec.p1.vy;
      sim.p1.onGround = !!dec.p1.g;
      sim.p2.x = dec.p2.x; sim.p2.y = dec.p2.y; sim.p2.vx = dec.p2.vx; sim.p2.vy = dec.p2.vy;
      sim.p2.onGround = !!dec.p2.g;
      sim.ball.x = dec.b.x; sim.ball.y = dec.b.y; sim.ball.vx = dec.b.vx; sim.ball.vy = dec.b.vy;
      sim.ball.angle = dec.b.a;
      // Score/round тоже ресинкаем к host'у — иначе наш match lifecycle
      // отличается от реального и serve/awardPoint спамят с расходящимся
      // state'ом. На этом этапе host всё ещё авторитет счёта.
      sim.score1 = dec.s1; sim.score2 = dec.s2;
      sim.rallyHits = dec.rh;
      sim.roundOver = !!dec.ro;
      sim.servingSide = dec.ss;
    }
  }
  _tickAll(){
    const dt = 1 / TICK_HZ;
    for (const [roomId, sim] of this.sims){
      // Post-point фриз: мяч падает/летит, но очков больше не присуждаем,
      // inputs игнорируем. По истечении POST_POINT_TIME вызываем serveBall.
      if (sim.roundOver){
        sim.roundTimer -= dt;
        if (sim.roundTimer <= 0){
          _restartRound(sim);
        }
      }
      // В authoritative-режиме матч может кончиться — дальше физику крутим,
      // но очков больше не считаем; клиенты получают mo=1 в снапшоте и
      // закрывают матч overlay'ем.
      const live = !sim.matchOver;
      // Applyhuman-input на оба пира (host inferred в shadow, точный в auth).
      const r1 = DVPhysics.applyHumanInput(sim.p1, dt, live ? sim.hostInput : { left:false, right:false, jumpHeld:false }, sim.jumpBufH);
      sim.jumpBufH = r1.jumpBufferT;
      const r2 = DVPhysics.applyHumanInput(sim.p2, dt, live ? sim.guestInput : { left:false, right:false, jumpHeld:false }, sim.jumpBufG);
      sim.jumpBufG = r2.jumpBufferT;
      // Интеграция кинематики
      DVPhysics.integratePlayerKinematics(sim.p1, dt, 0, sim.NET_X, sim.GROUND_Y);
      DVPhysics.integratePlayerKinematics(sim.p2, dt, sim.NET_X, sim.W, sim.GROUND_Y);
      // Ball: гравитация, wall/net, коллизии с игроками и оценка ground-hit
      sim.ball.vy += DVPhysics.GRAV * dt;
      sim.ball.x += sim.ball.vx * dt;
      sim.ball.y += sim.ball.vy * dt;
      DVPhysics.collideBallWalls(sim.ball, sim.W);
      DVPhysics.collideBallNet(sim.ball, sim.NET_X, sim.GROUND_Y);
      // Player-collision сначала (может поднять мяч перед ground-check).
      // 4-touch rule — лишние касания своего игрока → фол, очко сопернику.
      const h1 = DVPhysics.collideBallPlayer(sim.ball, sim.p1, sim.GROUND_Y);
      if (h1.hit) _registerHit(sim, 1);
      const h2 = DVPhysics.collideBallPlayer(sim.ball, sim.p2, sim.GROUND_Y);
      if (h2.hit) _registerHit(sim, 2);
      const gnd = DVPhysics.collideBallGround(sim.ball, sim.GROUND_Y);
      if (gnd.hit && !sim.roundOver){
        // Очко тому, на чью половину НЕ упал мяч.
        const pointSide = sim.ball.x < sim.NET_X ? 2 : 1;
        _awardPoint(sim, pointSide, "ground");
      }
      // Authoritative-only: эмитим снапшот обоим пирам на 30 Гц. Сим
      // работает на 60 Гц, так что аккумулятор выдаёт кадр через каждый
      // второй тик. Снапшот — world-coord, клиент-гость зеркалит у себя.
      if (sim.authoritative){
        sim.snapAcc += dt;
        if (sim.snapAcc >= SNAP_STEP){
          sim.snapAcc = 0;
          _emitSnapshot(sim);
        }
      }
    }
  }
  _flushStats(){
    const now = Date.now();
    for (const [roomId, sim] of this.sims){
      const dt = (now - sim.lastStatsAt) / 1000;
      if (dt < 1) continue;
      const stateHz = (sim.frames.stateFromHost / dt).toFixed(1);
      const inpHz   = (sim.frames.inputFromGuest / dt).toFixed(1);
      const avg     = sim.driftSamples ? (sim.driftSumPx / sim.driftSamples).toFixed(1) : "0.0";
      console.log(`[shadow] ${roomId} state=${stateHz}Hz input=${inpHz}Hz drift avg=${avg}px max=${sim.driftMaxPx.toFixed(1)}px scoreMismatch=${sim.scoreMismatches} score=${sim.score1}:${sim.score2}`);
      sim.frames.stateFromHost = 0;
      sim.frames.inputFromGuest = 0;
      sim.driftSumPx = 0;
      sim.driftMaxPx = 0;
      sim.driftSamples = 0;
      sim.scoreMismatches = 0;
      sim.lastStatsAt = now;
    }
  }
}

module.exports = { ShadowRegistry };
