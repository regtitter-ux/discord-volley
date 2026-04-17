/* Discord Volley — lightweight vanilla canvas game.
   No frameworks, no build. Fixed-timestep physics @ 120Hz, rendered via rAF. */
(function(){
"use strict";

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const screens = {
  login: $("screen-login"),
  menu:  $("screen-menu"),
  game:  $("screen-game")
};
const canvas = $("cv");
const ctx = canvas.getContext("2d", { alpha:false });

/* ---------------- Clock ----------------
   Одна точка чтения времени на весь клиент. Сейчас это `Clock.now()`,
   но именно здесь в будущем подселяется серверная таймлайн-синхронизация
   (NTP-подобный offset) для онлайна, чтобы rate-limit и rollback-симуляция
   работали от одного и того же источника, а не от клиентских часов. */
const Clock = {
  offsetMs: 0,
  now(){ return performance.now() + this.offsetMs; }
};

/* ---------------- State ---------------- */
const state = {
  user: null,
  bot: null,
  difficulty: "medium",
  targetScore: 10,
  inGame: false,
  paused: false,
  matchOver: false,
  // Сессия матча. matchId — идентификатор раунда, с которым в онлайне
  // клиент будет слать события на сервер (award-запросы, инпуты); seq —
  // монотонный счётчик сообщений, чтобы сервер мог отбрасывать ретраи/
  // дубликаты. Пересоздаётся на каждый новый матч.
  session: null
};
function newSession(){
  return {
    matchId: "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    startedAt: Clock.now(),
    seq: 0
  };
}

/* ---------------- Device detection ---------------- */
const isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
if(isTouch) document.body.classList.add("is-touch");

/* ---------------- Navigation ---------------- */
function show(name){
  for(const k in screens) screens[k].classList.add("hidden");
  screens[name].classList.remove("hidden");
}

async function boot(){
  // /api/me может вернуть 401 (не залогинен) или 200 с профилем.
  // Во время ожидания ответа экран авторизации — безопасный дефолт.
  const u = await Auth.current();
  if(u){ state.user = u; enterMenu(); }
  else { show("login"); }

  // Если вернулись с callback с ошибкой — мягко сообщаем в консоль,
  // чтобы не шуметь alert'ом. Сам UI остаётся на login-экране.
  const err = new URLSearchParams(location.search).get("auth_error");
  if(err){
    console.warn("[auth] discord callback error:", err);
    try{ history.replaceState(null, "", location.pathname); }catch(_){}
  }
}

/* ---------------- Wallet (persistent coin balance) ----------------
   ВНИМАНИЕ: до релиза с онлайном кошелёк ДОЛЖЕН стать серверным. Текущая
   реализация клиентская — локальный баланс только для SP-режима. Любой
   подправит localStorage через DevTools. Мы добавляем:
     1) честный лимит по событиям (rate-limit),
     2) HMAC-подобная подпись на локальном «устройствном» секрете,
        чтобы правки значения в devtools рушили запись (сбрасывало в 0),
     3) API-контракт, удобный для свапа на серверный источник истины
        (`WalletRemote.add(eventType, context)` → сервер возвращает delta).
   НИЧТО ИЗ ЭТОГО — не настоящая защита. Сервер обязателен.
*/
const Wallet = (function(){
  const KEY = "dv_coins_v1";
  // Устройствный «секрет» — одноразово генерируется и хранится рядом.
  // Атакующий всё равно достанет, но это ломает тривиальные правки типа
  // «установил 999999 в DevTools»: подпись перестаёт совпадать → сброс.
  const SECRET_KEY = "dv_wallet_secret_v1";
  let secret;
  try{
    secret = localStorage.getItem(SECRET_KEY);
    if(!secret){
      secret = "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(SECRET_KEY, secret);
    }
  }catch(_){ secret = "fallback"; }

  // FNV-1a 32-bit. Дешево, достаточно для anti-tamper на localStorage.
  function sign(value){
    let h = 0x811c9dc5;
    const s = String(value) + "|" + secret;
    for(let i = 0; i < s.length; i++){
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  let balance = 0;
  try{
    const raw = localStorage.getItem(KEY);
    if(raw){
      const parts = raw.split(":");
      if(parts.length === 2){
        const v = parseInt(parts[0], 10);
        if(!isNaN(v) && v >= 0 && parts[1] === sign(v)) balance = v;
      }
    }
  }catch(_){}

  const listeners = [];

  // Троттлим запись: при частых начислениях (каждое касание мяча = +1)
  // сбрасываем в localStorage не чаще раза в 200 мс. Форсим на pagehide,
  // чтобы ничего не терялось при закрытии вкладки.
  let saveTimer = 0;
  function flush(){
    if(saveTimer){ clearTimeout(saveTimer); saveTimer = 0; }
    try{ localStorage.setItem(KEY, balance + ":" + sign(balance)); }catch(_){}
  }
  function scheduleSave(){
    if(saveTimer) return;
    saveTimer = setTimeout(flush, 200);
  }
  // pagehide/beforeunload ненадёжны на iOS Safari; visibilitychange:hidden
  // стреляет и когда пользователь переключает вкладку. Форсим запись тут же.
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", ()=>{
    if(document.hidden) flush();
  });

  // Рейт-лимит по типам событий. Клиентская проверка — только от
  // случайных багов (спам через залипшую коллизию) и от совсем ленивого
  // читерства. Авторитет — сервер.
  const RATE = {
    // rally-hit не чаще 1 в ~250 мс: нормальный полёт мяча между
    // касаниями редко короче, любой спам выходит за границу.
    "rally.hit":   { minGapMs: 250, maxPerMatch: 200 },
    "rally.combo": { minGapMs: 500, maxPerMatch: 40  },
    "round.win":   { minGapMs: 500, maxPerMatch: 100 },
    "match.win":   { minGapMs: 1000, maxPerMatch: 1  }
  };
  const eventState = Object.create(null); // { type → { lastAt, count } }
  function matchReset(){
    for(const k in eventState) delete eventState[k];
  }

  function tryAward(type, amount){
    const cfg = RATE[type];
    if(!cfg){ return false; } // неизвестный тип — отклоняем, лучше потерять очко, чем открыть вектор.
    const now = Clock.now();
    const st = eventState[type] || (eventState[type] = { lastAt: -Infinity, count: 0 });
    if(now - st.lastAt < cfg.minGapMs) return false;
    if(st.count >= cfg.maxPerMatch)    return false;
    st.lastAt = now;
    st.count++;
    balance += amount | 0;
    if(balance < 0) balance = 0;
    scheduleSave();
    for(const fn of listeners) { try{ fn(amount, balance); }catch(_){} }
    return true;
  }

  return {
    get(){ return balance; },
    // Доменное API — каждый источник начислений именован. При переезде
    // на сервер клиент будет слать {type, matchId, seq}, а сумма и
    // валидация — на сервере.
    award(type, amount){ return tryAward(type, amount); },
    onChange(fn){ if(typeof fn === "function") listeners.push(fn); },
    matchReset: matchReset,
    // Прямой `add` оставляем ТОЛЬКО для отладки/совместимости. Не
    // использовать из игрового кода — используй award(type, amount).
    _debugAdd(amount){
      balance += amount | 0;
      if(balance < 0) balance = 0;
      scheduleSave();
      for(const fn of listeners) { try{ fn(amount, balance); }catch(_){} }
    }
  };
})();

/* ---- Wallet UI rendering ---- */
const walletEls = [
  { value: $("wallet-balance-menu"), delta: $("wallet-delta-menu") },
  { value: $("wallet-balance-game"), delta: $("wallet-delta-game") }
];
function renderWallet(){
  const v = String(Wallet.get());
  for(const e of walletEls) if(e.value) e.value.textContent = v;
}
// Коалесцируем +N: при частых начислениях (каждое касание мяча) копим сумму и
// анимируем один раз после дебаунс-окна, иначе reflow+рестарт анимации на каждый +1.
let pendingDelta = 0;
let pendingTimer = 0;
function flushWalletDelta(){
  pendingTimer = 0;
  const amount = pendingDelta;
  pendingDelta = 0;
  if(amount <= 0) return;
  for(const e of walletEls){
    if(!e.value || !e.delta) continue;
    e.value.classList.remove("bump");
    e.delta.classList.remove("show");
    void e.delta.offsetWidth;
    e.delta.textContent = "+" + amount;
    e.value.classList.add("bump");
    e.delta.classList.add("show");
  }
}
function flashWalletDelta(amount){
  pendingDelta += amount;
  if(!pendingTimer) pendingTimer = setTimeout(flushWalletDelta, 160);
}
renderWallet();
Wallet.onChange((amount)=>{
  renderWallet();
  if(amount > 0) flashWalletDelta(amount);
});

/* ---------------- Name helpers ---------------- */
// Обрезаем длинные ники по графемам, а не по UTF-16 code units. Иначе
// Discord-ники с эмодзи (а их разрешают) режутся посреди суррогатной пары
// и рендерятся как tofu/garbled. Intl.Segmenter — если доступен (все
// современные браузеры), иначе честный fallback через Array.from, который
// уже правильно разбирает суррогатные пары (но не все комбинирующие марки).
const _graphemeSeg = (typeof Intl !== "undefined" && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
function graphemes(str){
  if(_graphemeSeg){
    const out = [];
    for(const s of _graphemeSeg.segment(str)) out.push(s.segment);
    return out;
  }
  return Array.from(str);
}
function shortenName(name, max){
  const m = max || 12;
  if(!name) return "";
  const g = graphemes(name);
  if(g.length <= m) return name;
  return g.slice(0, m - 1).join("") + "…";
}

function userDisplayName(u){
  return shortenName(u.global_name || u.username || "");
}

function botDisplayName(bot){
  return shortenName(I18n.t("bot.prefix") + " " + (bot.global_name || bot.username || ""));
}

// Динамические строки, которые не переключаются через data-i18n
function refreshLocalizedDynamicUI(){
  if(state.bot){
    $("hud-name-p2").textContent = botDisplayName(state.bot);
  }
  $("hud-diff").textContent = diffLabel(state.difficulty);
  if(window.Game && typeof Game.refreshOverlay === "function") Game.refreshOverlay();
}

/* ---------------- i18n bootstrap ---------------- */
// Применяем переводы сразу, чтобы login-экран уже был на нужном языке,
// затем обновляем сегмент-переключатель и подписываемся на смену языка.
I18n.apply();

const langSeg = $("lang");
function syncLangButtons(){
  const cur = I18n.getLang();
  for(const b of langSeg.children) b.classList.toggle("active", b.dataset.val === cur);
}
syncLangButtons();
langSeg.addEventListener("click", (e)=>{
  const b = e.target.closest("button[data-val]");
  if(!b) return;
  I18n.setLang(b.dataset.val);
});
I18n.onChange(()=>{
  syncLangButtons();
  refreshLocalizedDynamicUI();
});

/* ---------------- Login ---------------- */
$("btn-login").addEventListener("click", () => {
  // Редирект на /auth/discord — обратно вернёмся уже с сессионной cookie,
  // и boot() при перезагрузке увидит Auth.current().
  Auth.login();
});
$("btn-logout").addEventListener("click", async (e) => {
  e.stopPropagation();
  closeUserPopup();
  await Auth.logout();
  state.user = null;
  show("login");
});

/* ---- User avatar popup (аватарка → "Выйти") ---- */
const userCard  = $("user-card");
const userPopup = $("user-popup");
function openUserPopup(){
  userPopup.classList.remove("hidden");
  userCard.setAttribute("aria-expanded", "true");
}
function closeUserPopup(){
  userPopup.classList.add("hidden");
  userCard.setAttribute("aria-expanded", "false");
}
function toggleUserPopup(){
  if(userPopup.classList.contains("hidden")) openUserPopup();
  else closeUserPopup();
}
userCard.addEventListener("click", (e)=>{
  if(e.target.closest(".user-popup")) return;
  toggleUserPopup();
});
userCard.addEventListener("keydown", (e)=>{
  if(e.key === "Enter" || e.key === " "){ e.preventDefault(); toggleUserPopup(); }
  else if(e.key === "Escape") closeUserPopup();
});
document.addEventListener("click", (e)=>{
  if(userPopup.classList.contains("hidden")) return;
  if(!userCard.contains(e.target)) closeUserPopup();
});

function enterMenu(){
  Auth.renderAvatarInto($("user-avatar"), state.user);
  $("user-name").textContent = userDisplayName(state.user);
  show("menu");
}

/* ---------------- Segmented selectors ---------------- */
function wireSegmented(rootId, onChange){
  const root = $(rootId);
  root.addEventListener("click", (e)=>{
    const b = e.target.closest("button[data-val]");
    if(!b) return;
    for(const c of root.children) c.classList.remove("active");
    b.classList.add("active");
    onChange(b.dataset.val);
  });
}
wireSegmented("difficulty", v => state.difficulty = v);
wireSegmented("target-score", v => state.targetScore = parseInt(v,10));

/* ---------------- Start game ---------------- */
$("btn-play").addEventListener("click", () => {
  state.bot = Auth.makeBot();
  Auth.renderAvatarInto($("hud-avatar-p1"), state.user);
  Auth.renderAvatarInto($("hud-avatar-p2"), state.bot);
  $("hud-name-p1").textContent = userDisplayName(state.user);
  $("hud-name-p2").textContent = botDisplayName(state.bot);
  $("hud-diff").textContent = diffLabel(state.difficulty);
  $("hud-score-p1").textContent = "0";
  $("hud-score-p2").textContent = "0";
  show("game");
  resizeCanvas();
  Game.start();
});

function diffLabel(d){ return I18n.t("diff." + (d || "medium")); }

/* ---------------- Canvas sizing ---------------- */
const WORLD_W = 1000, WORLD_H = 500;
let scale = 1, offsetX = 0, offsetY = 0;

// Кап DPR: на 3x-Retina (iPhone) честный рендер в 3× увеличивает площадь
// пикселей в 9 раз по сравнению с 1× — это ощутимо бьёт по мобильным
// iGPU. 2× — компромисс: картинка остаётся чёткой (браузер даунскейлит
// с 2× → 3× без заметного блура), а загрузка GPU стабильна.
const DPR_CAP = 2;
function resizeCanvas(){
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  canvas.width  = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  // На «нормальных» пропорциях (мир 2:1) cover-fit заполняет весь экран
  // без летербоксов. На узких экранах (портретный телефон) cover отрежет
  // половину поля по горизонтали — игроки уедут за край. Поэтому если
  // aspect-ratio экрана уже, чем у мира, переключаемся на contain-fit:
  // летербокс сверху/снизу, зато видно весь корт.
  const worldAspect  = WORLD_W / WORLD_H; // 2.0
  const screenAspect = canvas.width / canvas.height;
  const s = screenAspect >= worldAspect
    ? Math.max(canvas.width / WORLD_W, canvas.height / WORLD_H)
    : Math.min(canvas.width / WORLD_W, canvas.height / WORLD_H);
  scale = s;
  offsetX = (canvas.width  - WORLD_W * s) * 0.5;
  // В cover-режиме якоримся к низу (земля всегда у нижнего края); в
  // contain — центрируем по вертикали.
  offsetY = screenAspect >= worldAspect
    ? canvas.height - WORLD_H * s
    : (canvas.height - WORLD_H * s) * 0.5;
}
window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", resizeCanvas);

/* ---------------- Input ----------------
   We check BOTH e.code (physical key, layout-independent) and e.key
   (logical char) so WAD works on Cyrillic/other layouts where e.key
   returns "ц/ф/в" instead of "w/a/d". */
const keys = { left:false, right:false, jump:false };

function classifyKey(e){
  const code = e.code;
  const k = (e.key || "").toLowerCase();
  if(code === "KeyA" || code === "ArrowLeft"  || k === "a" || k === "arrowleft")  return "left";
  if(code === "KeyD" || code === "ArrowRight" || k === "d" || k === "arrowright") return "right";
  if(code === "KeyW" || code === "ArrowUp" || code === "Space" ||
     k === "w" || k === "arrowup" || k === " " || k === "spacebar") return "jump";
  return null;
}
function clearKeys(){ keys.left = keys.right = keys.jump = false; }
window.addEventListener("keydown", e=>{
  // Никогда не перехватываем системные комбо Ctrl/Cmd+X (Ctrl+R/W/T,
  // закладки, devtools и т.п.) — preventDefault на них ломает браузер.
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(e.repeat) return;
  const act = classifyKey(e);
  if(!act) return;
  keys[act] = true;
  if(state.inGame) e.preventDefault();
}, {passive:false});
window.addEventListener("keyup", e=>{
  const act = classifyKey(e);
  if(act) keys[act] = false;
});
// blur + visibilitychange + pagehide: если мы теряем фокус/видимость,
// ключи и тачи надо сбрасывать, иначе зависают (особенно частая жалоба
// на мобильных — тач-кнопка осталась «нажатой» после переключения вкладки).
window.addEventListener("blur", clearKeys);
window.addEventListener("pagehide", clearKeys);
document.addEventListener("visibilitychange", ()=>{
  if(document.hidden) clearKeys();
});

document.querySelectorAll(".tbtn").forEach(btn=>{
  const k = btn.dataset.key;
  const act = k === "a" ? "left" : k === "d" ? "right" : "jump";
  const on  = (e)=>{ e.preventDefault(); keys[act] = true;  };
  const off = (e)=>{ e.preventDefault(); keys[act] = false; };
  btn.addEventListener("touchstart", on,  {passive:false});
  btn.addEventListener("touchend",   off, {passive:false});
  btn.addEventListener("touchcancel",off, {passive:false});
  if(!isTouch){
    btn.addEventListener("mousedown", on);
    btn.addEventListener("mouseup",   off);
    btn.addEventListener("mouseleave",off);
  }
});

["gesturestart","gesturechange","gestureend"].forEach(ev=>{
  document.addEventListener(ev, e=>e.preventDefault(), {passive:false});
});

/* ---------------- Pause & overlay ---------------- */
const overlay = $("overlay");
const overlayTitle = $("overlay-title");
const overlaySub = $("overlay-sub");
$("btn-pause").addEventListener("click", ()=> Game.pause());
$("btn-resume").addEventListener("click", ()=> Game.resume());
$("btn-replay").addEventListener("click", ()=> Game.start());
$("btn-quit").addEventListener("click", ()=>{
  Game.stop();
  show("menu");
});
$("btn-home").addEventListener("click", ()=>{
  Game.stop();
  show("menu");
});

// Реакции: 26 стикеров Durak Online. Прелодим и строим UI один раз.
// Кэш Image доступен и UI-слою, и рендеру в canvas (через EMOTE_IMAGES).
const EMOTE_IDS = (function(){
  const out = [];
  for(let i = 1; i <= 26; i++) out.push(String(i).padStart(2, "0"));
  return out;
})();
const EMOTE_IMAGES = new Map();
(function preloadAndBuild(){
  const host = document.getElementById("reactions");
  const frag = document.createDocumentFragment();
  for(const id of EMOTE_IDS){
    const src = "assets/emojis/durak_" + id + ".webp";
    const img = new Image();
    img.decoding = "async";
    img.loading  = "eager";
    img.src = src;
    EMOTE_IMAGES.set(id, img);

    const btn = document.createElement("button");
    btn.className = "react-btn";
    btn.dataset.emoteId = id;
    btn.setAttribute("aria-label", "Реакция " + id);

    const thumb = document.createElement("img");
    thumb.src = src;
    thumb.alt = "";
    thumb.draggable = false;
    btn.appendChild(thumb);
    frag.appendChild(btn);
  }
  host.appendChild(frag);
})();

// Отдельный кулдаун на КНОПКУ, чтобы спам по одной эмоции не засыпал экран,
// но можно быстро сменить реакцию.
const REACT_COOLDOWN = 420; // мс
document.getElementById("reactions").addEventListener("click", (ev)=>{
  const btn = ev.target.closest(".react-btn");
  if(!btn) return;
  const now = performance.now();
  const last = +btn.dataset.last || 0;
  if(now - last < REACT_COOLDOWN) return;
  btn.dataset.last = now;
  Game.triggerEmote(1, btn.dataset.emoteId);
  // Снимаем фокус: иначе при клике мышью фокус остаётся на кнопке, и
  // следующие нажатия клавиш (пробел/Enter) ре-триггерят её, а браузер
  // рисует белое кольцо focus-ring поверх пилюли.
  btn.blur();
});

document.addEventListener("visibilitychange", ()=>{
  if(document.hidden && state.inGame && !state.paused && !state.matchOver) Game.pause();
});

/* ========================================================================
   GAME
   ======================================================================== */
const Game = (function(){
  // --- World & tuning — ported from classic Slime Volleyball ratios.
  // Ref: hardmaru/slimevolleygym (Neural Slime Volleyball physics).
  // Players are HEMISPHERES: center sits on the ground line, upper half
  // collides with ball. Lower-hemisphere collisions are physically impossible
  // by construction, which kills a whole class of "ball under the floor" bugs.
  const GRAV      = 1250;
  const MOVE      = 620;
  const JUMP      = 590;   // peak ≈ JUMP²/(2·GRAV) ≈ 139 px (~28% of field)
  const BALL_R    = 17;
  const PLR_R     = 42;    // slightly smaller for more room to maneuver
  const NET_X     = WORLD_W*0.5, NET_W = 14, NET_H = 138;
  const GROUND_Y  = WORLD_H - 30;   // ground line; player's feet rest HERE
  const E_WALL    = 0.85;
  const E_NET     = 0.85;
  const E_GROUND  = 0.60;
  const MAX_BSPD  = 1300;
  const SERVE_SPAWN_Y = -60;
  const POST_POINT_TIME = 1.5;
  const COYOTE   = 0.10;    // grace period after leaving ground
  const JUMP_BUFFER = 0.12; // jump press remembered this long before landing
  const STUCK_SPEED  = 55;
  const STUCK_TIME   = 2.8;
  const STEP = 1/120;

  // Round state
  let rafId = 0, acc = 0, last = 0;
  let p1, p2, ball;
  let score1 = 0, score2 = 0;
  let servingSide = 1;            // 1 left, -1 right
  let roundOver = false;
  let roundTimer = 0;
  let lastWinnerSide = 0;         // выставляется в endMatch — для перерисовки overlay
  let ai;
  let hitFlash = 0;
  let prevJump1 = false;
  let jumpBufferT = 0;
  let stuckT = 0;

  // --- Production polish state ---
  const particles = [];                  // hit spark particles
  const trail = [];                      // ball position trail (newest first)
  const TRAIL_LEN = 10;
  const PARTICLE_CAP = 160;
  let bigText = null;                    // { text, t, dur, color, size }
  // Активные «эмоции» над игроками. Каждая: { emoji, t, dur, side }.
  // side: 1 — игрок (левый), 2 — соперник (правый).
  const emotes = [];
  const EMOTE_DUR = 1.8;
  const squash = { ball:0, p1:0, p2:0 }; // timers that scale targets briefly
  let clouds = null;                     // parallax cloud layer, built once
  let backPanels = null;                 // distant panel layer (parallaxed slower)
  let sparkles = null;                   // faint twinkling dots
  let matchTime = 0;                     // total in-game seconds (for cloud drift)
  let rallyHits = 0;                     // consecutive hits for combo feedback

  // Seedable RNG (mulberry32). Math.random десинкнет P2P/rollback-сценарии
  // в будущем, т.к. разные клиенты будут эволюционировать разные «случайные»
  // состояния. Этот RNG даёт одинаковую последовательность при одинаковом
  // сиде. Сид пересевается в resetMatch (и может браться с сервера при
  // подключении онлайна). Возвращает [0,1), как Math.random.
  let _rngState = 0x9E3779B1 | 0;
  function rng(){
    let t = (_rngState = (_rngState + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function seedRng(seed){ _rngState = (seed | 0) || 1; }

  function makePlayer(x, side){
    // Feet rest on the ground: player.y is the CENTER, one radius above the floor.
    return { x, y: GROUND_Y - PLR_R, vx:0, vy:0, r: PLR_R, onGround:true, coyoteT:0, side };
  }

  /* ------------- Polish: FX helpers ------------- */
  // Audio is intentionally disabled — stubs kept so call sites stay tidy.
  const noop = ()=>{};
  const sfx = {
    hit: noop, spike: noop, net: noop, jump: noop, bounce: noop,
    serve: noop, point: noop, lose: noop, win: noop
  };

  function spawnParticles(x, y, count, color, speed){
    for(let i=0;i<count && particles.length < PARTICLE_CAP; i++){
      const a = rng()*Math.PI*2;
      const s = speed * (0.4 + rng()*0.8);
      particles.push({
        x, y,
        vx: Math.cos(a)*s, vy: Math.sin(a)*s - speed*0.3,
        life: 0.45 + rng()*0.3,
        age: 0,
        size: 2 + rng()*3,
        color
      });
    }
  }

  function showBig(text, color, dur, size){
    bigText = { text, t:0, dur: dur||0.9, color: color||"#ffffff", size: size||84 };
  }

  // Публичный триггер реакции. Ограничиваем до 3-х одновременно на сторону,
  // чтобы спам кликов не засыпал экран — более старая замещается новой.
  function triggerEmote(side, id){
    if(!state.inGame || state.matchOver) return;
    if(!id) return;
    let count = 0;
    for(const e of emotes) if(e.side === side) count++;
    if(count >= 3){
      for(let i=0;i<emotes.length;i++){
        if(emotes[i].side === side){ emotes.splice(i,1); break; }
      }
    }
    emotes.push({ id, t:0, dur: EMOTE_DUR, side });
  }

  function buildClouds(){
    // Deterministic backdrop: drifting Discord-style "server icons" and chat-bubble marks.
    const arr = [];
    const rng = (n)=> ((Math.sin(n*12.9898)*43758.5453) % 1 + 1) % 1;
    // Discord brand palette
    const palette = ["#5865f2","#4752c4","#23a55a","#f0b232","#f23f42","#949ba4","#ffffff"];
    const marks = ["#","@","/","&","!","?","+"];
    for(let i=0;i<10;i++){
      const k = rng(i+97);
      arr.push({
        x:     rng(i+1)  * WORLD_W,
        y:     30 + rng(i+13) * 230,
        size:  24 + rng(i+29) * 22,
        speed: 4 + rng(i+41) * 8,
        alpha: 0.14 + rng(i+71) * 0.18,
        kind:  k < 0.45 ? "logo" : (k < 0.80 ? "icon" : "bubble"),
        color: palette[(rng(i+113)*palette.length)|0],
        mark:  marks[(rng(i+131)*marks.length)|0],
        tilt:  (rng(i+149)*2 - 1) * 0.18
      });
    }
    return arr;
  }

  // Far-background "server panel" rectangles — large, desaturated, drift slowly.
  function buildBackPanels(){
    const arr = [];
    const rng = (n)=> ((Math.sin(n*78.233)*12345.678) % 1 + 1) % 1;
    for(let i=0;i<5;i++){
      arr.push({
        x:     rng(i+3)  * WORLD_W,
        y:     40 + rng(i+17) * (GROUND_Y - 180),
        w:     180 + rng(i+29) * 180,
        h:     60  + rng(i+37) * 60,
        speed: 1.5 + rng(i+53) * 2.5,
        alpha: 0.05 + rng(i+61) * 0.05
      });
    }
    return arr;
  }

  // Tiny sparkle field — faint stars/dots that slowly twinkle.
  function buildSparkles(){
    const arr = [];
    const rng = (n)=> ((Math.sin(n*91.123)*54321.987) % 1 + 1) % 1;
    for(let i=0;i<40;i++){
      arr.push({
        x:     rng(i+2)  * WORLD_W,
        y:     rng(i+19) * (GROUND_Y - 30),
        r:     0.6 + rng(i+31) * 1.4,
        phase: rng(i+43) * Math.PI*2,
        freq:  1.2 + rng(i+57) * 2.0
      });
    }
    return arr;
  }

  // Rounded rectangle helper (path only — caller fills/strokes).
  function roundRect(x, y, w, h, r){
    const rr = Math.min(r, w*0.5, h*0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function spawnPlayers(){
    p1 = makePlayer(WORLD_W*0.25,  1);
    p2 = makePlayer(WORLD_W*0.75, -1);
  }

  // Ball spawns above the visible area over the serving player and falls in
  // under gravity. No freeze — physics run continuously so the drop is visible.
  function serveBall(){
    const serverX = servingSide===1 ? WORLD_W*0.25 : WORLD_W*0.75;
    // Offset toward center so the serve arcs toward the net
    const offset  = servingSide===1 ? 40 : -40;
    ball = {
      x: serverX + offset,
      y: SERVE_SPAWN_Y,
      vx: 0, vy: 0,
      r: BALL_R,
      angle: 0,
      touches: { left:0, right:0 }
    };
    trail.length = 0;
    hitFlash = 0;
    squash.ball = 0;
    rallyHits = 0;
    sfx.serve();
    showBig(I18n.t(servingSide === 1 ? "game.serve_you" : "game.serve_opp"),
            servingSide === 1 ? "#ffffff" : "#b5bac1",
            0.8, servingSide === 1 ? 62 : 46);
  }

  function resetMatch(){
    score1 = 0; score2 = 0;
    state.matchOver = false;
    lastWinnerSide = 0;
    servingSide = 1;
    roundOver = false;
    prevJump1 = false;
    jumpBufferT = 0;
    stuckT = 0;
    rallyHits = 0;
    hitFlash = 0;
    matchTime = 0;
    particles.length = 0;
    emotes.length = 0;
    trail.length = 0;
    squash.ball = squash.p1 = squash.p2 = 0;
    bigText = null;
    if(!clouds)      clouds     = buildClouds();
    if(!backPanels)  backPanels = buildBackPanels();
    if(!sparkles)    sparkles   = buildSparkles();
    // Сброс счётчиков rate-limit кошелька на новый матч, иначе лимиты
    // «maxPerMatch» останутся от предыдущего.
    Wallet.matchReset();
    // Новая сессия: свой matchId, seq=0. В онлайне именно его мы будем
    // слать на сервер при каждом награждении/вводе.
    state.session = newSession();
    // Пересеиваем детерминированный RNG от matchId — одна и та же строка
    // даст одну и ту же последовательность на всех клиентах. Подойдёт,
    // пока сервер не пришлёт авторитетный seed в join-ответе.
    let sh = 0;
    for(let i = 0; i < state.session.matchId.length; i++){
      sh = ((sh * 31) + state.session.matchId.charCodeAt(i)) | 0;
    }
    seedRng(sh || 1);
    spawnPlayers();
    serveBall();
    $("hud-score-p1").textContent = "0";
    $("hud-score-p2").textContent = "0";
  }

  function start(){
    state.inGame = true;
    state.paused = false;
    overlay.classList.add("hidden");
    // Clear any stuck input from the menu
    keys.left = keys.right = keys.jump = false;
    resetMatch();
    ai = makeAI(state.difficulty, rng);
    last = Clock.now();
    acc = 0;
    cancelAnimationFrame(rafId);
    // Render a frame immediately so the scene isn't black before first rAF tick
    render();
    rafId = requestAnimationFrame(loop);
  }

  function stop(){
    state.inGame = false;
    state.paused = false;
    state.matchOver = false;
    state.session = null;
    lastWinnerSide = 0;
    cancelAnimationFrame(rafId);
    overlay.classList.add("hidden");
  }

  function pause(){
    if(!state.inGame || state.paused || state.matchOver) return;
    state.paused = true;
    // Сбрасываем удерживаемые клавиши: после авто-паузы по
    // visibilitychange OS не пришлёт keyup, и игрок на resume
    // неожиданно стартует в движении.
    keys.left = keys.right = keys.jump = false;
    overlayTitle.textContent = I18n.t("game.pause");
    overlaySub.textContent = "";
    $("btn-resume").style.display = "";
    $("btn-replay").style.display = "none";
    overlay.classList.remove("hidden");
  }
  function resume(){
    if(!state.paused) return;
    state.paused = false;
    overlay.classList.add("hidden");
    last = Clock.now();
    acc = 0;
  }

  function endMatch(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // Keep the simulation running in the background (ball/players coast on
    // inertia, backdrop keeps drifting). Only input is gated — see step().
    overlayTitle.textContent = I18n.t(winnerSide===1 ? "game.victory" : "game.defeat");
    const name = winnerSide===1 ? ($("hud-name-p1").textContent) : ($("hud-name-p2").textContent);
    overlaySub.textContent = name + " — " + score1 + " : " + score2;
    $("btn-resume").style.display = "none";
    $("btn-replay").style.display = "";
    overlay.classList.remove("hidden");
    // Drop any keys the user was still holding so players don't keep accelerating.
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      Wallet.award("match.win", 50);
    }else{
      sfx.lose();
    }
  }

  /* ------------- Physics ------------- */
  function step(dt){
    // Tick polish timers (particles, trail, squash, big text, clouds).
    // Оборачиваем matchTime, чтобы на длинных сессиях синусы/модульные расчёты
    // не теряли точность. Период кратен 2π (≈17 ч), так что sin-анимации
    // (блики, покачивание тени) остаются непрерывными на границе.
    matchTime = (matchTime + dt) % (Math.PI * 20000);
    for(let i = particles.length - 1; i >= 0; i--){
      const pt = particles[i];
      pt.age += dt;
      if(pt.age >= pt.life){ particles.splice(i, 1); continue; }
      pt.vy += GRAV * 0.35 * dt;
      pt.x  += pt.vx * dt;
      pt.y  += pt.vy * dt;
    }
    if(squash.ball > 0) squash.ball = Math.max(0, squash.ball - dt);
    if(squash.p1  > 0)  squash.p1   = Math.max(0, squash.p1  - dt);
    if(squash.p2  > 0)  squash.p2   = Math.max(0, squash.p2  - dt);
    if(bigText){
      bigText.t += dt;
      if(bigText.t >= bigText.dur) bigText = null;
    }
    for(let i = emotes.length - 1; i >= 0; i--){
      emotes[i].t += dt;
      if(emotes[i].t >= emotes[i].dur) emotes.splice(i, 1);
    }
    // Ball motion trail — prepend current pos each step, cap length
    trail.unshift({ x: ball.x, y: ball.y });
    if(trail.length > TRAIL_LEN) trail.length = TRAIL_LEN;

    // Post-point countdown (ball still bouncing, players can still move).
    // Не запускаем новый раунд после окончания матча — мяч остаётся там,
    // где был забит последний гол, всё докатывается по инерции.
    if(roundOver && !state.matchOver){
      roundTimer -= dt;
      if(roundTimer <= 0){
        roundOver = false;
        spawnPlayers();
        serveBall();
        return;
      }
    }

    // Controls — disabled after the match ends; both slimes coast on inertia.
    if(!state.matchOver){
      applyHumanInput(p1, dt);
      const aIn = ai.decide(p2, ball, dt);
      applyInput(p2, aIn.left, aIn.right, aIn.jump);
    }

    // Players
    integratePlayer(p1, dt, 0, NET_X - NET_W*0.5);
    integratePlayer(p2, dt, NET_X + NET_W*0.5, WORLD_W);

    // После завершения матча плавно гасим инерцию — мяч и игроки катятся
    // всё медленнее и приходят в покой через пару секунд, вместо того чтобы
    // бесконечно прыгать. Полупериод ≈ 0.75 с.
    if(state.matchOver){
      const damp = Math.pow(0.4, dt);
      ball.vx *= damp;
      p1.vx *= damp;
      p2.vx *= damp;
    }

    // Ball integrate — pure gravity, no drag (classic slime physics).
    ball.vy += GRAV * dt;
    const sp2 = ball.vx*ball.vx + ball.vy*ball.vy;
    if(sp2 > MAX_BSPD*MAX_BSPD){
      const k = MAX_BSPD / Math.sqrt(sp2);
      ball.vx *= k; ball.vy *= k;
    }

    if(hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt*4);

    // CCD: при высокой скорости одно перемещение за кадр может превысить радиус
    // мяча (MAX_BSPD * STEP ≈ 10.8 px vs. r=17), что теоретически приводит к
    // прохождению сквозь сетку/игрока на пике удара. Разбиваем движение на
    // под-шаги такого размера, чтобы за один под-шаг мяч смещался не более
    // чем на половину своего радиуса — коллизии проверяются на каждом.
    const travel = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy) * dt;
    const maxPerSub = ball.r * 0.5;
    const subs = Math.max(1, Math.ceil(travel / maxPerSub));
    const subDt = dt / subs;
    for(let s = 0; s < subs; s++){
      ball.x += ball.vx * subDt;
      ball.y += ball.vy * subDt;
      ball.angle += ball.vx * subDt * 0.025;

      // Side walls only — no ceiling, the ball can arc arbitrarily high
      if(ball.x < ball.r){ ball.x = ball.r; ball.vx = -ball.vx * E_WALL; }
      if(ball.x > WORLD_W - ball.r){ ball.x = WORLD_W - ball.r; ball.vx = -ball.vx * E_WALL; }

      collideBallNet();
      if(!roundOver && !state.matchOver){
        collideBallPlayer(p1);
        if(!roundOver) collideBallPlayer(p2);
      }

      // Ground: award point on first touch, then keep bouncing for POST_POINT_TIME.
      if(ball.y + ball.r >= GROUND_Y && ball.vy > 0){
        const impactSpeed = Math.abs(ball.vy);
        ball.y = GROUND_Y - ball.r;
        ball.vy = -impactSpeed * E_GROUND;
        ball.vx *= 0.96;
        if(impactSpeed > 80){
          sfx.bounce();
          spawnParticles(ball.x, GROUND_Y - 2, Math.min(12, 4 + (impactSpeed/120)|0), "rgba(255,255,255,1)", 180);
          squash.ball = 0.12;
        }
        if(!roundOver && !state.matchOver){
          if(ball.x < NET_X) awardPoint(2);
          else               awardPoint(1);
          break; // очко присуждено — прекращаем под-шаги этого кадра
        }
      }
    }

    // Stuck-ball watchdog: if the ball loiters at near-zero speed (e.g. pinned
    // between a player and the net) for too long during a live rally, award
    // the point to whoever's side the ball is NOT on and move on.
    if(!roundOver && !state.matchOver){
      const sp = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
      if(sp < STUCK_SPEED) stuckT += dt;
      else                 stuckT = 0;
      if(stuckT > STUCK_TIME){
        stuckT = 0;
        awardPoint(ball.x < NET_X ? 2 : 1);
      }
    }else{
      stuckT = 0;
    }
  }

  function applyInput(p, left, right, jump){
    let ax = 0;
    if(left)  ax -= 1;
    if(right) ax += 1;
    p.vx = ax * MOVE;
    if(jump && p.onGround){
      p.vy = -JUMP;
      p.onGround = false;
      sfx.jump();
    }
  }

  // Human control with coyote time + jump buffer. Buffer: a press within
  // JUMP_BUFFER seconds before landing still triggers a jump. Coyote: a press
  // within COYOTE seconds after walking off a ledge still jumps. Both make the
  // controls feel forgiving without changing visible physics.
  function applyHumanInput(p, dt){
    const left = keys.left, right = keys.right, jumpHeld = keys.jump;
    let ax = 0;
    if(left)  ax -= 1;
    if(right) ax += 1;
    p.vx = ax * MOVE;

    // Edge detect: fresh press fills the buffer; otherwise decay it
    if(jumpHeld && !prevJump1) jumpBufferT = JUMP_BUFFER;
    else                       jumpBufferT = Math.max(0, jumpBufferT - dt);
    prevJump1 = jumpHeld;

    if(p.onGround) p.coyoteT = COYOTE;
    else           p.coyoteT = Math.max(0, p.coyoteT - dt);

    if(jumpBufferT > 0 && p.coyoteT > 0){
      p.vy = -JUMP;
      p.onGround = false;
      jumpBufferT = 0;
      p.coyoteT  = 0;
      sfx.jump();
    }
  }

  function integratePlayer(p, dt, xMin, xMax){
    const wasInAir = !p.onGround;
    const impactVy = p.vy;
    p.vy += GRAV * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if(p.x < xMin + p.r) p.x = xMin + p.r;
    if(p.x > xMax - p.r) p.x = xMax - p.r;
    // Lands when the bottom of the circle touches the ground line.
    if(p.y + p.r >= GROUND_Y){
      p.y = GROUND_Y - p.r;
      p.vy = 0;
      p.onGround = true;
      if(wasInAir && impactVy > 120){
        if(p.side === 1) squash.p1 = 0.18;
        else             squash.p2 = 0.18;
        spawnParticles(p.x, GROUND_Y - 2, Math.min(8, (impactVy/110)|0), "rgba(255,255,255,0.9)", 120);
      }
    }
  }

  function collideBallNet(){
    const left = NET_X - NET_W*0.5, right = NET_X + NET_W*0.5;
    const top  = GROUND_Y - NET_H,  bot   = GROUND_Y;
    const cx = Math.max(left, Math.min(ball.x, right));
    const cy = Math.max(top,  Math.min(ball.y, bot));
    let nx = ball.x - cx, ny = ball.y - cy;
    const d2 = nx*nx + ny*ny;
    if(d2 >= ball.r*ball.r) return;
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
      if(hitPower > 90){
        sfx.net();
        spawnParticles(ball.x, ball.y, 6, "rgba(255,255,255,0.9)", 140);
        squash.ball = Math.max(squash.ball, 0.08);
      }
    }
  }

  // Classic Slime Volleyball bounce (hardmaru/slimevolleygym):
  // elastic circle-on-circle reflection with factor of 2 inherits player velocity.
  // Full-circle collision — the floor-guard at the end keeps the ball above ground
  // even on rare lower-hemisphere contacts.
  function collideBallPlayer(p){
    let nx = ball.x - p.x;
    let ny = ball.y - p.y;
    const rr = p.r + ball.r;
    const d2 = nx*nx + ny*ny;
    if(d2 >= rr*rr) return;
    const d = Math.sqrt(d2);
    if(d < 0.0001){
      // Degenerate: ball embedded at player center. Eject straight up.
      nx = 0; ny = -1;
    }else{
      nx /= d; ny /= d;
    }
    // Separate: place ball exactly at surface
    ball.x = p.x + nx * rr;
    ball.y = p.y + ny * rr;
    // Classic bounce: relative velocity, factor of 2, then add back player vel
    let ux = ball.vx - p.vx;
    let uy = ball.vy - p.vy;
    const un = ux*nx + uy*ny;
    if(un < 0){
      ux -= 2 * un * nx;
      uy -= 2 * un * ny;
      ball.vx = ux + p.vx;
      ball.vy = uy + p.vy;
    }
    // Floor guard: if separation pushed the ball into the ground plane, lift it
    // above and flip vy upward so the rally continues instead of awarding a bogus point.
    if(ball.y + ball.r > GROUND_Y - 1){
      ball.y = GROUND_Y - ball.r - 1;
      if(ball.vy > 0) ball.vy = -Math.max(180, Math.abs(ball.vy) * 0.7);
    }
    // Clamp max speed
    const sp2 = ball.vx*ball.vx + ball.vy*ball.vy;
    if(sp2 > MAX_BSPD*MAX_BSPD){
      const k = MAX_BSPD / Math.sqrt(sp2);
      ball.vx *= k; ball.vy *= k;
    }
    hitFlash = 1;

    // Feel: sparks, squash, sound — scaled by hit strength
    const isSpike = !p.onGround && ny < -0.3 && ball.vy > 200;
    const cx = p.x + nx * (p.r + ball.r*0.3);
    const cy = p.y + ny * (p.r + ball.r*0.3);
    spawnParticles(cx, cy, isSpike ? 14 : 8, isSpike ? "rgba(255,220,120,1)" : "rgba(255,255,255,0.95)", isSpike ? 320 : 220);
    squash.ball = Math.max(squash.ball, isSpike ? 0.16 : 0.11);
    if(isSpike) sfx.spike(); else sfx.hit();
    rallyHits++;
    // Монеты — только за касания игрока (p.side === 1). Касания бота
    // не начисляют ничего. Комбо-бонус тоже идёт, только если отметка
    // кратная 5 пришлась на удар игрока.
    const isPlayerHit = (p.side === 1);
    if(isPlayerHit) Wallet.award("rally.hit", 1);
    if(rallyHits > 0 && rallyHits % 5 === 0){
      showBig("x" + rallyHits, "#ffd34a", 0.6, 52);
      if(isPlayerHit) Wallet.award("rally.combo", rallyHits);
    }
    // 4-touch rule
    if(p.side === 1){ ball.touches.left++;  ball.touches.right = 0; }
    else            { ball.touches.right++; ball.touches.left  = 0; }
    if(ball.touches.left  >= 4){ awardPoint(2); return; }
    if(ball.touches.right >= 4){ awardPoint(1); return; }
  }

  function awardPoint(side){
    if(roundOver) return;
    roundOver = true;
    roundTimer = POST_POINT_TIME;
    rallyHits = 0;
    if(side===1){ score1++; servingSide = 1; }
    else        { score2++; servingSide = -1; }
    const elA = $("hud-score-p1"), elB = $("hud-score-p2");
    elA.textContent = score1; elB.textContent = score2;
    // Trigger CSS pulse on the scored side
    const pulseEl = side === 1 ? elA : elB;
    pulseEl.classList.remove("pulse");
    void pulseEl.offsetWidth; // reflow to restart animation
    pulseEl.classList.add("pulse");
    spawnParticles(ball.x, GROUND_Y - 2, 22, side === 1 ? "rgba(35,165,90,1)" : "rgba(242,63,66,1)", 260);
    if(side === 1){ showBig(I18n.t("game.point"), "#23a55a", 0.9, 96); sfx.point(); }
    else          { showBig(I18n.t("game.miss"),  "#f23f42", 0.9, 80); sfx.lose(); }
    // Монеты: +5 за выигранное очко (только для игрока).
    if(side === 1) Wallet.award("round.win", 5);
    const t = state.targetScore;
    if((score1 >= t || score2 >= t) && Math.abs(score1 - score2) >= 2){
      endMatch(score1 > score2 ? 1 : 2);
    }
  }

  /* ------------- Render ------------- */
  function render(){
    if(!p1) return;
    const cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0,0,cw,ch);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    // Clip every world-space draw to the playfield rect so clouds, particles,
    // big text etc. never bleed into the letterbox bars on wide screens.
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_W, WORLD_H);
    ctx.clip();

    // Sky gradient
    ctx.fillStyle = skyGrad();
    ctx.fillRect(0,0,WORLD_W,WORLD_H);

    drawBackdropGlow();
    drawChannelGrid();
    drawBackPanels();
    drawSparkles();
    drawClouds();
    drawNetHalo();

    // Court + base line (Discord sidebar / channel list vibe)
    ctx.fillStyle = "#232428";
    ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0, GROUND_Y, WORLD_W, 4);
    // Court center marker line on ground (subtle)
    ctx.fillStyle = "rgba(88,101,242,0.25)";
    ctx.fillRect(NET_X - 1, GROUND_Y + 6, 2, 14);

    drawNet();
    drawTrail();
    drawPlayer(p1, state.user);
    drawPlayer(p2, state.bot);
    drawServeIndicator();
    drawBall();
    drawParticles();
    drawEmotes();
    drawBigText();

    ctx.restore();
  }

  // Thin horizontal "chat row" divider lines — very subtle, evokes Discord's
  // message list without competing with gameplay.
  function drawChannelGrid(){
    ctx.strokeStyle = "rgba(255,255,255,0.025)";
    ctx.lineWidth = 1;
    const step = 36;
    const offset = (matchTime * 6) % step;
    for(let y = -offset; y < GROUND_Y; y += step){
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
      ctx.stroke();
    }
    // Left "sidebar" tint — hints at the server-list column.
    ctx.fillStyle = sidebarGrad();
    ctx.fillRect(0, 0, 140, GROUND_Y);
  }

  // Far-back rounded panels — slow parallax, heavy blur-ish desaturation.
  function drawBackPanels(){
    if(!backPanels) return;
    ctx.save();
    for(const p of backPanels){
      const x = ((p.x + matchTime * p.speed) % (WORLD_W + p.w + 100)) - p.w - 50;
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = "#ffffff";
      roundRect(x, p.y, p.w, p.h, 18);
      ctx.fill();
      // Fake "avatar + text rows" inside the panel
      ctx.globalAlpha = p.alpha * 1.6;
      ctx.fillStyle = "#5865f2";
      ctx.beginPath();
      ctx.arc(x + 24, p.y + 24, 10, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x + 42, p.y + 18, p.w - 60, 4);
      ctx.fillRect(x + 42, p.y + 28, (p.w - 60)*0.6, 4);
      if(p.h > 80){
        ctx.fillRect(x + 42, p.y + 44, (p.w - 60)*0.8, 4);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Tiny blinking dots scattered across the sky.
  function drawSparkles(){
    if(!sparkles) return;
    ctx.fillStyle = "#ffffff";
    for(const s of sparkles){
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(matchTime * s.freq + s.phase));
      ctx.globalAlpha = 0.08 + tw * 0.18;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Soft Blurple halo behind the net, so it reads against the dark backdrop.
  function drawNetHalo(){
    const cx = NET_X, cy = GROUND_Y - NET_H * 0.55;
    ctx.fillStyle = netHaloGrad();
    ctx.fillRect(cx - 180, cy - 180, 360, 360);
  }

  // Soft Blurple ambient glow from the upper-right, like a light source behind
  // a Discord channel panel. Replaces the old sun.
  function drawBackdropGlow(){
    ctx.fillStyle = backdropGlow1();
    ctx.fillRect(0, 0, WORLD_W, GROUND_Y);
    ctx.fillStyle = backdropGlow2();
    ctx.fillRect(0, 0, WORLD_W, GROUND_Y);
  }

  // Каждое облако — набор статичных векторных фигур, которые мы раньше
  // рисовали на главный canvas каждый кадр. Рендерим их в офскрин-спрайт
  // один раз и дальше просто blit'им через drawImage (+ translate/rotate),
  // чтобы освободить 2D-контекст от десятков path-команд за кадр.
  function buildCloudSprite(c){
    const s = c.size;
    // Запас в два раза от размера — хватает с полями для чат-бабла с хвостом.
    const side = Math.ceil(s * 2.4);
    const off = document.createElement("canvas");
    off.width = side;
    off.height = side;
    const octx = off.getContext("2d");
    const cx = side / 2, cy = side / 2;
    if(c.kind === "logo"){
      drawCloudLogo(octx, cx, cy, s, c.color);
    } else if(c.kind === "icon"){
      drawCloudIcon(octx, cx, cy, s, c.color, c.mark);
    } else {
      drawCloudBubble(octx, cx, cy, s, c.color);
    }
    c._sprite = off;
    c._spriteHalf = side / 2;
  }

  function drawCloudLogo(g, x, y, s, color){
    const w = s*1.3, h = s, rr = s*0.35;
    g.fillStyle = color;
    pathRoundRect(g, x - w/2, y - h/2, w, h, rr);
    g.fill();
    g.fillStyle = "#1e1f22";
    g.beginPath();
    g.ellipse(x - w*0.18, y, s*0.085, s*0.14, 0, 0, Math.PI*2);
    g.ellipse(x + w*0.18, y, s*0.085, s*0.14, 0, 0, Math.PI*2);
    g.fill();
  }
  function drawCloudIcon(g, x, y, s, color, mark){
    const w = s*1.15, h = s*1.15, rr = s*0.28;
    g.fillStyle = color;
    pathRoundRect(g, x - w/2, y - h/2, w, h, rr);
    g.fill();
    g.fillStyle = "rgba(30,31,34,0.85)";
    g.font = "900 " + Math.round(s*0.8) + "px system-ui,sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(mark || "#", x, y + s*0.04);
  }
  function drawCloudBubble(g, x, y, s, color){
    const w = s*1.6, h = s*0.95, rr = s*0.32;
    g.fillStyle = color;
    pathRoundRect(g, x - w/2, y - h/2, w, h, rr);
    g.fill();
    g.beginPath();
    g.moveTo(x - w*0.22, y + h/2 - 1);
    g.lineTo(x - w*0.42, y + h/2 + s*0.35);
    g.lineTo(x - w*0.08, y + h/2 - 1);
    g.closePath();
    g.fill();
    g.fillStyle = "rgba(30,31,34,0.7)";
    const dotR = s*0.08;
    for(let i=-1;i<=1;i++){
      g.beginPath();
      g.arc(x + i*s*0.28, y, dotR, 0, Math.PI*2);
      g.fill();
    }
  }
  function pathRoundRect(g, x, y, w, h, r){
    const rr = Math.min(r, w*0.5, h*0.5);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }

  function drawClouds(){
    if(!clouds) return;
    for(const c of clouds){
      if(!c._sprite) buildCloudSprite(c);
      const x = ((c.x + matchTime * c.speed) % (WORLD_W + 160)) - 80;
      ctx.save();
      ctx.globalAlpha = c.alpha;
      ctx.translate(x, c.y);
      ctx.rotate(c.tilt);
      ctx.drawImage(c._sprite, -c._spriteHalf, -c._spriteHalf);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawNet(){
    const left = NET_X - NET_W*0.5, top = GROUND_Y - NET_H;
    // Posts (subtle gradient)
    ctx.fillStyle = netPostsGrad();
    ctx.fillRect(left, top + 4, NET_W, NET_H - 4);

    // Mesh texture — grid lines inside the post area
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    for(let y = top + 10; y < GROUND_Y - 2; y += 10){
      ctx.beginPath(); ctx.moveTo(left + 1, y); ctx.lineTo(left + NET_W - 1, y); ctx.stroke();
    }

    // Top band — Blurple cap
    ctx.fillStyle = "#5865f2";
    ctx.fillRect(left - 2, top - 5, NET_W + 4, 8);
    ctx.fillStyle = "#4752c4";
    ctx.fillRect(left - 2, top + 2, NET_W + 4, 2);
  }

  function drawTrail(){
    // Fade from oldest to newest; only while ball is moving fast enough
    const speed2 = ball.vx*ball.vx + ball.vy*ball.vy;
    if(speed2 < 260*260) return;
    for(let i = 1; i < trail.length; i++){
      const pt = trail[i];
      const a = (1 - i/trail.length) * 0.35;
      const r = ball.r * (1 - i/trail.length*0.6);
      ctx.fillStyle = "rgba(255,255,255," + a + ")";
      ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI*2); ctx.fill();
    }
  }

  function drawParticles(){
    for(const pt of particles){
      const k = 1 - pt.age/pt.life;
      ctx.globalAlpha = k;
      ctx.fillStyle = pt.color;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size * k, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* Анимация эмоции над головой игрока:
     1) 0–18% — упругий pop-in: scale 0 → 1.25 (easeOutBack), старт на
        уровне головы, чуть подлетает вверх;
     2) 18–30% — осадка 1.25 → 1.0, продолжая подниматься;
     3) 30–100% — медленный плавающий дрейф вверх, мягкое покачивание
        (sin) и небольшое вращение в противофазе; последние 40% плавный
        fade-out.
     Под эмодзи рисуем мягкую «тень» (круг с размытием-имитацией), чтобы
     читалось и на светлом бэкдропе. */
  function drawEmote(e){
    const k = Math.min(1, Math.max(0, e.t / e.dur));
    const p = e.side === 1 ? p1 : p2;
    if(!p) return;

    // Scale phase
    let scale;
    if(k < 0.18){
      const u = k / 0.18;                 // 0 → 1
      const eb = 1 - Math.pow(1 - u, 3);  // easeOutCubic
      scale = eb * 1.25;
    } else if(k < 0.30){
      const u = (k - 0.18) / 0.12;        // 0 → 1
      scale = 1.25 - u * 0.25;            // → 1.0
    } else {
      scale = 1.0;
    }

    // Float/drift
    const rise = -30 - k * 80;            // всё время плывёт вверх
    const wobble = Math.sin((k * Math.PI * 2) + e.side) * 6;
    const rot = Math.sin(k * Math.PI * 3) * 0.10;

    // Fade-out на хвосте
    const alpha = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);

    const headY = p.y - p.r - 24;
    const cx = p.x + wobble;
    const cy = headY + rise;
    const size = 42;

    const img = EMOTE_IMAGES.get(e.id);
    if(!img || !img.complete || !img.naturalWidth) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);

    const half = size * 0.75;
    ctx.drawImage(img, -half, -half, half * 2, half * 2);

    ctx.restore();
  }

  function drawEmotes(){
    for(const e of emotes) drawEmote(e);
    ctx.globalAlpha = 1;
  }

  function drawServeIndicator(){
    // Small arrow above the server's head until they first hit the ball
    if(rallyHits > 0 || roundOver) return;
    const sx = servingSide === 1 ? p1.x : p2.x;
    const sy = (servingSide === 1 ? p1.y : p2.y) - (servingSide === 1 ? p1.r : p2.r) - 18;
    const bob = Math.sin(matchTime * 6) * 3;
    ctx.fillStyle = "#ffd34a";
    ctx.beginPath();
    ctx.moveTo(sx,     sy + bob + 10);
    ctx.lineTo(sx - 8, sy + bob);
    ctx.lineTo(sx + 8, sy + bob);
    ctx.closePath();
    ctx.fill();
  }

  function drawBigText(){
    if(!bigText) return;
    const k = bigText.t / bigText.dur;
    // Ease in/out alpha + scale pop
    const alpha = k < 0.15 ? (k/0.15) : k > 0.8 ? (1 - (k-0.8)/0.2) : 1;
    const scalePop = k < 0.15 ? (0.6 + k/0.15 * 0.5) : 1 + Math.min(0.1, (k-0.15)*0.3);
    ctx.save();
    ctx.translate(WORLD_W*0.5, WORLD_H*0.42);
    ctx.scale(scalePop, scalePop);
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 " + bigText.size + "px system-ui,sans-serif";
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(bigText.text, 0, 0);
    ctx.fillStyle = bigText.color;
    ctx.fillText(bigText.text, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Кэш статичных градиентов: форма фиксирована, цвета не меняются — создаём
  // объекты лениво один раз, вместо пересоздания каждый кадр.
  let _skyGrad = null, _sidebarGrad = null, _netHaloGrad = null,
      _backdropGlow1 = null, _backdropGlow2 = null, _netPostsGrad = null,
      _ballNormalGrad = null, _ballFlashGrad = null;

  function skyGrad(){
    if(_skyGrad) return _skyGrad;
    // Discord dark-mode feel: near-black at top fading into the "chat panel" tone.
    const g = ctx.createLinearGradient(0,0,0,GROUND_Y);
    g.addColorStop(0,    "#1e1f22");
    g.addColorStop(0.55, "#2b2d31");
    g.addColorStop(1,    "#313338");
    _skyGrad = g;
    return g;
  }
  function sidebarGrad(){
    if(_sidebarGrad) return _sidebarGrad;
    const g = ctx.createLinearGradient(0, 0, 140, 0);
    g.addColorStop(0, "rgba(30,31,34,0.55)");
    g.addColorStop(1, "rgba(30,31,34,0)");
    _sidebarGrad = g;
    return g;
  }
  function netHaloGrad(){
    if(_netHaloGrad) return _netHaloGrad;
    const cx = NET_X, cy = GROUND_Y - NET_H * 0.55;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 180);
    g.addColorStop(0, "rgba(88,101,242,0.22)");
    g.addColorStop(1, "rgba(88,101,242,0)");
    _netHaloGrad = g;
    return g;
  }
  function backdropGlow1(){
    if(_backdropGlow1) return _backdropGlow1;
    const sx = WORLD_W*0.78, sy = 110;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 320);
    g.addColorStop(0, "rgba(88,101,242,0.38)");
    g.addColorStop(0.55, "rgba(88,101,242,0.10)");
    g.addColorStop(1, "rgba(88,101,242,0)");
    _backdropGlow1 = g;
    return g;
  }
  function backdropGlow2(){
    if(_backdropGlow2) return _backdropGlow2;
    const g = ctx.createRadialGradient(WORLD_W*0.18, GROUND_Y*0.7, 0, WORLD_W*0.18, GROUND_Y*0.7, 260);
    g.addColorStop(0, "rgba(35,165,90,0.18)");
    g.addColorStop(1, "rgba(35,165,90,0)");
    _backdropGlow2 = g;
    return g;
  }
  function netPostsGrad(){
    if(_netPostsGrad) return _netPostsGrad;
    const left = NET_X - NET_W*0.5;
    const g = ctx.createLinearGradient(left - 4, 0, left + NET_W + 4, 0);
    g.addColorStop(0, "#e6e7eb");
    g.addColorStop(0.5, "#ffffff");
    g.addColorStop(1, "#b5bac1");
    _netPostsGrad = g;
    return g;
  }
  // Ball-градиент зависит только от радиуса мяча и от флага hit-flash.
  // Форма привязана к локальной системе координат (translate к ball.x,ball.y),
  // поэтому можно переиспользовать один и тот же объект каждый кадр.
  function ballNormalGrad(){
    if(_ballNormalGrad) return _ballNormalGrad;
    const g = ctx.createRadialGradient(-ball.r*0.35, -ball.r*0.45, ball.r*0.15, 0, 0, ball.r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.7, "#ececef");
    g.addColorStop(1, "#b5bac1");
    _ballNormalGrad = g;
    return g;
  }
  function ballFlashGrad(){
    if(_ballFlashGrad) return _ballFlashGrad;
    const g = ctx.createRadialGradient(-ball.r*0.35, -ball.r*0.45, ball.r*0.15, 0, 0, ball.r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.6, "#fff2a6");
    g.addColorStop(1, "#e8a635");
    _ballFlashGrad = g;
    return g;
  }

  // --- Avatar cache: draw avatar as a canvas once, reuse each frame ---
  // LRU-кэш: онлайн + случайные оппоненты могут раздуть Map до сотен
  // canvas-элементов, каждый со своей GPU-текстурой. Ограничиваем размер и
  // вытесняем старейшую запись при достижении предела.
  const AVATAR_CACHE_MAX = 32;
  const avatarCache = new Map();
  function avatarCacheSet(key, value){
    if(avatarCache.has(key)){
      avatarCache.delete(key);
      avatarCache.set(key, value);
      return;
    }
    if(avatarCache.size >= AVATAR_CACHE_MAX){
      const oldestKey = avatarCache.keys().next().value;
      avatarCache.delete(oldestKey);
    }
    avatarCache.set(key, value);
  }
  function avatarCacheGet(key){
    const hit = avatarCache.get(key);
    if(hit){
      // Touch: переносим в конец, продлеваем жизнь.
      avatarCache.delete(key);
      avatarCache.set(key, hit);
    }
    return hit;
  }

  function getAvatarCanvas(user, size){
    const safeUrl = Auth.sanitizeAvatarUrl(user.avatar_url);
    const key = (safeUrl || user.color || "?") + "|" + (user.global_name||user.username||"?") + "|" + size;
    const hit = avatarCacheGet(key);
    if(hit) return hit;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.fillStyle = user.color || "#5865f2";
    g.beginPath(); g.arc(size/2, size/2, size/2, 0, Math.PI*2); g.fill();
    const letter = (user.global_name||user.username||"?").charAt(0).toUpperCase();
    g.fillStyle = "#fff";
    g.font = "bold " + Math.floor(size*0.5) + "px system-ui,sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(letter, size/2, size/2 + size*0.03);
    avatarCacheSet(key, c);
    if(safeUrl){
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = ()=>{
        g.clearRect(0,0,size,size);
        g.save();
        g.beginPath(); g.arc(size/2,size/2,size/2,0,Math.PI*2); g.clip();
        try{ g.drawImage(img, 0, 0, size, size); }catch(_){
          // CORS-провал рисования на canvas — оставляем букву-заглушку.
          g.restore();
          return;
        }
        g.restore();
      };
      // onerror — оставляем canvas с буквой, молча, без логов в прод.
      img.onerror = ()=>{};
      img.src = safeUrl;
    }
    return c;
  }

  function drawPlayer(p, user){
    const r = p.r;
    // Ground shadow scales with height off the ground.
    // p.y is the CENTER; on the ground p.y == GROUND_Y - r (feet on floor).
    const feetY = p.y + r;
    const air = Math.min(1, Math.max(0, (GROUND_Y - feetY) / 200));
    const sh  = 1 - air*0.5;
    ctx.fillStyle = "rgba(0,0,0," + (0.32 - air*0.18) + ")";
    ctx.beginPath();
    ctx.ellipse(p.x, GROUND_Y - 1, r*0.95*sh, 6*sh, 0, 0, Math.PI*2);
    ctx.fill();

    // Landing squash: scale around feet so the head compresses toward the ground.
    const st = (p.side === 1 ? squash.p1 : squash.p2);
    const sk = st > 0 ? (st / 0.18) : 0;
    const sxAxis = 1 + sk * 0.18;
    const syAxis = 1 - sk * 0.22;

    const size = r*2;
    const av = getAvatarCanvas(user, Math.floor(size));

    ctx.save();
    // Anchor squash at the feet (bottom of circle) so the top compresses down
    ctx.translate(p.x, p.y + r * (1 - syAxis));
    ctx.scale(sxAxis, syAxis);

    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.clip();
    ctx.drawImage(av, -r, -r, size, size);
    ctx.restore();

    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4; ctx.stroke();

    ctx.restore();
  }

  function drawBall(){
    // Soft ground shadow scaled by height above court
    const shf = 1 - Math.min(0.7, (GROUND_Y - ball.y)/GROUND_Y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(ball.x, GROUND_Y - 2, ball.r*1.15*shf, 5*shf, 0, 0, Math.PI*2);
    ctx.fill();

    // Squash-and-stretch along velocity vector for a brief moment after a hit
    const sqAmt = squash.ball > 0 ? (squash.ball / 0.16) : 0;
    const stretch = 1 + sqAmt * 0.28;
    const squeeze = 1 - sqAmt * 0.22;
    const ang = Math.atan2(ball.vy, ball.vx);

    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(ang);
    ctx.scale(stretch, squeeze);
    ctx.rotate(-ang);
    ctx.rotate(ball.angle);

    // Radial gradient: bright highlight offset toward upper-left
    ctx.fillStyle = hitFlash > 0 ? ballFlashGrad() : ballNormalGrad();
    ctx.beginPath(); ctx.arc(0, 0, ball.r, 0, Math.PI*2); ctx.fill();

    // Seam lines — two sweeping arcs to read as a volleyball
    ctx.strokeStyle = "rgba(120,125,135,0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, ball.r*0.62, -0.4, 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, ball.r*0.62, Math.PI-0.4, Math.PI+1.2); ctx.stroke();

    // Outer rim
    ctx.strokeStyle = "rgba(80,85,95,0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, ball.r - 1, 0, Math.PI*2); ctx.stroke();

    // Specular dot
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.beginPath(); ctx.arc(-ball.r*0.4, -ball.r*0.5, ball.r*0.15, 0, Math.PI*2); ctx.fill();

    ctx.restore();
  }

  /* ------------- Loop ------------- */
  function loop(){
    rafId = requestAnimationFrame(loop);
    // Читаем время через Clock, а не через rAF-аргумент. Так всё, что
    // тикает в игре и rate-limits в кошельке, идёт от одного источника,
    // в который позже можно подмешать серверный offset.
    const now = Clock.now();
    if(state.paused){ last = now; return; }
    let dt = (now - last) / 1000;
    last = now;
    if(dt > 0.25) dt = 0.25;
    acc += dt;
    let steps = 0;
    while(acc >= STEP && steps < 6){
      step(STEP);
      acc -= STEP;
      steps++;
    }
    if(steps === 6) acc = 0;
    render();
  }

  // Перерисовать тексты overlay после смены языка. Ничего не делает,
  // если overlay скрыт.
  function refreshOverlay(){
    if(overlay.classList.contains("hidden")) return;
    if(state.matchOver){
      overlayTitle.textContent = I18n.t(lastWinnerSide === 1 ? "game.victory" : "game.defeat");
      const name = lastWinnerSide === 1
        ? $("hud-name-p1").textContent
        : $("hud-name-p2").textContent;
      overlaySub.textContent = name + " — " + score1 + " : " + score2;
    }else if(state.paused){
      overlayTitle.textContent = I18n.t("game.pause");
    }
  }

  return { start, stop, pause, resume, refreshOverlay, triggerEmote };
})();

/* ========================================================================
   AI — pursuit + spike predictor, tuned per difficulty.
   Uses the same GRAV constant as physics so predictions line up.
   ======================================================================== */
// rand — опциональный сид-источник [0,1). Если не передан, используется
// Math.random (SP, без синхронизации). В онлайне Game прокидывает
// детерминированный rng из Game IIFE.
function makeAI(difficulty, rand){
  const rnd = rand || Math.random;
  const cfg = ({
    easy:   { react:0.55, err:110, jumpX:140, jumpMaxH:90,  jumpChance:0.25, homeBias:0.4, moveChance:0.85, deadzone:20 },
    medium: { react:0.22, err:45,  jumpX:220, jumpMaxH:140, jumpChance:0.70, homeBias:0.8, moveChance:1.0,  deadzone:10 },
    hard:   { react:0.10, err:12,  jumpX:280, jumpMaxH:170, jumpChance:0.92, homeBias:1.0, moveChance:1.0,  deadzone:6  }
  })[difficulty] || {};
  let t = 0;
  let target = 750;
  // Must match Game module constants.
  const GRAV     = 1250;
  const NET_X    = 500;
  const GROUND_Y = 470;
  const PLR_R    = 42;
  // AI aims to strike the ball at its ideal hit zone — just above the player's head.
  const STRIKE_Y = GROUND_Y - PLR_R * 2.4;

  function predictLanding(ball, targetY){
    const a = 0.5*GRAV, b = ball.vy, c = ball.y - targetY;
    const D = b*b - 4*a*c;
    if(D < 0) return ball.x;
    const tFall = (-b + Math.sqrt(D)) / (2*a);
    let x = ball.x + ball.vx * tFall;
    if(x < 0) x = -x;
    if(x > 1000) x = 2000 - x;
    return x;
  }

  return {
    decide(p, ball, dt){
      t += dt;
      if(t >= cfg.react){
        t = 0;
        target = predictLanding(ball, STRIKE_Y);
        target += (rnd()*2 - 1) * cfg.err;
      }
      // AI is always p2 (right side).
      const onMySide = ball.x > NET_X;
      // Home position biased toward the net on higher difficulties
      const home = 750 - 50*cfg.homeBias;
      const aim  = onMySide ? target : home;

      const out = { left:false, right:false, jump:false };
      const dx = aim - p.x;
      // Easy AI occasionally just stands still ("thinking") to give the player
      // a chance to score cleanly.
      if(rnd() < cfg.moveChance){
        if(dx < -cfg.deadzone) out.left  = true;
        else if(dx >  cfg.deadzone) out.right = true;
      }

      // Jump when the ball is approaching my strike zone above my dome.
      // p.y is the slime center (on ground: p.y == GROUND_Y).
      const dX = Math.abs(ball.x - p.x);
      const headY = p.y - p.r;
      if(onMySide && dX < cfg.jumpX &&
         ball.y < (headY - 10) &&
         ball.y > (headY - cfg.jumpMaxH) &&
         p.onGround){
        if(rnd() < cfg.jumpChance) out.jump = true;
      }
      return out;
    }
  };
}

/* ---------------- Boot ---------------- */
resizeCanvas();
boot();

/* ---------------- Auto-reload on new deploy ----------------
   Сервер отдаёт `window.__BUILD__` и эндпоинт `/api/version`. Раз в минуту
   сверяем: если build поменялся — значит на Railway выехал новый деплой,
   и тихо релоадим страницу, чтобы пользователь не держал в голове Ctrl+
   Shift+R. Прерывать активную игру грубо — ждём, пока вернётся в меню/
   overlay/логин; фоновые вкладки не релоадим — дожидаемся фокуса. */
(function autoReload(){
  const initial = window.__BUILD__;
  if(!initial) return; // локальный запуск без серверного штампа — молчим
  let armed = false;

  function isActivelyPlaying(){
    const gs = document.getElementById("screen-game");
    const ov = document.getElementById("overlay");
    if(!gs || gs.classList.contains("hidden")) return false;
    // overlay скрыт = идёт розыгрыш. overlay показан = пауза / конец матча.
    return !ov || ov.classList.contains("hidden");
  }

  function maybeReload(){
    if(!armed) return;
    if(document.hidden) return;
    if(isActivelyPlaying()) return;
    location.reload();
  }

  async function probe(){
    try{
      const r = await fetch("/api/version", { cache: "no-store" });
      if(!r.ok) return;
      const j = await r.json();
      if(j && j.build && j.build !== initial){ armed = true; maybeReload(); }
    }catch(_){ /* сеть отвалилась — попробуем в след. раз */ }
  }

  setInterval(probe, 60000);
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) maybeReload(); });
  // На выходе в меню overlay скрывается / screen-game прячется — пробуем.
  document.addEventListener("click",   maybeReload, true);
  document.addEventListener("keydown", maybeReload, true);
})();

})();
