/* Volleyball Online — lightweight vanilla canvas game.
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
// Даунскейл текстуры мяча 128→~90 px на PC с DPR=2 без явного quality
// получается «мыльным» в Chrome (алгоритм по умолчанию — near bilinear).
// "high" → трёхступенчатое усреднение, цвета остаются насыщенными при
// уменьшении. На телефоне мяч ~12 px, и без "high" цвета сливались в серое.
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

/* ---------------- Clock ----------------
   Одна точка чтения времени на весь клиент. Сейчас это `Clock.now()`,
   но именно здесь в будущем подселяется серверная таймлайн-синхронизация
   (NTP-подобный offset) для онлайна, чтобы rate-limit и rollback-симуляция
   работали от одного и того же источника, а не от клиентских часов. */
const Clock = {
  offsetMs: 0,
  now(){ return performance.now() + this.offsetMs; }
};

/* ---------------- DecoAnim ----------------
   Единый rAF-цикл, листающий кадры украшений через background-position.
   Вместо N таймеров на каждый аватар — один тикер на все .avatar-deco
   элементы. Когда узел удалён из DOM (el.isConnected === false) —
   самоочищается. Тикер стартует по первой .attach() и засыпает после
   удаления последнего слоя.

   Почему background-position, а не canvas: атлас загружается браузером
   раз, дальше — одна CSS-пропертя на кадр, без decode и без перерисовки
   img. rAF в фоновой вкладке сам засыпает, так что пауза при скрытии
   тоже бесплатна. */
const DecoAnim = (function(){
  const layers = new Set();
  let running = false;
  function attach(el){
    if(!el) return;
    layers.add(el);
    if(!running){ running = true; requestAnimationFrame(tick); }
  }
  function detach(el){ layers.delete(el); }
  function tick(){
    if(layers.size === 0){ running = false; return; }
    const t = performance.now();
    for(const el of layers){
      if(!el.isConnected){ layers.delete(el); continue; }
      const frames = +(el.dataset.frames || 0);
      const cols   = +(el.dataset.cols   || 1);
      const rows   = +(el.dataset.rows   || 1);
      const fps    = +(el.dataset.fps    || 12);
      if(frames < 2 || fps < 1) continue;
      const idx = Math.floor(t * fps / 1000) % frames;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      // Когда атлас масштабирован до cols×rows размеров элемента,
      // background-position в процентах — это доля «свободного хода»
      // фона внутри контейнера. Для cols столбцов свободный ход по X
      // делится на (cols-1) шагов.
      const bx = cols > 1 ? (col * 100 / (cols - 1)) : 0;
      const by = rows > 1 ? (row * 100 / (rows - 1)) : 0;
      el.style.backgroundPosition = bx + "% " + by + "%";
    }
    requestAnimationFrame(tick);
  }
  return { attach, detach };
})();
window.DecoAnim = DecoAnim;

/* ---------------- State ---------------- */
const state = {
  user: null,
  bot: null,
  opponent: null,
  // mode: 'bot' (SP vs AI) | 'host' (authoritative online left player)
  //     | 'guest' (online right player, driven by host snapshots)
  mode: "bot",
  // netMode: "host" — legacy host-authoritative (host крутит физику, шлёт
  //                   снапшоты guest'у; guest шлёт input'ы host'у).
  //          "auth" — server-authoritative (сервер крутит физику, шлёт
  //                   снапшоты ОБОИМ; оба шлют input'ы серверу).
  // Выбирается сервером в matched.net; клиент сам не решает.
  netMode: "host",
  ws: null,
  // Второй сокет — на Hathora room-server'е, только для gameplay (input,
  // state, emote). Активен при matched.roomHost != null. Menu-WS (state.ws)
  // параллельно живёт на Railway для lobby/stats/wallet/trophies/peer_left.
  gameWs: null,
  peerKeys: { left:false, right:false, jump:false },
  targetScore: 10,
  inGame: false,
  matchOver: false,
  // Защёлка: match_win/match_loss уходят на сервер не больше одного раза
  // за матч. Разные пути исхода (endMatch/endMatchAsSnapshot/onPeerLeft)
  // могут пересекаться — без флага рейтинг/ставки дублируются.
  winReported: false,
  lossReported: false,
  // Серверно-зафиксированные ставки трофеев текущего матча.
  // {win, loss, matchId}. Ставки приходят с сервера: PvP — в matched,
  // bot — в ответ на match_stakes_request.
  stakes: null,
  // Сессия матча. matchId — идентификатор раунда, с которым в онлайне
  // клиент будет слать события на сервер (award-запросы, инпуты); seq —
  // монотонный счётчик сообщений, чтобы сервер мог отбрасывать ретраи/
  // дубликаты. Пересоздаётся на каждый новый матч.
  session: null
};
// Открываем state для E2E-тестов. В проде это read-only хэндл; влиять на
// геймплей через него нельзя (физика/сетевой поток берут данные из
// замыкания, а не window).
if (typeof window !== "undefined") window.__dvState = state;
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
  if(u){
    state.user = u;
    // Стартовый баланс приходит с сервера — кошелёк серверно-авторитетный.
    if(typeof u.coins    === "number") Wallet.set(u.coins, 0);
    if(typeof u.trophies === "number") Trophies.set(u.trophies, 0);
    enterMenu();
  }
  else { show("login"); }

  // Если вернулись с callback с ошибкой — мягко сообщаем в консоль,
  // чтобы не шуметь alert'ом. Сам UI остаётся на login-экране.
  const err = new URLSearchParams(location.search).get("auth_error");
  if(err){
    console.warn("[auth] discord callback error:", err);
    try{ history.replaceState(null, "", location.pathname); }catch(_){}
  }
}

/* ---------------- Wallet (server-authoritative) ----------------
   Баланс живёт ТОЛЬКО на сервере: редактирование localStorage/DevTools ни на
   что не влияет. Клиент — зеркало: получает стартовый баланс из /api/me и
   hello-сообщения, слушает {type:"wallet", coins, delta} апдейты. award() —
   заявка на начисление (отправляется по WS), ответ приходит асинхронно.
   Для бот-матчей начисления идут так же через сервер — там хардкорные
   кросс-матч лимиты (в т.ч. global cooldown 30 с на match.win) защищают
   от фарма ботом. */
const Wallet = (function(){
  let balance = 0;
  const listeners = [];
  function set(newBalance, explicitDelta){
    const n = Math.max(0, newBalance | 0);
    const delta = (typeof explicitDelta === "number") ? explicitDelta : (n - balance);
    balance = n;
    for(const fn of listeners) { try { fn(delta, balance); } catch(_){} }
  }
  function award(kind, amountOrCombo){
    // Клиентское значение amount игнорируется сервером; для rally.combo мы
    // всё же прокидываем combo в context, чтобы сервер знал размер серии.
    if(!state.ws || state.ws.readyState !== 1) return false;
    const payload = {
      type: "award",
      kind: String(kind || ""),
      matchId: (state.session && state.session.matchId) || null
    };
    if(kind === "rally.combo") payload.context = { combo: amountOrCombo | 0 };
    try { state.ws.send(JSON.stringify(payload)); } catch(_){}
    return true;
  }
  return {
    get(){ return balance; },
    set: set,
    award: award,
    onChange(fn){ if(typeof fn === "function") listeners.push(fn); },
    matchReset(){ /* no-op: сервер трекает по matchId */ }
  };
})();

/* ---------------- Trophies (server-authoritative) ----------------
   Кубки хранятся на сервере, клампятся в 0. Клиент — зеркало.
   Пуш {type:"trophies", total, delta} приходит в ответ на match_win /
   match_loss / leave-во-время-матча. UI просто подхватывает значение. */
const Trophies = (function(){
  let total = 0;
  const listeners = [];
  function set(newTotal, explicitDelta){
    const n = Math.max(0, newTotal | 0);
    const delta = (typeof explicitDelta === "number") ? explicitDelta : (n - total);
    total = n;
    for(const fn of listeners) { try { fn(delta, total); } catch(_){} }
  }
  return {
    get(){ return total; },
    set: set,
    onChange(fn){ if(typeof fn === "function") listeners.push(fn); }
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

/* ---- Trophies UI rendering ---- */
const trophyValueEl = $("trophies-value-menu");
const trophyDeltaEl = $("trophies-delta-menu");
function renderTrophies(){
  if(trophyValueEl) trophyValueEl.textContent = String(Trophies.get());
}
function flashTrophyDelta(amount){
  if(!trophyValueEl || !trophyDeltaEl || !amount) return;
  trophyValueEl.classList.remove("bump");
  trophyDeltaEl.classList.remove("show");
  void trophyDeltaEl.offsetWidth;
  trophyDeltaEl.textContent = (amount > 0 ? "+" : "") + amount;
  trophyDeltaEl.style.color = amount < 0 ? "#f87171" : "";
  trophyValueEl.classList.add("bump");
  trophyDeltaEl.classList.add("show");
}
renderTrophies();
Trophies.onChange((delta)=>{
  renderTrophies();
  renderHudTrophies();
  if(delta) flashTrophyDelta(delta);
});

/* ---- Trophy balance per-player HUD ----
   Под именем у каждого игрока — его баланс кубков (оба жёлтые). У p1
   берём из Trophies (локальный источник истины, обновляется от wallet
   сервера). У p2 — из state.opponent.trophies, которое сервер прислал
   в matched.opponent. В бот-матче у p2 трофей нет — прячем. */
function renderHudTrophies(){
  const p1el  = $("hud-trophies-p1");
  const p1val = $("hud-trophies-val-p1");
  if(p1el && p1val){
    p1val.textContent = String(Trophies.get());
    p1el.hidden = false;
  }
  const p2el  = $("hud-trophies-p2");
  const p2val = $("hud-trophies-val-p2");
  if(p2el && p2val){
    const opp = state.opponent;
    if(state.mode !== "bot" && opp && typeof opp.trophies === "number"){
      p2val.textContent = String(opp.trophies | 0);
      p2el.hidden = false;
    } else {
      p2el.hidden = true;
    }
  }
}

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

// В каких ролях на поле показаны игроки. У каждого клиента свой «себя слева»:
// host видит state.user как p1, guest тоже — за счёт зеркалирования снапшотов.
function playerUser(side){
  if(state.mode === "guest") return side === 1 ? state.user     : state.opponent;
  if(state.mode === "host")  return side === 1 ? state.user     : state.opponent;
  return side === 1 ? state.user : state.bot; // bot
}

// Динамические строки, которые не переключаются через data-i18n, плюс
// HUD-аватары/имена, которые зависят от текущего режима матча.
function refreshLocalizedDynamicUI(){
  const left = playerUser(1), right = playerUser(2);
  if(left){
    Auth.renderAvatarInto($("hud-avatar-p1"), left);
    $("hud-name-p1").textContent = userDisplayName(left);
  }
  if(right){
    Auth.renderAvatarInto($("hud-avatar-p2"), right);
    $("hud-name-p2").textContent = state.mode === "bot"
      ? botDisplayName(right)
      : userDisplayName(right);
  }
  $("hud-diff").textContent = I18n.t(state.mode === "bot" ? "hud.bot" : "hud.online");
  renderHudTrophies();
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
  // Лидерборд и подпись «Сейчас онлайн» содержат динамически отрендеренный
  // текст без data-i18n-ключей — перерисуем вручную.
  if(typeof refreshLeaderboard === "function") refreshLeaderboard();
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
  // Серверная сессия закрыта — сокет станет невалидным; закроем сами,
  // чтобы не держать стухший коннект и не светить юзера в онлайн-счётчике.
  if(state.ws){ try { state.ws.close(); } catch(_){} state.ws = null; }
  Wallet.set(0, 0);
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
  if(typeof Admin !== "undefined") Admin.applyUi();
  refreshOnlineCount();
  refreshLeaderboard();
  // Держим WS открытым с момента входа в меню: счётчик онлайна считает
  // именно подключённых юзеров (не тех, кто в матчмейкинге), а кошелёк
  // получает серверные апдейты балланса пушем.
  ensureMenuSocket();
}

// Один постоянный сокет на сессию. Переиспользуем его для matchmaking,
// онлайн-счётчика и пушей кошелька. Закрываем только на logout/выгрузке.
//
// КЛЮЧЕВОЙ ИНВАРИАНТ: state.ws присваивается СИНХРОННО, сразу после
// new WebSocket(). Иначе между enterMenu() (fire-and-forget вызов) и
// первым кликом «ИГРАТЬ» параллельные ensureMenuSocket() не увидели бы
// друг друга (state.ws ещё null до await openSocket()) и открывали по
// второму/третьему сокету. Один из них обычно успевал, но если handshake
// задерживался и таймаут выстреливал → startMatchmaking получал null и
// сваливал игрока в бот-матч ДО queue_timeout, что и видел пользователь
// как «бот у обоих сразу после клика ИГРАТЬ».
async function ensureMenuSocket(){
  if(state.ws && state.ws.readyState === 1) return state.ws;
  if(state.ws && (state.ws.readyState === 0 || state.ws.readyState === 2)){
    // Идёт handshake или close — ждём здесь, без создания второго сокета.
    return await waitSocketOpen(state.ws);
  }
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(proto + "//" + location.host + "/ws");
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    attachSocketHandlers(ws);
    return await waitSocketOpen(ws);
  } catch(_){
    return null;
  }
}

/* ---------------- Онлайн-счётчик и таблица лидеров ----------------
   Счётчик: приходит push-сообщением по WS ({type:"stats", online}) или
   по HTTP /api/stats при заходе в меню (на случай, когда сокет ещё не
   открыт — до клика «ИГРАТЬ»). Лидерборд: /api/leaderboard. */

const onlineCountEl = $("online-count");
function setOnlineCount(n){
  if(!onlineCountEl) return;
  const v = Number.isFinite(n) ? Math.max(0, n|0) : null;
  onlineCountEl.textContent = v == null ? "—" : String(v);
}
async function refreshOnlineCount(){
  try {
    const r = await fetch("/api/stats", { credentials: "same-origin", cache: "no-store" });
    if(!r.ok) return;
    const j = await r.json();
    setOnlineCount(j.online);
  } catch(_){}
}
setInterval(()=>{
  // Фолбек-поллинг: WS может быть закрыт (юзер не нажал «ИГРАТЬ»).
  // Раз в 30 с подтягиваем счётчик — чтобы он не казался «мёртвым».
  if(document.hidden) return;
  if(document.getElementById("screen-menu")?.classList.contains("hidden")) return;
  refreshOnlineCount();
}, 30000);

const lbListEl      = $("lb-list");
const lbEmptyEl     = $("lb-empty");
const lbMeEl        = $("lb-me");
const lbPagerEl     = $("lb-pager");
const lbPrevBtn     = $("lb-prev");
const lbNextBtn     = $("lb-next");
const lbPageInfoEl  = $("lb-page-info");
const lbJumpMeBtn   = $("lb-jump-me");
let lbCurrentPage = 1;
let lbMePage = null;

function fmtI18n(key, vars){
  let s = I18n.t(key);
  if(vars) for(const k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
  return s;
}
function renderLbRow(entry, rank, meId){
  const li = document.createElement("li");
  li.className = "lb-row";
  if(rank === 1) li.classList.add("top-1");
  else if(rank === 2) li.classList.add("top-2");
  else if(rank === 3) li.classList.add("top-3");
  if(meId && entry.id === meId) li.classList.add("me");

  const rankEl = document.createElement("span");
  rankEl.className = "lb-rank";
  rankEl.textContent = "#" + rank;
  const avatarEl = document.createElement("span");
  avatarEl.className = "lb-avatar";
  Auth.renderAvatarInto(avatarEl, entry);
  const nameEl = document.createElement("span");
  nameEl.className = "lb-name";
  nameEl.textContent = entry.global_name || entry.username || "…";
  const scoreEl = document.createElement("span");
  scoreEl.className = "lb-wins";
  scoreEl.textContent = String(entry.trophies || 0);
  const icoEl = document.createElement("img");
  icoEl.src = "assets/trophy.svg";
  icoEl.className = "lb-trophy-ico";
  icoEl.alt = "";
  icoEl.width = 14; icoEl.height = 14;
  icoEl.decoding = "async";
  scoreEl.appendChild(icoEl);

  li.appendChild(rankEl);
  li.appendChild(avatarEl);
  li.appendChild(nameEl);
  li.appendChild(scoreEl);
  return li;
}
async function refreshLeaderboard(page){
  if(!lbListEl) return;
  const p = Number.isFinite(page) ? Math.max(1, page|0) : lbCurrentPage;
  try {
    const r = await fetch("/api/leaderboard?page=" + p, { credentials: "same-origin", cache: "no-store" });
    if(!r.ok) return;
    const j = await r.json();
    const top = Array.isArray(j.top) ? j.top : [];
    const meId = state.user && state.user.id;
    lbCurrentPage = j.page || p;
    lbMePage = (j.me && j.me.page) || null;

    lbListEl.innerHTML = "";
    for(let i = 0; i < top.length; i++){
      // Сервер даёт абсолютный ранг (через страницу) в entry.rank —
      // не пересчитываем на клиенте, иначе 2-я страница снова пойдёт с #1.
      lbListEl.appendChild(renderLbRow(top[i], top[i].rank || (i + 1), meId));
    }
    if(lbEmptyEl) lbEmptyEl.style.display = top.length === 0 ? "" : "none";

    if(lbPagerEl){
      const pages = Math.max(1, j.pages || 1);
      lbPagerEl.hidden = pages <= 1 && !(j.me && j.me.page && j.me.page !== lbCurrentPage);
      if(lbPageInfoEl) lbPageInfoEl.textContent = fmtI18n("lb.page_info", { page: lbCurrentPage, pages });
      if(lbPrevBtn) lbPrevBtn.disabled = lbCurrentPage <= 1;
      if(lbNextBtn) lbNextBtn.disabled = lbCurrentPage >= pages;
      if(lbJumpMeBtn){
        const show = !!(lbMePage && lbMePage !== lbCurrentPage);
        lbJumpMeBtn.hidden = !show;
      }
    }

    if(lbMeEl){
      if(j.me && j.me.rank && j.me.trophies > 0){
        lbMeEl.textContent = fmtI18n("lb.me_rank", { rank: j.me.rank, trophies: j.me.trophies });
        lbMeEl.classList.toggle("me-topped", j.me.rank <= 3);
      }else{
        lbMeEl.textContent = I18n.t("lb.me_empty");
        lbMeEl.classList.remove("me-topped");
      }
    }
  } catch(_){}
}
if(lbPrevBtn) lbPrevBtn.addEventListener("click", ()=> refreshLeaderboard(lbCurrentPage - 1));
if(lbNextBtn) lbNextBtn.addEventListener("click", ()=> refreshLeaderboard(lbCurrentPage + 1));
if(lbJumpMeBtn) lbJumpMeBtn.addEventListener("click", ()=> { if(lbMePage) refreshLeaderboard(lbMePage); });

// Ожидание open у переданного WebSocket. Если сокет уже открыт — возвращаем
// его без задержки. На ошибку/close/длинный таймаут возвращаем null, чтобы
// вызывающий мог сделать fallback.
function waitSocketOpen(ws, timeoutMs){
  return new Promise((resolve) => {
    if(!ws || ws.readyState === 3){ resolve(null); return; }
    if(ws.readyState === 1){ resolve(ws); return; }
    let settled = false;
    const done = (val) => { if(!settled){ settled = true; resolve(val); } };
    ws.addEventListener("open",  () => done(ws),   { once: true });
    ws.addEventListener("error", () => done(null), { once: true });
    ws.addEventListener("close", () => done(null), { once: true });
    // 8 секунд вместо 2.5 — на холодном старте/медленной сети первый handshake
    // может подтянуться и за 3-4 секунды. Лучше продержать лобби дольше, чем
    // ошибочно свалиться в бот-матч вместо реального соперника.
    setTimeout(() => done(null), timeoutMs || 8000);
  });
}

// Binary relay codec — источник истины в shared codec.js (одинаковые байты
// у клиента и серверного shadow-sim'а с Этапа 6). Алиас для старого имени.
const Codec = window.DVCodec;

function attachSocketHandlers(ws){
  ws.addEventListener("message", (ev)=>{
    // Бинарные фреймы в онлайн-режиме были peer-relay; в bot-only режиме
    // сервер не шлёт бинарные payload'ы — просто игнорируем.
    if(typeof ev.data !== "string") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if(!msg || typeof msg.type !== "string") return;
    onServerMessage(msg);
  });
  ws.addEventListener("close", ()=>{
    if(state.ws === ws) state.ws = null;
  });
}

// В bot-only режиме gameplay-сокета нет; шим сохраняем, чтобы не ломать
// call-sites в Game-модуле (broadcastSnapshot/emote-relay никогда не
// активируются, т.к. state.mode всегда "bot").
function gameplaySocket(){ return null; }
function closeGameSocket(){ /* no-op */ }

function onServerMessage(msg){
  switch(msg.type){
    case "hello":
      if(typeof msg.online   === "number") setOnlineCount(msg.online);
      if(typeof msg.coins    === "number") Wallet.set(msg.coins, 0);
      if(typeof msg.trophies === "number") Trophies.set(msg.trophies, 0);
      break;
    case "stats":
      if(typeof msg.online === "number") setOnlineCount(msg.online);
      break;
    case "wallet":
      // Серверный пуш нового баланса. Передаём явный delta, чтобы UI
      // анимировал именно то, что сервер фактически начислил (может
      // отличаться от клиентской «ожидаемой» суммы — напр., rate-limit
      // отклонил, или combo скорректировано сервером).
      if(typeof msg.coins === "number"){
        const d = (typeof msg.delta === "number") ? msg.delta : undefined;
        Wallet.set(msg.coins, d);
      }
      break;
    case "match_stakes":
      if(msg.matchId){
        state.stakes = {
          matchId: msg.matchId,
          win:  msg.win  | 0,
          loss: msg.loss | 0
        };
      }
      break;
    case "trophies":
      if(typeof msg.total === "number"){
        const d = (typeof msg.delta === "number") ? msg.delta : 0;
        Trophies.set(msg.total, d);
      }
      break;
  }
}

function reportMatchWin(){
  if(state.winReported) return;
  state.winReported = true;
  const mid = state.stakes && state.stakes.matchId;
  try {
    state.ws && state.ws.readyState === 1 &&
      state.ws.send(JSON.stringify({ type: "match_win", matchId: mid || null }));
  } catch(_){}
}

function reportMatchLoss(){
  if(state.lossReported) return;
  state.lossReported = true;
  const mid = state.stakes && state.stakes.matchId;
  try {
    state.ws && state.ws.readyState === 1 &&
      state.ws.send(JSON.stringify({ type: "match_loss", matchId: mid || null }));
  } catch(_){}
}

function closeSocket(){
  const ws = state.ws;
  state.ws = null;
  if(!ws) return;
  try { ws.close(); } catch(_){}
}

function startBotMatch(){
  state.mode = "bot"; state.netMode = "host";
  state.opponent = null;
  state.bot = Auth.makeBot();
  // Серверу нужен зафиксированный matchId, чтобы ставки трофеев были
  // одни и те же при начислении/списании. Генерим тут, а сервер в ответ
  // на match_stakes_request покатит +win/-loss и сохранит по matchId.
  state.session = { matchId: "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8), startedAt: Date.now(), seq: 0 };
  state.stakes = null;
  requestStakes(state.session.matchId);
  $("hud-score-p1").textContent = "0";
  $("hud-score-p2").textContent = "0";
  refreshLocalizedDynamicUI();
  show("game");
  resizeCanvas();
  Game.start();
}

function requestStakes(matchId){
  try {
    state.ws && state.ws.readyState === 1 &&
      state.ws.send(JSON.stringify({ type: "match_stakes_request", matchId }));
  } catch(_){}
}

$("btn-play").addEventListener("click", startBotMatch);

/* ---------------- Canvas sizing ---------------- */
// World config — источник истины в physics.js (shared с сервером).
const { WORLD_W, WORLD_H } = window.DVPhysics;
let scale = 1, offsetX = 0, offsetY = 0;

// Кап DPR: на 3x-Retina (iPhone) честный рендер в 3× увеличивает площадь
// пикселей в 9 раз по сравнению с 1× — это ощутимо бьёт по мобильным
// iGPU. На десктопе допускаем 2×, на тач-устройствах жёстче — 1.25×,
// т.к. мобильный GPU под радиальными градиентами/частицами захлёбывается
// при честных 1080×2400 пикселях.
const DPR_CAP_DESKTOP = 2;
const DPR_CAP_TOUCH   = 1.25;
// rAF-throttle: ResizeObserver в браузерах иногда выдаёт по несколько
// ResizeObserverEntry на один кадр (layout-thrash, DevTools-ресайз), а
// фокусировка/blur адресных строк на мобилках бросает «залп» ресайзов
// в короткой вспышке. Без throttle мы гнали бы весь DPR-расчёт и
// пересчёт scale/offset 5-10 раз за кадр. Подход: первый вызов в кадре
// выполняется сразу (чтобы show("game") + resizeCanvas давал валидный
// канвас к моменту первого render), последующие в том же кадре
// сливаются до следующего rAF.
let _resizeScheduled = false;
let _resizeCount = 0; // счётчик для тестов: сколько раз реально выполнили
function resizeCanvas(){
  if (_resizeScheduled) return;
  _resizeCanvasNow();
  _resizeScheduled = true;
  requestAnimationFrame(() => { _resizeScheduled = false; });
}
if (typeof window !== "undefined") window.__dvResizeCount = () => _resizeCount;
function _resizeCanvasNow(){
  _resizeCount++;
  const cap = (document.body && document.body.classList.contains("is-touch"))
    ? DPR_CAP_TOUCH : DPR_CAP_DESKTOP;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  // Берём ФАКТИЧЕСКИЙ размер canvas из CSS, а не window.innerHeight: на тач-
  // устройствах CSS оставляет внизу полосу под хитбоксы управления, и canvas
  // высотой меньше окна. Если бы мы использовали innerHeight, поле рендерилось
  // бы полностью, а тач-зоны закрывали бы его нижнюю часть. clientWidth/Height
  // возвращают реальные CSS-пиксели — умножаем на DPR для честного физического
  // разрешения. Fallback на innerWidth/Height на случай, если canvas ещё не
  // получил лейаут (например, вызов resizeCanvas до show("game")).
  const w = Math.max(1, canvas.clientWidth  || window.innerWidth);
  const h = Math.max(1, canvas.clientHeight || window.innerHeight);
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
// Сразу после show("game") (особенно на «Играть снова» онлайн) браузер
// ещё не успевает пересчитать layout только что раскрытого section'а —
// canvas.clientWidth/Height кратковременно возвращают 0, resizeCanvas
// выставляет scale≈0, и первый кадр рисуется как пустая точка. Observer
// ловит момент, когда layout реально применился, и переразмеряет canvas.
if(typeof ResizeObserver === "function"){
  new ResizeObserver(resizeCanvas).observe(canvas);
}

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
function clearKeys(){
  keys.left = keys.right = keys.jump = false;
  if(typeof relayInputIfGuest === "function") relayInputIfGuest();
}
window.addEventListener("keydown", e=>{
  // Никогда не перехватываем системные комбо Ctrl/Cmd+X (Ctrl+R/W/T,
  // закладки, devtools и т.п.) — preventDefault на них ломает браузер.
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  if(e.repeat) return;
  const act = classifyKey(e);
  if(!act) return;
  keys[act] = true;
  if(state.inGame) e.preventDefault();
  // Немедленный relay-пуш: ждать до 33 мс тика интервала на мобиле — это
  // ощутимая задержка реакции; плюс в фоне браузер может троттлить таймеры.
  if(typeof relayInputIfGuest === "function") relayInputIfGuest();
}, {passive:false});
window.addEventListener("keyup", e=>{
  const act = classifyKey(e);
  if(act){
    keys[act] = false;
    if(typeof relayInputIfGuest === "function") relayInputIfGuest();
  }
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
  const on  = (e)=>{ e.preventDefault(); keys[act] = true;  if(typeof relayInputIfGuest === "function") relayInputIfGuest(); };
  const off = (e)=>{ e.preventDefault(); keys[act] = false; if(typeof relayInputIfGuest === "function") relayInputIfGuest(); };
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

// Клиент шлёт свои клавиши на серверную физику.
//   host-auth mode: только guest (его инпут едет к host через relay).
//                   guest зеркалит left↔right, т.к. у host он — правый p2.
//   server-auth mode (netMode=="auth"): оба клиента шлют — оба идут в sim
//                   сервера. Host → p1 (левый), БЕЗ зеркала. Guest → p2
//                   (правый), с тем же зеркалом left↔right что и раньше.
// Heartbeat на 30 Гц — страховка на случай, если где-то изменение keys
// произошло вне наших хуков. Сетевые пакеты уходят только когда маска
// (left|right|jump) поменялась.
let _relayLastMask = -1;
function relayInputIfGuest(){
  const shouldSend =
    state.mode === "guest" ||
    (state.mode === "host" && state.netMode === "auth");
  if(!shouldSend) return;
  const ws = gameplaySocket();
  if(!ws) return;
  const mask = (keys.left?1:0) | (keys.right?2:0) | (keys.jump?4:0);
  if(mask === _relayLastMask) return;
  _relayLastMask = mask;
  try {
    if(state.mode === "guest"){
      // Мирор: у хоста/сервера guest = p2 (справа), поэтому left↔right.
      ws.send(Codec.encodeInput(keys.right, keys.left, keys.jump));
    } else {
      // Host в server-auth: left/right идут как есть, p1 = левый игрок.
      ws.send(Codec.encodeInput(keys.left, keys.right, keys.jump));
    }
  } catch(_){}
}
setInterval(relayInputIfGuest, 33);

/* ---------------- Pause & overlay ---------------- */
const overlay = $("overlay");
const overlayBox = $("overlay-box");
const overlayTitle = $("overlay-title");
const overlaySub = $("overlay-sub");
const overlayScore = $("overlay-score");
const overlayScoreP1 = $("overlay-score-p1");
const overlayScoreP2 = $("overlay-score-p2");
const overlayReward = $("overlay-reward");
const overlayRewardVal = $("overlay-reward-val");

// Заполняет end-match оверлей: заголовок (Victory/Defeat), сетка счёта
// (своя сторона слева, соперник справа — как в HUD), подзаголовок с именем
// соперника, pill-реверс трофеев (+win/−loss) как «сюрприз» после матча.
// winnerSide: 1 — наша сторона победила, 2 — соперник. Для форфейта
// sub-строка не зависит от счёта, передаётся явно через subOverride.
function showEndOverlay(winnerSide, s1, s2, subOverride){
  const isWin = winnerSide === 1;
  overlayBox.classList.toggle("is-win",  isWin);
  overlayBox.classList.toggle("is-loss", !isWin);
  overlayTitle.textContent = I18n.t(isWin ? "game.victory" : "game.defeat");
  if(typeof s1 === "number" && typeof s2 === "number"){
    overlayScoreP1.textContent = String(s1);
    overlayScoreP2.textContent = String(s2);
    overlayScore.hidden = false;
  } else {
    overlayScore.hidden = true;
  }
  if(subOverride){
    overlaySub.textContent = subOverride;
  } else {
    const name = isWin ? $("hud-name-p1").textContent : $("hud-name-p2").textContent;
    overlaySub.textContent = name;
  }
  const st = state.stakes;
  const amount = isWin ? (st && st.win | 0) : -(st && st.loss | 0);
  if(amount){
    overlayReward.hidden = false;
    overlayReward.classList.toggle("is-loss", amount < 0);
    overlayRewardVal.textContent = (amount > 0 ? "+" : "") + amount;
  } else {
    overlayReward.hidden = true;
  }
  // Restart reveal animations on each show (overlay reused across matches).
  overlayBox.style.animation = "none";
  overlayReward.style.animation = "none";
  void overlayBox.offsetWidth;
  overlayBox.style.animation = "";
  overlayReward.style.animation = "";
  overlay.classList.remove("hidden");
}
$("btn-replay").addEventListener("click", ()=>{
  // Новый матч — свежий matchId + свежие ставки трофеев. Иначе сервер
  // увидит повторный match_win по закрытому matchId и проигнорирует.
  state.session = { matchId: "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8), startedAt: Date.now(), seq: 0 };
  state.stakes = null;
  requestStakes(state.session.matchId);
  Game.start();
});
function quitToMenu(){
  state.mode = "bot"; state.netMode = "host";
  state.opponent = null;
  state.stakes = null;
  state.session = null;
  Game.stop();
  show("menu");
  // На случай, если за матч изменились трофеи — перерисовать топ сразу.
  refreshOnlineCount();
  refreshLeaderboard();
}
$("btn-quit").addEventListener("click", quitToMenu);
$("btn-home").addEventListener("click", quitToMenu);

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
  // Локальный игрок всегда рисуется слева (сторона 1), неважно host это или
  // guest — гостевой клиент зеркалит снапшот, чтобы «я» был p1.
  Game.triggerEmote(1, btn.dataset.emoteId);
  // Онлайн: пробрасываем эмоцию сопернику через relay.
  if(state.mode !== "bot"){
    const ws = gameplaySocket();
    if(ws){
      const enc = Codec.encodeEmote(btn.dataset.emoteId);
      if(enc){ try { ws.send(enc); } catch(_){} }
    }
  }
  // Снимаем фокус: иначе при клике мышью фокус остаётся на кнопке, и
  // следующие нажатия клавиш (пробел/Enter) ре-триггерят её, а браузер
  // рисует белое кольцо focus-ring поверх пилюли.
  btn.blur();
});

/* Пауза удалена целиком — автопауза по visibilitychange тоже отключена.
   Причины: (1) в онлайне пауза одного клиента не может заморозить
   авторитетного хоста и приводит к рассинхрону / «замиранию» соперника;
   (2) в SP это лишний режим, удобнее просто выйти кнопкой «В меню». */

/* ========================================================================
   GAME
   ======================================================================== */
const Game = (function(){
  // --- World & tuning — ported from classic Slime Volleyball ratios.
  // Ref: hardmaru/slimevolleygym (Neural Slime Volleyball physics).
  // Players are HEMISPHERES: center sits on the ground line, upper half
  // collides with ball. Lower-hemisphere collisions are physically impossible
  // by construction, which kills a whole class of "ball under the floor" bugs.
  //
  // Pure-числа держим в physics.js — клиент и будущий server-authoritative
  // engine обязаны читать одни и те же коэффициенты, иначе prediction и
  // авторитетная симуляция расходятся за секунды. Derived-константы, которые
  // зависят от размеров поля (NET_X, GROUND_Y), остаются тут — они дерируются
  // из WORLD_W/WORLD_H, а те — часть canvas-layout.
  const {
    GRAV, MOVE, JUMP, BALL_R, PLR_R, NET_W, NET_H,
    E_WALL, E_NET, E_GROUND, E_PLAYER_IDLE,
    MAX_BSPD, SERVE_SPAWN_Y, POST_POINT_TIME,
    COYOTE, JUMP_BUFFER,
    STUCK_SPEED, STUCK_TIME,
    STEP_HI, STEP_LO,
    NET_X, GROUND_Y
  } = DVPhysics;
  // На desktop крутим физику на 120 Гц (гладко на 120/144 Гц мониторах).
  // На тач-устройствах — 60 Гц: рендер-интерполяция между prev/curr всё равно
  // сглаживает движение, а мобильный CPU перестаёт тратить по 2 шага физики
  // на каждый кадр. Типовой бюджет кадра 16.67 мс, двойной step — это
  // удвоенная коллизия+AI+трейл, чего мидрейндж-телефон не вывозит.
  //
  // На PC под нагрузкой (GPU contention от соседних вкладок/браузеров,
  // особенно в PvP — там host ещё и broadcastSnapshot крутит 30 Гц) 120-гц
  // step начинает не укладываться в кадр, и мы катимся в catchup-спираль.
  // При срабатывании lowQuality снижаемся до 60 Гц (см. _switchStep) — это
  // ровно та же частота, что на мобиле, и при включённой интерполяции
  // визуально отличается только на >120 Гц мониторах.
  let STEP = (document.body && document.body.classList.contains("is-touch")) ? STEP_LO : STEP_HI;
  function _switchStep(next){
    if(next === STEP) return;
    // Перекладываем остаток аккумулятора в той же шкале времени, чтобы на
    // границе перехода не уронить ни одного тика и не наловить лишних.
    STEP = next;
    if(acc > next * 6) acc = next * 6;
  }

  // Round state
  let rafId = 0, acc = 0, last = 0;
  let p1, p2, ball;
  let score1 = 0, score2 = 0;
  let servingSide = 1;            // 1 left, -1 right
  let roundOver = false;
  let roundTimer = 0;
  let lastWinnerSide = 0;         // выставляется в endMatch — для перерисовки overlay
  let ai;
  // Аккумулятор для 30 Гц-снапшота хоста. Раздельно от физического acc,
  // чтобы сеть не зависела от частоты рендера.
  let snapAcc = 0;
  const SNAP_STEP = 1/30;
  // Snapshot interpolation buffer (режим guest).
  //   snapA — последний потреблённый снапшот; служит «левой» точкой интерполяции
  //     (правая — _snapQAt(0), если есть).
  //   renderDelay — адаптивная задержка рендера соперника/мяча в прошлое.
  //     Считается как max(SNAP_STEP*1.1, p95 интер-арривал гэпов) и клампится
  //     в [40, 140] мс. На локальной игре (RTT ~5 мс, jitter <5 мс) opponent
  //     виден через ~40 мс вместо фиксированных 100; на межконтиненталке сам
  //     поднимется до 120-140 мс и поглотит реальный jitter.
  //   SNAP_Q_MAX — 16 × 16 мс = 270 мс при 60 Гц (Stage 8) либо 16 × 33 мс =
  //     530 мс при fallback 30 Гц. Отсекает зомби-буфер после хитча сети,
  //     drop-oldest не срабатывает на типовых Hathora jitter-спайках.
  // snapQ — ring buffer: на каждый приём снапшота push/shift давали по
  // аллокации Array-внутренностей. На 60 Гц это 120 аллокаций/сек на хол. пути.
  // Держим пул wrapper'ов { recvT, s } фиксированного размера, а snapA/snapB
  // отдаём как прямые индексы в пул.
  const SNAP_Q_MAX = 16;
  const _snapSlots = new Array(SNAP_Q_MAX);
  for(let i = 0; i < SNAP_Q_MAX; i++) _snapSlots[i] = { recvT: 0, s: null };
  let _snapHead = 0;   // индекс самого старого wrapper'а в кольце
  let _snapCount = 0;  // сколько живых элементов в очереди
  function _snapQAt(i){
    if(i < 0 || i >= _snapCount) return null;
    return _snapSlots[(_snapHead + i) % SNAP_Q_MAX];
  }
  // snapA — «левая» точка интерполяции. Храним в отдельной ячейке (не внутри
  // кольца), иначе push поверх её слота затёр бы payload.
  const snapA = { recvT: 0, s: null };
  let snapAValid = false;
  // Stage 8: старт 120 мс, покрывает Hathora edge jitter (TLS + Frankfurt hop),
  // потом p99-адаптация подтянет точно. При низком jitter MIN=50 мс быстро
  // опустит задержку до того же порядка, что и раньше.
  let renderDelay = 0.12;
  // Stage 8 MIN=50 мс (было 70): при 60 Гц snapshot gap ≈ 16 мс, 50 мс это
  //   ровно 3× период — три опорные точки в буфере до цели рендера. Для
  //   локальной игры/LAN (jitter <10 мс) даёт минимальный opponent-lag.
  // Stage 8 MAX=260 мс (было 180): Hathora edge через TLS эпизодически даёт
  //   p99 ≈ 150-200 мс (TCP HoL + TLS record-batching). Старый max=180 мс
  //   буфер пустел на хвосте распределения → extrapolation → при возврате
  //   нормального потока prediction уезжала за 100+ px → hard-snap (визуально
  //   «фриз-рывок»). Подняв max до 260 мс, мы переживаем такие спайки внутри
  //   interpolation'а и даём плавную лерп-кривую между A→B.
  const RENDER_DELAY_MIN = 0.05;
  const RENDER_DELAY_MAX = 0.26;
  const SNAP_GAP_WINDOW = 24;                     // ~0.8 с истории при 30 Гц
  // Ring buffer вместо push/shift массива: push/shift на hot-path 60 Гц
  // давал O(n) сдвиг 24 элементов и GC-давление (slice + sort каждый snap).
  // Float32Array + circular indices — 60 раз/сек одна аллокация под sort'ом
  // вместо двух (push-grow + slice-copy).
  const _snapGapBuf   = new Float32Array(SNAP_GAP_WINDOW);
  const _snapGapScratch = new Float32Array(SNAP_GAP_WINDOW);
  let _snapGapHead  = 0;
  let _snapGapCount = 0;
  function _snapGapsPush(gap){
    _snapGapBuf[_snapGapHead] = gap;
    _snapGapHead = (_snapGapHead + 1) % SNAP_GAP_WINDOW;
    if(_snapGapCount < SNAP_GAP_WINDOW) _snapGapCount++;
  }
  function _snapGapsReset(){ _snapGapHead = 0; _snapGapCount = 0; }

  // Отдельное длинное окно для диагностики TCP head-of-line blocking.
  // _snapGaps короткий (24) и нужен для быстрой адаптации renderDelay к
  // текущему jitter; для хвоста распределения (p99) 24 сэмпла мало — один
  // HoL-спайк уже даёт p99=max, без статистической устойчивости. 300 сэмплов
  // = 10 с истории при 30 Гц: p99 ≈ 3 худших из 300, что достаточно, чтобы
  // различить «чистый канал» (p99 близок к p95) и «TCP HoL» (p99 заметно
  // выше p95, редкие 100-500 мс дыры). Ring buffer без shift/push, чтобы
  // не аллоцировать на hot-path.
  const SNAP_DIAG_WINDOW = 300;
  const _snapDiagBuf = new Float32Array(SNAP_DIAG_WINDOW);
  let _snapDiagHead = 0;
  let _snapDiagCount = 0;
  let _snapDiagMax = 0;
  function _snapDiagPush(gap){
    _snapDiagBuf[_snapDiagHead] = gap;
    _snapDiagHead = (_snapDiagHead + 1) % SNAP_DIAG_WINDOW;
    if(_snapDiagCount < SNAP_DIAG_WINDOW) _snapDiagCount++;
    if(gap > _snapDiagMax) _snapDiagMax = gap;
  }
  function _snapDiagStats(){
    if(_snapDiagCount < 8) return null;
    const arr = new Float32Array(_snapDiagCount);
    for(let i = 0; i < _snapDiagCount; i++) arr[i] = _snapDiagBuf[i];
    Array.prototype.sort.call(arr, (a,b) => a - b);
    const at = q => arr[Math.min(_snapDiagCount - 1, Math.floor(_snapDiagCount * q))];
    return {
      n: _snapDiagCount,
      p50: at(0.50), p95: at(0.95), p99: at(0.99),
      max: arr[_snapDiagCount - 1],
      maxEver: _snapDiagMax
    };
  }
  let _lastSnapRecvT = 0;
  // Счётчики для debug-overlay: видимость, что реконсиляция/экстраполяция
  // реально срабатывают под нагрузкой. _lastP1Drift — мгновенный drift на
  // последнем снапшоте, _bigSnapCount — hard-snap'ы (катастрофический
  // дрейф/respawn), _extrapCount — сколько раз буфер опустел и рендерили
  // экстраполяцией. _snapTotalCount — кумулятив принятых снапшотов, чтобы
  // в оверлее видеть «поток идёт / поток встал». _stepsLastFrame — сколько
  // физ-тиков ушло на прошлом кадре (6 = cap, catchup-стутер после хитча).
  let _lastP1Drift = 0;
  let _bigSnapCount = 0;
  let _extrapCount = 0;
  let _snapTotalCount = 0;
  let _stepsLastFrame = 0;
  // Ring-buffer frame-time'ов для p95 (а не только EWMA). EWMA усредняет
  // спайки до невидимости, хвост распределения точнее показывает stutter.
  const FT_WINDOW = 120;
  const _frameTimeBuf = new Float32Array(FT_WINDOW);
  let _frameTimeHead = 0;
  let _frameTimeCount = 0;
  function _frameTimePush(ft){
    _frameTimeBuf[_frameTimeHead] = ft;
    _frameTimeHead = (_frameTimeHead + 1) % FT_WINDOW;
    if(_frameTimeCount < FT_WINDOW) _frameTimeCount++;
  }
  function _frameTimeP95(){
    if(_frameTimeCount < 8) return null;
    const arr = new Float32Array(_frameTimeCount);
    for(let i = 0; i < _frameTimeCount; i++) arr[i] = _frameTimeBuf[i];
    Array.prototype.sort.call(arr, (a,b) => a - b);
    return arr[Math.min(_frameTimeCount - 1, Math.floor(_frameTimeCount * 0.95))];
  }
  let hitFlash = 0;
  let jumpBufferT = 0;
  let stuckT = 0;
  // Гость: при переходе «ro=true → ro=false» (= хост только что сделал
  // serveBall()) мяч скачком меняет позицию с точки гола на спавн подачи.
  // Без этого флага интерполяция A→B между снапшотами плавно «везла» мяч
  // из точки гола к спавну — выглядело как быстрый полёт. Прячем мяч на
  // время этого A→B окна, чтобы визуально он пропал в точке гола и
  // появился уже на спавне при первом кадре нового раунда.
  let _ballHiddenTeleport = false;

  // --- Production polish state ---
  // Pre-allocated pool: на каждый удар spawnParticles делает 4-22 объекта,
  // и при rally из нескольких ударов подряд это стабильный поток new-object
  // аллокаций. GC-паузы на такие burst'ы дают классический «фриз на удар».
  // Переиспользуем слоты и держим их прямо в массиве particles; field
  // particle.dead=true помечает свободные, чтобы draw/update их пропускали,
  // а spawnParticles сначала искал свободный слот. Нет allocation в hot path.
  const PARTICLE_CAP = 160;
  const particles = new Array(PARTICLE_CAP);
  for(let i = 0; i < PARTICLE_CAP; i++){
    particles[i] = { x:0, y:0, vx:0, vy:0, life:0, age:0, size:0, color:"#fff", dead:true };
  }
  // Trail — ring buffer из двух Float32Array. shift/unshift давали 120
  // allocations/sec на физ-тике; ring buffer на typed arrays — 0 allocations.
  const TRAIL_LEN = 10;
  const trailX = new Float32Array(TRAIL_LEN);
  const trailY = new Float32Array(TRAIL_LEN);
  let trailHead = 0;  // индекс «новейшего» элемента
  let trailCount = 0; // сколько реально заполнено (до TRAIL_LEN)
  // alpha последнего render() — нужен drawTrail, чтобы «хвост» смещался
  // синхронно с телом мяча (иначе между физ-тиками точки трейла отстают).
  let renderAlpha = 1;
  // Адаптивное качество. На слабом десктопе (isTouch=false, но FPS < 50)
  // исходный тяжёлый набор фоновых слоёв (backdrop glow + channel grid +
  // back panels) съедает бюджет кадра. Измеряем усреднённое время кадра
  // и, если стабильно ниже порога, отключаем эти слои на остаток сессии.
  // Один раз вниз — без гистерезиса наверх, чтобы не мигало.
  let frameTimeAvg = 16;
  let slowFrames = 0;
  let lowQuality = false;
  let bigText = null;                    // { text, t, dur, color, size }
  // Активные «эмоции» над игроками. Каждая: { emoji, t, dur, side }.
  // side: 1 — игрок (левый), 2 — соперник (правый).
  // Emotes — pool: до 3 на сторону × 2 = 6 одновременно. Pool на 8 слотов
  // с dead-флагом; push/splice заменены на mutate-in-place.
  const EMOTE_CAP = 8;
  const emotes = new Array(EMOTE_CAP);
  for(let i = 0; i < EMOTE_CAP; i++){
    emotes[i] = { id: "", t: 0, dur: 0, side: 0, seq: 0, dead: true };
  }
  let _emoteSeq = 0;
  const EMOTE_DUR = 1.8;
  const squash = { ball:0, p1:0, p2:0 }; // timers that scale targets briefly
  let clouds = null;                     // parallax cloud layer (icons/bubbles/logos)
  let sparkles = null;                   // faint twinkling dots
  let matchTime = 0;                     // total in-game seconds (for parallax)
  let rallyHits = 0;                     // consecutive hits for combo feedback
  let lastHitSide = 0;                   // side (1/2) последнего касания — для гостевых наград
  let prevSnapRallyHits = 0;             // на клиенте-госте: последний отрисованный счётчик касаний
  // Первый принятый snapshot у гостя. Нужен, чтобы показать корректную
  // подачу на старте: resetMatch() у гостя ставит servingSide=1 и вызывает
  // serveBall() (= showBig «ПОДАЧА»), но реальная сторона подачи приходит
  // только с первого снапшота — и если переход roundOver true→false не
  // срабатывает, гость видит ложную «ПОДАЧА» и без явного индикатора,
  // чья это подача на самом деле. Флаг позволяет один раз триггернуть
  // корректный showBig после зеркалирования ss.
  let firstSnapshotSeen = false;

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
    // prevX/prevY хранят позицию на начало прошлого физ-шага — рендер лерпит между
    // ними и текущими (x,y) по alpha=acc/STEP, чтобы на мониторах 120/144/240 Гц
    // не было stutter между физ-тиками (STEP=1/120). renderX/renderY — результат
    // лерпа, которым пользуются все draw-функции.
    const y = GROUND_Y - PLR_R;
    return { x, y, vx:0, vy:0, r: PLR_R, onGround:true, coyoteT:0, side,
             prevX: x, prevY: y, renderX: x, renderY: y };
  }

  /* ------------- Polish: FX helpers ------------- */
  // Audio is intentionally disabled — stubs kept so call sites stay tidy.
  const noop = ()=>{};
  const sfx = {
    hit: noop, spike: noop, net: noop, jump: noop, bounce: noop,
    serve: noop, point: noop, lose: noop, win: noop
  };

  function spawnParticles(x, y, count, color, speed){
    // Ищем мёртвые слоты в пуле. Если все живы — просто не спавним больше
    // (кап естественный: 160 частиц — потолок на экране).
    let spawned = 0;
    for(let i = 0; i < PARTICLE_CAP && spawned < count; i++){
      const pt = particles[i];
      if(!pt.dead) continue;
      const a = rng()*Math.PI*2;
      const s = speed * (0.4 + rng()*0.8);
      pt.x = x; pt.y = y;
      pt.vx = Math.cos(a)*s;
      pt.vy = Math.sin(a)*s - speed*0.3;
      pt.life = 0.45 + rng()*0.3;
      pt.age = 0;
      pt.size = 2 + rng()*3;
      pt.color = color;
      pt.dead = false;
      spawned++;
    }
  }

  function showBig(text, color, dur, size){
    bigText = { text, t:0, dur: dur||0.9, color: color||"#ffffff", size: size||84 };
  }

  // Fx — аудиовизуальный фидбек общих игровых событий (очко/подача/удар).
  // Единый вход для host-ветки (bot/host моды, авторитетная физика) и
  // guest-ветки (восстановление событий из снапшота). Все методы принимают
  // «локальную» сторону: side===1 — свой игрок, side===2 — соперник. На
  // хосте это совпадает с world-координатами (хост всегда p1); на госте
  // вызывается ПОСЛЕ зеркалирования в consumeSnapshot. Методы не трогают
  // state (score/rallyHits/servingSide) и Wallet — это контекстно-зависимая
  // логика, живёт на стороне вызова. Fx отвечает только за HUD/sfx/particles.
  const Fx = {
    point(localSide, isFoul){
      const elA = $("hud-score-p1"), elB = $("hud-score-p2");
      elA.textContent = String(score1);
      elB.textContent = String(score2);
      const pulseEl = localSide === 1 ? elA : elB;
      pulseEl.classList.remove("pulse");
      void pulseEl.offsetWidth; // reflow to restart animation
      pulseEl.classList.add("pulse");
      spawnParticles(
        ball.x, GROUND_Y - 2, 22,
        localSide === 1 ? "rgba(35,165,90,1)" : "rgba(242,63,66,1)", 260
      );
      if(localSide === 1){
        showBig(I18n.t(isFoul ? "game.foul" : "game.point"), "#23a55a", 0.9, 96);
        sfx.point();
      } else {
        showBig(I18n.t(isFoul ? "game.foul" : "game.miss"),  "#f23f42", 0.9, 80);
        sfx.lose();
      }
    },
    serve(localServingSide){
      sfx.serve();
      showBig(
        I18n.t(localServingSide === 1 ? "game.serve_you" : "game.serve_opp"),
        localServingSide === 1 ? "#ffffff" : "#b5bac1",
        0.8, localServingSide === 1 ? 62 : 46
      );
    },
    hit(localHitSide, x, y, isSpike){
      hitFlash = 1;
      spawnParticles(
        x, y,
        isSpike ? 14 : 8,
        isSpike ? "rgba(255,220,120,1)" : "rgba(255,255,255,0.95)",
        isSpike ? 320 : 220
      );
      squash.ball = Math.max(squash.ball, isSpike ? 0.16 : 0.11);
      if(isSpike) sfx.spike(); else sfx.hit();
    },
    combo(rallyCount){
      if(rallyCount > 0 && rallyCount % 5 === 0){
        showBig("x" + rallyCount, "#ffd34a", 0.6, 52);
      }
    }
  };

  // Публичный триггер реакции. Ограничиваем до 3-х одновременно на сторону,
  // чтобы спам кликов не засыпал экран — более старая замещается новой.
  function triggerEmote(side, id){
    if(!state.inGame || state.matchOver) return;
    if(!id) return;
    // Считаем живые на стороне и одновременно ищем кандидата на вытеснение
    // (самый старый по seq) и свободный слот.
    let count = 0, oldestIdx = -1, oldestSeq = Infinity, freeIdx = -1;
    for(let i = 0; i < EMOTE_CAP; i++){
      const e = emotes[i];
      if(e.dead){ if(freeIdx < 0) freeIdx = i; continue; }
      if(e.side === side){
        count++;
        if(e.seq < oldestSeq){ oldestSeq = e.seq; oldestIdx = i; }
      }
    }
    let slotIdx;
    if(count >= 3 && oldestIdx >= 0){
      slotIdx = oldestIdx;                   // вытесняем самый старый той же стороны
    } else if(freeIdx >= 0){
      slotIdx = freeIdx;                     // свободный слот
    } else {
      return;                                // пул полон — игнорируем (кап 8 и без того щедрый)
    }
    const slot = emotes[slotIdx];
    slot.id   = id;
    slot.t    = 0;
    slot.dur  = EMOTE_DUR;
    slot.side = side;
    slot.seq  = ++_emoteSeq;
    slot.dead = false;
  }

  function buildClouds(){
    // Deterministic backdrop: drifting "server icons" and chat-bubble marks.
    const arr = [];
    const rng = (n)=> ((Math.sin(n*12.9898)*43758.5453) % 1 + 1) % 1;
    const palette = ["#5865f2","#4752c4","#23a55a","#f0b232","#f23f42","#949ba4","#ffffff"];
    const marks = ["#","@","/","&","!","?","+"];
    // На мобиле уменьшаем количество слоёв параллакса — каждый cloud = save/
    // translate/rotate/drawImage/restore, iGPU на слабых телефонах сериализует
    // state-changes и это видно в фризах. На PC тот же набор рендерится без
    // нагрузки, поэтому оставляем полный объём.
    const count = isTouch ? 5 : 10;
    for(let i=0;i<count;i++){
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

  // Tiny sparkle field — faint stars/dots that slowly twinkle.
  function buildSparkles(){
    const arr = [];
    const rng = (n)=> ((Math.sin(n*91.123)*54321.987) % 1 + 1) % 1;
    // Тач-устройства: каждый спаркл — arc+fill с sin() в кадре. 40 штук × 60fps
    // × живой canvas под градиентами ощутимо давит на iGPU. Сокращаем до 15 —
    // визуально почти незаметно на фоне облаков/панелей, перф ощутимо легче.
    const count = (document.body && document.body.classList.contains("is-touch")) ? 15 : 40;
    for(let i=0;i<count;i++){
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
    // Pure-часть (спавн-координаты, clamp по своей половине) — в DVPhysics.
    // Тут — только клиентский wrap: prev/render-поля интерполятора, trail,
    // sfx/визуал через Fx.serve.
    const server = servingSide === 1 ? p1 : p2;
    const serverX = (server && typeof server.x === "number") ? server.x : null;
    const core = DVPhysics.serveBall(servingSide, serverX, WORLD_W, NET_X);
    ball = Object.assign(core, {
      prevX: core.x,  prevY: core.y,  prevAngle: 0,
      renderX: core.x, renderY: core.y, renderAngle: 0
    });
    trailHead = 0; trailCount = 0;
    hitFlash = 0;
    squash.ball = 0;
    rallyHits = 0;
    Fx.serve(servingSide);
  }

  function resetMatch(){
    score1 = 0; score2 = 0;
    state.matchOver = false;
    state.winReported = false;
    state.lossReported = false;
    lastWinnerSide = 0;
    servingSide = 1;
    roundOver = false;
    jumpBufferT = 0;
    stuckT = 0;
    rallyHits = 0;
    lastHitSide = 0;
    prevSnapRallyHits = 0;
    firstSnapshotSeen = false;
    hitFlash = 0;
    matchTime = 0;
    // Сбрасываем буфер интерполяции — старые снапшоты прошлого матча не
    // должны утянуть позиции в новом.
    _snapHead = 0; _snapCount = 0;
    snapA.s = null; snapAValid = false;
    _snapGapsReset();
    _snapDiagHead = 0; _snapDiagCount = 0; _snapDiagMax = 0;
    _lastP1Drift = 0; _bigSnapCount = 0; _extrapCount = 0;
    _snapTotalCount = 0; _stepsLastFrame = 0;
    _frameTimeHead = 0; _frameTimeCount = 0;
    _lastSnapRecvT = 0;
    renderDelay = 0.12;
    _ballHiddenTeleport = false;
    for(let i = 0; i < PARTICLE_CAP; i++) particles[i].dead = true;
    for(let i = 0; i < EMOTE_CAP; i++) emotes[i].dead = true;
    trailHead = 0; trailCount = 0;
    squash.ball = squash.p1 = squash.p2 = 0;
    bigText = null;
    if(!clouds)      clouds     = buildClouds();
    if(!sparkles)    sparkles   = buildSparkles();
    // Сброс счётчиков rate-limit кошелька на новый матч, иначе лимиты
    // «maxPerMatch» останутся от предыдущего.
    Wallet.matchReset();
    // Новая сессия: свой matchId, seq=0. В онлайне именно его мы будем
    // слать на сервер при каждом награждении/вводе. Если startBotMatch/
    // startOnlineMatch уже подложил сессию (с matchId под ставки трофеев) —
    // НЕ перезаписываем, иначе на сервере не сойдётся matchId для match_win.
    if(!state.session) state.session = newSession();
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
    overlay.classList.add("hidden");
    // Clear any stuck input from the menu
    keys.left = keys.right = keys.jump = false;
    state.peerKeys.left = state.peerKeys.right = state.peerKeys.jump = false;
    resetMatch();
    // AI только в режиме против бота — в онлайне p2 ведёт либо хост по
    // локальному вводу соперника, либо сервер-авторитет через снапшоты.
    ai = state.mode === "bot" ? makeAI("medium", rng) : null;
    snapAcc = 0;
    last = Clock.now();
    acc = 0;
    cancelAnimationFrame(rafId);
    // Render a frame immediately so the scene isn't black before first rAF tick
    render();
    rafId = requestAnimationFrame(loop);
  }

  function stop(){
    state.inGame = false;
    state.matchOver = false;
    state.session = null;
    lastWinnerSide = 0;
    cancelAnimationFrame(rafId);
    rafId = 0;
    _setBgTick(false);
    overlay.classList.add("hidden");
  }

  function endMatch(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // Keep the simulation running in the background (ball/players coast on
    // inertia, backdrop keeps drifting). Only input is gated — see step().
    // Повтор доступен всегда: в боте — рестарт, в онлайне — в очередь.
    $("btn-replay").style.display = "";
    showEndOverlay(winnerSide, score1, score2);
    // Drop any keys the user was still holding so players don't keep accelerating.
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      // Приз за матч: в bot/host — своему игроку (p1), в guest матч-монеты
      // ставит endMatchAsSnapshot после зеркалирования.
      if(state.mode === "bot" || state.mode === "host"){
        Wallet.award("match.win", 50);
        reportMatchWin();
      }
    }else{
      sfx.lose();
      // Поражение: bot/host — свой p1 проиграл, списываем трофеи.
      if(state.mode === "bot" || state.mode === "host") reportMatchLoss();
    }
    // Хост отправляет финальный снапшот, чтобы гость корректно закрыл матч —
    // только в legacy host-auth. В server-auth этим рулит сервер.
    if(state.mode === "host" && state.netMode !== "auth"){
      broadcastSnapshot();
    }
  }

  /* ------------- Physics ------------- */
  function step(dt){
    // Снимок prev←curr для render-интерполяции. Делаем ДО любых обновлений
    // позиций: конец прошлого шага == начало текущего. Render между тиками
    // лерпит prev→curr по alpha, убирая stutter на 120/144/240 Гц дисплеях.
    if(p1){ p1.prevX = p1.x; p1.prevY = p1.y; }
    if(p2){ p2.prevX = p2.x; p2.prevY = p2.y; }
    if(ball){ ball.prevX = ball.x; ball.prevY = ball.y; ball.prevAngle = ball.angle; }
    // Tick polish timers (particles, trail, squash, big text).
    // Оборачиваем matchTime, чтобы на длинных сессиях синусы/модульные расчёты
    // не теряли точность. Период кратен 2π (≈17 ч), так что sin-анимации
    // (блики, покачивание тени) остаются непрерывными на границе.
    matchTime = (matchTime + dt) % (Math.PI * 20000);
    for(let i = 0; i < PARTICLE_CAP; i++){
      const pt = particles[i];
      if(pt.dead) continue;
      pt.age += dt;
      if(pt.age >= pt.life){ pt.dead = true; continue; }
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
    for(let i = 0; i < EMOTE_CAP; i++){
      const e = emotes[i];
      if(e.dead) continue;
      e.t += dt;
      if(e.t >= e.dur) e.dead = true;
    }
    // Trail ring buffer: head идёт вперёд, count растёт до TRAIL_LEN.
    trailHead = (trailHead + 1) % TRAIL_LEN;
    trailX[trailHead] = ball.x;
    trailY[trailHead] = ball.y;
    if(trailCount < TRAIL_LEN) trailCount++;

    // Server-driven ветка: получаем снапшоты и рендерим; локально только
    // визуальные тики (частицы/эмоции/трейл) выше + client-side prediction
    // собственного игрока (p1). Используется гостем в host-auth и обоими
    // клиентами в server-auth.
    // Важно выйти ДО post-point countdown: иначе клиент со своим
    // roundTimer=0 каждый кадр, пока авторитет показывает ro=1, вызывал
    // spawnPlayers()/serveBall() и тем самым «телепортировал» фигурки.
    const netDriven = (state.mode === "guest") || (state.netMode === "auth");
    if(netDriven){
      // flip — в каких координатах пришёл снапшот относительно нашей камеры.
      // Гость зеркалит, host в auth-режиме — нет.
      const flip = (state.mode === "guest");
      // Client-side prediction для своего игрока (p1). На интерконтинентальных
      // RTT (150–300 мс) ждать ack'а сервера = видеть залипший слайм, отсюда
      // ощущение «лагов». Мы симулируем p1 локально на тех же константах
      // (MOVE/JUMP/GRAV), что и сервер, через applyHumanInput (coyote/
      // jump-buffer/autohop). Сервер у себя крутит applyHumanInput для p1
      // напрямую по нашему инпуту — reconciliation в consumeSnapshot снапает
      // любую разницу в один кадр.
      if(p1 && !state.matchOver){
        applyHumanInput(p1, dt);
      } else if(p1){
        // Матч закончился — у сервера p1.vx гасится экспоненциально. Дублируем
        // ту же константу, чтобы предсказание не уезжало вечно по инерции.
        const damp = Math.pow(0.4, dt);
        p1.vx *= damp;
      }
      if(p1){
        integratePlayer(p1, dt, 0, NET_X - NET_W*0.5);
      }
      // Потребляем все снапшоты, ready-время которых уже наступило (recvT <= targetT).
      // Каждое потребление даёт авторитетные события/скорости; позиции p2/мяча
      // ставит интерполяция ниже.
      const nowT = Clock.now() / 1000;
      const targetT = nowT - renderDelay;
      while(_snapCount > 0 && _snapSlots[_snapHead].recvT <= targetT){
        const e = _snapSlots[_snapHead];
        consumeSnapshot(e.s);
        snapA.recvT = e.recvT;
        snapA.s     = e.s;
        snapAValid  = true;
        _snapHead = (_snapHead + 1) % SNAP_Q_MAX;
        _snapCount--;
      }
      if(snapAValid && p2 && ball){
        const B = _snapQAt(0);
        // opp source: для guest — s.p1 (world-левый = opp для guest),
        //             для host в auth — s.p2 (world-правый = opp для host).
        // Mirror x/vx/angle только при flip.
        const aOpp = flip ? snapA.s.p1 : snapA.s.p2;
        const aP2x = flip ? (WORLD_W - aOpp.x) : aOpp.x;
        const aP2y = aOpp.y;
        const aBx  = flip ? (WORLD_W - snapA.s.b.x) : snapA.s.b.x;
        const aBy  = snapA.s.b.y;
        const aBa  = flip ? -snapA.s.b.a : snapA.s.b.a;
        if(B){
          const range = B.recvT - snapA.recvT;
          const alpha = range > 1e-6 ? Math.min(1, Math.max(0, (targetT - snapA.recvT) / range)) : 0;
          const bOpp = flip ? B.s.p1 : B.s.p2;
          const bP2x = flip ? (WORLD_W - bOpp.x) : bOpp.x;
          const bP2y = bOpp.y;
          const bBx  = flip ? (WORLD_W - B.s.b.x) : B.s.b.x;
          const bBy  = B.s.b.y;
          const bBa  = flip ? -B.s.b.a : B.s.b.a;
          // Hermite (Catmull-Rom с known tangents) для p2 за window.DV_HERMITE_INTERP:
          // линейная интерполяция даёт видимые «углы» на дугах прыжка при 60 Гц
          // снапшотах. Hermite использует авторитетные vx/vy из снапшотов как
          // тангенсы и даёт плавную кривую. Мяч ОСТАВЛЯЕМ линейным — между A и B
          // может быть коллизия со стеной/сеткой, где скорости меняют знак, и
          // Hermite даст overshoot через препятствие (реальный риск по ревью).
          // Для p2.y включаем только когда оба снапшота в воздухе (!onGround) —
          // иначе отскок от земли между A и B даёт тот же overshoot.
          if(typeof window !== "undefined" && window.DV_HERMITE_INTERP){
            const vax = flip ? -aOpp.vx : aOpp.vx;
            const vbx = flip ? -bOpp.vx : bOpp.vx;
            const vay = aOpp.vy;
            const vby = bOpp.vy;
            const t  = alpha, tt = t*t, ttt = tt*t;
            const h00 = 2*ttt - 3*tt + 1;
            const h10 = ttt - 2*tt + t;
            const h01 = -2*ttt + 3*tt;
            const h11 = ttt - tt;
            p2.x = h00*aP2x + h10*range*vax + h01*bP2x + h11*range*vbx;
            if(!aOpp.g && !bOpp.g){
              p2.y = h00*aP2y + h10*range*vay + h01*bP2y + h11*range*vby;
            } else {
              p2.y = aP2y + (bP2y - aP2y) * alpha;
            }
          } else {
            p2.x = aP2x + (bP2x - aP2x) * alpha;
            p2.y = aP2y + (bP2y - aP2y) * alpha;
          }
          // Телепорт мяча на подачу (см. коммент к roundOver-переходу в консюмере).
          if(snapA.s.ro && !B.s.ro){
            ball.x = bBx; ball.y = bBy; ball.angle = bBa;
            _ballHiddenTeleport = true;
          } else {
            ball.x = aBx + (bBx - aBx) * alpha;
            ball.y = aBy + (bBy - aBy) * alpha;
            ball.angle = aBa + (bBa - aBa) * alpha;
            _ballHiddenTeleport = false;
          }
        } else {
          // Буфер пуст (сетевой дроп/спайк) — форвард-экстраполяция от последнего
          // снапа по его авторитетной скорости.
          const MAX_EXTRAPOLATE = 0.3;
          const dtA = Math.min(MAX_EXTRAPOLATE, Math.max(0, targetT - snapA.recvT));
          if(dtA > 0) _extrapCount++;
          _ballHiddenTeleport = false;
          const vx2 = flip ? -aOpp.vx : aOpp.vx;
          const vy2 = aOpp.vy;
          const vbx = flip ? -snapA.s.b.vx : snapA.s.b.vx;
          const p2gnd = !!aOpp.g;
          p2.x = aP2x + vx2 * dtA;
          p2.y = p2gnd ? aP2y : (aP2y + vy2 * dtA + 0.5 * GRAV * dtA * dtA);
          if(p2.x < p2.r) p2.x = p2.r;
          if(p2.x > WORLD_W - p2.r) p2.x = WORLD_W - p2.r;
          if(p2.y + p2.r > GROUND_Y) p2.y = GROUND_Y - p2.r;
          ball.x = aBx + vbx * dtA;
          ball.y = aBy + snapA.s.b.vy * dtA + 0.5 * GRAV * dtA * dtA;
          ball.angle = aBa + vbx * dtA * 0.025;
          if(ball.x < ball.r) ball.x = ball.r;
          if(ball.x > WORLD_W - ball.r) ball.x = WORLD_W - ball.r;
          if(ball.y + ball.r > GROUND_Y) ball.y = GROUND_Y - ball.r;
        }
      }
      return;
    }

    // Post-point countdown (ball still bouncing, players can still move).
    // Не запускаем новый раунд после окончания матча — мяч остаётся там,
    // где был забит последний гол, всё докатывается по инерции.
    if(roundOver && !state.matchOver){
      roundTimer -= dt;
      if(roundTimer <= 0){
        roundOver = false;
        // Игроков НЕ телепортируем в центр зон — каждый остаётся там, где
        // его застал конец раунда. serveBall() уронит мяч прямо над
        // подающим. Устраняет «дёрганый» возврат слаймов после гола.
        serveBall();
        return;
      }
    }

    // Controls — disabled after the match ends; both slimes coast on inertia.
    if(!state.matchOver){
      applyHumanInput(p1, dt);
      if(state.mode === "host"){
        // Ввод правого игрока приходит по WS от гостя.
        applyInput(p2, state.peerKeys.left, state.peerKeys.right, state.peerKeys.jump);
      }else{
        const aIn = ai.decide(p2, ball, dt);
        applyInput(p2, aIn.left, aIn.right, aIn.jump);
      }
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

      // Side walls only — no ceiling, the ball can arc arbitrarily high.
      DVPhysics.collideBallWalls(ball, WORLD_W);

      {
        const netEv = DVPhysics.collideBallNet(ball, NET_X, GROUND_Y);
        if(netEv.hit && netEv.hitPower > 90){
          sfx.net();
          spawnParticles(ball.x, ball.y, 6, "rgba(255,255,255,0.9)", 140);
          squash.ball = Math.max(squash.ball, 0.08);
        }
      }
      if(!roundOver && !state.matchOver){
        collideBallPlayer(p1);
        if(!roundOver) collideBallPlayer(p2);
      }

      // Ground: award point on first touch, then keep bouncing for POST_POINT_TIME.
      const groundEv = DVPhysics.collideBallGround(ball, GROUND_Y);
      if(groundEv.hit){
        if(groundEv.impactSpeed > 80){
          sfx.bounce();
          spawnParticles(ball.x, GROUND_Y - 2, Math.min(12, 4 + (groundEv.impactSpeed/120)|0), "rgba(255,255,255,1)", 180);
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

    // Хост рассылает снапшот на 30 Гц — только в legacy host-auth. В
    // server-auth авторитет сервер, он сам эмитит снапшоты обоим пирам.
    if(state.mode === "host" && state.netMode !== "auth"){
      snapAcc += dt;
      if(snapAcc >= SNAP_STEP){
        snapAcc = 0;
        broadcastSnapshot();
      }
    }
  }

  function broadcastSnapshot(){
    const ws = gameplaySocket();
    if(!ws) return;
    // Backpressure guard: если сокет не успевает флашиться (плохая сеть у
    // соперника, TCP-буфер забит), не складируем новые снапшоты поверх —
    // гость всё равно увидит устаревшее состояние, зато у нас send() не
    // растёт в синхронной очереди и не блокирует event loop. 8 КБ — это
    // ~130 кадров state (по 61 Б), после которых точно есть отставание.
    if(ws.bufferedAmount > 8192) return;
    try {
      const u = Codec.encodeState(
        p1, p2, ball,
        score1, score2, rallyHits,
        state.matchOver ? 1 : 0,
        roundOver ? 1 : 0,
        servingSide,
        lastWinnerSide,
        lastHitSide
      );
      ws.send(u);
    } catch(_){}
  }

  function applySnapshot(s){
    // Публичная точка входа из onPeerPayload. Просто ставит снапшот в очередь —
    // реальная обработка (consumeSnapshot) произойдёт в step() через RENDER_DELAY,
    // давая буфер для интерполяции между двумя известными кадрами.
    // Принимаем снапшоты: guest (host-auth netMode) + оба пира в server-auth.
    const canApply = (state.mode === "guest") || (state.netMode === "auth");
    if(!canApply || !p1 || !p2 || !ball) return;
    const now = Clock.now() / 1000;
    // Кольцо заполнено → самый старый слот замещается (drop-oldest).
    if(_snapCount === SNAP_Q_MAX){
      _snapHead = (_snapHead + 1) % SNAP_Q_MAX;
      _snapCount--;
    }
    const tailIdx = (_snapHead + _snapCount) % SNAP_Q_MAX;
    const slot = _snapSlots[tailIdx];
    slot.recvT = now;
    slot.s     = s;
    _snapCount++;
    _snapTotalCount++;
    // Stage 8 адаптация: p99 (было p95) интер-арривал гэпов за SNAP_GAP_WINDOW
    // снапшотов. p95 игнорирует хвост распределения — на Hathora TLS-edge
    // именно эти «редкие но болезненные» 100-200 мс спайки давали extrap/
    // hard-snap. p99 × 1.10 целит чуть выше 99-го перцентиля, покрывая 1/100
    // худших гэпов без over-buffering на чистой сети.
    // Не даём колебаниям переехать вниз (EMA-сглаживание на убывании), иначе
    // один быстрый снап утащил бы renderDelay ниже уровня jitter и дал бы
    // hitch через кадр, когда прилетит обычный «запаздыватель».
    if(_lastSnapRecvT > 0){
      const gap = now - _lastSnapRecvT;
      _snapDiagPush(gap);
      _snapGapsPush(gap);
      if(_snapGapCount >= 8){
        // Копируем живой префикс в scratch-буфер и сортируем in-place —
        // нет аллокации на hot-path 60 Гц (slice+sort давал это 60 раз/сек).
        for(let i = 0; i < _snapGapCount; i++) _snapGapScratch[i] = _snapGapBuf[i];
        Array.prototype.sort.call(_snapGapScratch.subarray(0, _snapGapCount), (a,b) => a - b);
        const p99 = _snapGapScratch[Math.min(_snapGapCount - 1, Math.floor(_snapGapCount * 0.99))];
        const target = Math.max(RENDER_DELAY_MIN, Math.min(RENDER_DELAY_MAX, p99 * 1.10));
        // Быстро поднимаемся (чтобы не ловить rubber-band), медленно опускаемся.
        renderDelay = target > renderDelay
          ? target
          : renderDelay * 0.94 + target * 0.06;
      }
    }
    _lastSnapRecvT = now;
  }

  function consumeSnapshot(s){
    // Применение авторитетного снапшота, сдвинутого по времени на RENDER_DELAY.
    // Занимается: событиями (счёт/подача/удар/matchOver), скоростями p2/мяча,
    // реконсиляцией p1. Позиции p2/мяча НЕ ставит — их ставит интерполяция
    // в step() между двумя снапшотами (snapA → snapQ[0]).
    const canApply = (state.mode === "guest") || (state.netMode === "auth");
    if(!canApply || !p1 || !p2 || !ball) return;
    // flip=true — гость: собственный игрок у него слева, но в мировых
    //   координатах авторитета он p2 (справа). Зеркалим x и vx, меняем s1↔s2.
    // flip=false — host в server-auth: мир уже в тех же координатах, что
    //   клиентская камера (свой = p1, слева). Никакого mirror'а.
    const flip = (state.mode === "guest");
    const selfSrc = flip ? s.p2 : s.p1;
    const oppSrc  = flip ? s.p1 : s.p2;
    const mapX  = (x) => flip ? WORLD_W - x : x;
    const mapVx = (v) => flip ? -v : v;
    const mapBA = (a) => flip ? -a : a;
    //
    // Собственный игрок (p1) предсказывается локально в step() — не
    // перезаписываем его из снапшота целиком, иначе на высоком RTT вернётся
    // лаг: сервер видит ввод на RTT/2 позже, его снапшот тянет предсказание
    // назад. Две ветки реконсиляции:
    //   1) hard snap — только для respawn (big) и катастрофического
    //      дрифта (>P1_HARD_SNAP_PX), это телепорт с ресетом скоростей.
    //   2) EMA-catchup — в штатном режиме плавно подтягиваем предсказание
    //      к авторитетной позиции. При высоком RTT prediction стабильно
    //      убегает на MOVE*RTT/2 пикселей вперёд от снапшота сервера, и
    //      агрессивный α даёт визуальный «рывок назад» на каждом снапшоте.
    const CORRECT_SNAP_PX = 120;
    const P1_HARD_SNAP_PX = 400;
    const P1_DEAD_PX       = 25;
    const P1_CATCHUP_ALPHA = 0.10;
    const nx1 = mapX(selfSrc.x), ny1 = selfSrc.y;
    const nx2 = mapX(oppSrc.x),  ny2 = oppSrc.y;
    const nbx = mapX(s.b.x),     nby = s.b.y;
    const big = (Math.abs(nx2 - p2.x) > CORRECT_SNAP_PX || Math.abs(ny2 - p2.y) > CORRECT_SNAP_PX
              || Math.abs(nbx - ball.x) > CORRECT_SNAP_PX || Math.abs(nby - ball.y) > CORRECT_SNAP_PX);
    const p1Drift = Math.hypot(nx1 - p1.x, ny1 - p1.y);
    _lastP1Drift = p1Drift;
    if(big || p1Drift > P1_HARD_SNAP_PX){
      _bigSnapCount++;
      p1.x = nx1; p1.y = ny1; p1.vx = mapVx(selfSrc.vx); p1.vy = selfSrc.vy; p1.onGround = !!selfSrc.g;
      p1.prevX = p1.x; p1.prevY = p1.y;
    } else if(p1Drift > P1_DEAD_PX){
      const excess = (p1Drift - P1_DEAD_PX) / p1Drift;
      p1.x += (nx1 - p1.x) * P1_CATCHUP_ALPHA * excess;
      p1.y += (ny1 - p1.y) * P1_CATCHUP_ALPHA * excess;
    }
    p2.vx = mapVx(oppSrc.vx); p2.vy = oppSrc.vy; p2.onGround = !!oppSrc.g;
    ball.vx = mapVx(s.b.vx); ball.vy = s.b.vy;
    if(big){
      // Respawn/телепорт — снапаем интерполяцию к новым позициям, чтобы на
      // следующем кадре не было визуального «тягучего» перехода через пол-экрана.
      p2.x = nx2; p2.y = ny2;
      ball.x = nbx; ball.y = nby; ball.angle = mapBA(s.b.a);
      p2.prevX = p2.x; p2.prevY = p2.y;
      ball.prevX = ball.x; ball.prevY = ball.y; ball.prevAngle = ball.angle;
    }
    const prevRoundOver = roundOver;
    const prevServingSide = servingSide;
    // servingSide local: 1 = our side serves, 2 = opp. В снапшоте ss=1 =
    // p1 (world-левый) подаёт; при flip это для guest — opp (p2 local).
    servingSide = flip ? (s.ss === 1 ? 2 : 1) : (s.ss === 1 ? 1 : 2);
    roundOver = !!s.ro;
    // Фидбек подачи у гостя: переход roundOver true→false на хосте = только
    // что сработал serveBall(). Показываем тот же showBig/sfx.serve(), что
    // и host, чтобы гость понимал, чья сейчас подача. На первом снапшоте
    // триггерим явно: resetMatch() у гостя по умолчанию показал «ПОДАЧА»
    // (servingSide=1), но реальная сторона могла прийти другой — обновляем,
    // если хост-авторитет не совпал с нашим локальным дефолтом.
    const serveTransition = prevRoundOver && !roundOver;
    const firstServeCorrection = !firstSnapshotSeen && !roundOver && servingSide !== prevServingSide;
    if(serveTransition || firstServeCorrection){
      Fx.serve(servingSide);
    }
    firstSnapshotSeen = true;
    const incomingRh = s.rh || 0;
    // Гостевые награды за касания мяча. В мировых координатах авторитета
    // гость — p2 (lh===2). Счётчик rh только растёт в пределах раунда и
    // сбрасывается в 0 на очко; зеркалим при необходимости, смотрим прирост.
    if(incomingRh > prevSnapRallyHits){
      const deltaHits = incomingRh - prevSnapRallyHits;
      // hitterSide local: 1 = self hit, 2 = opp. На flip lh↔hitterSide.
      const hitterSide = flip
        ? (s.lh === 1 ? 2 : (s.lh === 2 ? 1 : 0))
        : (s.lh | 0);
      // Wallet: начисляем только свои касания (hitterSide===1). Идём по
      // delta'е, а не по одному событию: если между снапшотами прошло
      // несколько касаний подряд, каждое из них — повод для награды.
      if(hitterSide === 1){
        for(let i = 0; i < deltaHits; i++){
          Wallet.award("rally.hit", 1);
          const combo = prevSnapRallyHits + i + 1;
          if(combo > 0 && combo % 5 === 0) Wallet.award("rally.combo", combo);
        }
      }
      // Визуальный фидбек. Хост в collideBallPlayer показывает эффекты
      // локально, но они не летят в снапшот — восстанавливаем их по lh/rh.
      // isSpike мы без дополнительных полей в снапшоте не определим, поэтому
      // на госте всегда обычный удар. Spike-инфо — кандидат в wire-format
      // расширение (этап 2 netcode-плана).
      Fx.hit(hitterSide, ball.x, ball.y, false);
      // squash.p1/p2 — гостевой workaround за отсутствие landing-squash
      // в снапшоте: impact-velocity у хоста срабатывает в integratePlayer,
      // а гость её не видит. Бампим сквош того, кто ударил, чтобы удар
      // «ощущался» визуально не хуже, чем у хоста.
      if(hitterSide === 1)      squash.p1 = Math.max(squash.p1, 0.14);
      else if(hitterSide === 2) squash.p2 = Math.max(squash.p2, 0.14);
      lastHitSide = hitterSide;
      rallyHits = incomingRh;
      Fx.combo(rallyHits);
    }
    prevSnapRallyHits = incomingRh;
    rallyHits = incomingRh;
    const newS1 = flip ? s.s2 : s.s1;
    const newS2 = flip ? s.s1 : s.s2;
    if(newS1 !== score1 || newS2 !== score2){
      const wasP1 = score1, wasP2 = score2;
      score1 = newS1; score2 = newS2;
      // HUD держим в синхроне даже если счёт не вырос — защита от крайнего
      // случая (напр. несинхронный reset), чтобы цифры не разъехались с
      // авторитетом. В штатной игре счёт монотонен, Fx.point ниже всё равно
      // перезапишет те же числа — идемпотентно.
      $("hud-score-p1").textContent = String(score1);
      $("hud-score-p2").textContent = String(score2);
      const scoredSide = (score1 > wasP1) ? 1 : (score2 > wasP2) ? 2 : 0;
      // Фидбек на очко у гостя: ровно тот же Fx.point, что в host'ном
      // awardPoint. reason="foul" не приходит в снапшоте — всегда point/miss.
      // Wallet.award round.win только когда своя сторона (scoredSide===1);
      // на хосте это тоже условно, симметрия сохранена.
      if(scoredSide > 0){
        Fx.point(scoredSide, false);
        if(scoredSide === 1) Wallet.award("round.win", 5);
      }
    }
    if(s.mo && !state.matchOver){
      // winnerSide local: 1 = self won, 2 = opp. При flip меняем местами.
      const winnerLocal = flip ? (s.w === 1 ? 2 : 1) : (s.w | 0);
      endMatchAsSnapshot(winnerLocal);
    }
  }

  function endMatchAsSnapshot(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // После зеркалирования снапшота гость тоже видит «себя» как сторону 1.
    // «Играть заново» в онлайне = выйти из матча и встать в новую очередь.
    $("btn-replay").style.display = "";
    showEndOverlay(winnerSide, score1, score2);
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      // В зеркалке гостя side 1 — это его «я», так что матч-приз его.
      Wallet.award("match.win", 50);
      // Гость репортит в лидерборд только свои победы.
      reportMatchWin();
    }else{
      sfx.lose();
      reportMatchLoss();
    }
  }

  // Соперник вышел из матча — засчитываем форфейт, победа «нашей» стороне (p1)
  // c призом, как за честную победу. Вызывается из onPeerLeft при активном
  // матче. Если матч уже завершён — просто ничего не делаем.
  function endByForfeit(){
    if(!state.inGame || state.matchOver) return;
    state.matchOver = true;
    lastWinnerSide = 1;
    $("btn-replay").style.display = "";
    showEndOverlay(1, score1, score2, I18n.t("game.opponent_left"));
    keys.left = keys.right = keys.jump = false;
    sfx.win();
    Wallet.award("match.win", 50);
  }

  // Бот/удалённый peer: pure-часть в DVPhysics. sfx.jump — клиентский звук.
  function applyInput(p, left, right, jump){
    const ev = DVPhysics.applyInput(p, left, right, jump);
    if(ev.jumped) sfx.jump();
  }

  // Human-control: coyote/jump-buffer в DVPhysics, jumpBufferT храним
  // локально (state caller'а). На Этапе 2 сервер будет держать свой
  // jumpBufferT per-peer и гонять тот же код.
  function applyHumanInput(p, dt){
    const ev = DVPhysics.applyHumanInput(p, dt,
      { left: keys.left, right: keys.right, jumpHeld: keys.jump },
      jumpBufferT);
    jumpBufferT = ev.jumpBufferT;
    if(ev.jumped) sfx.jump();
  }

  function integratePlayer(p, dt, xMin, xMax){
    // Математика — в shared physics.js (тот же код будет крутиться на
    // сервере на Этапе 2). Здесь — только клиентский визуал на posadku.
    const ev = DVPhysics.integratePlayerKinematics(p, dt, xMin, xMax, GROUND_Y);
    if(ev.landed && ev.impactVy > 120){
      if(p.side === 1) squash.p1 = 0.18;
      else             squash.p2 = 0.18;
      spawnParticles(p.x, GROUND_Y - 2, Math.min(8, (ev.impactVy/110)|0), "rgba(255,255,255,0.9)", 120);
    }
  }

  // Pure-физика — в shared physics.js (Этап 2 netcode будет крутить её на
  // сервере). Здесь — только application-state: FX, счётчики touches, 4-touch
  // rule, Wallet.award. Гостю lastHitSide/очки прилетают через applySnapshot,
  // поэтому rally.hit начисляется только в bot/host и только для p.side===1.
  function collideBallPlayer(p){
    const ev = DVPhysics.collideBallPlayer(ball, p, GROUND_Y);
    if(!ev.hit) return;
    Fx.hit(p.side, ev.fxX, ev.fxY, ev.isSpike);
    rallyHits++;
    lastHitSide = p.side;
    Fx.combo(rallyHits);
    const isOwnHit = (p.side === 1) && (state.mode === "bot" || state.mode === "host");
    if(isOwnHit){
      Wallet.award("rally.hit", 1);
      if(rallyHits > 0 && rallyHits % 5 === 0) Wallet.award("rally.combo", rallyHits);
    }
    if(p.side === 1){ ball.touches.left++;  ball.touches.right = 0; }
    else            { ball.touches.right++; ball.touches.left  = 0; }
    if(ball.touches.left  >= 4){ awardPoint(2, "foul"); return; }
    if(ball.touches.right >= 4){ awardPoint(1, "foul"); return; }
  }

  // reason: "foul" — очко присуждено за 4-е касание соперника (лишнее).
  // В этом случае показываем "ФОЛ/FOUL" вместо обычного "ОЧКО/ПРОПУСК",
  // цвет оставляем тот же (зелёный если выиграли, красный если проиграли).
  function awardPoint(side, reason){
    if(roundOver) return;
    roundOver = true;
    roundTimer = POST_POINT_TIME;
    rallyHits = 0;
    if(side===1){ score1++; servingSide = 1; }
    else        { score2++; servingSide = -1; }
    Fx.point(side, reason === "foul");
    // Монеты: +5 за выигранное очко. Bot/host — когда side===1 (свой игрок).
    // Гостю начисляется в applySnapshot, когда его «свой» счёт (mirror s.s2)
    // вырос между снапшотами.
    if(side === 1 && (state.mode === "bot" || state.mode === "host")) Wallet.award("round.win", 5);
    const t = state.targetScore;
    if((score1 >= t || score2 >= t) && Math.abs(score1 - score2) >= 2){
      endMatch(score1 > score2 ? 1 : 2);
    }
  }

  /* ------------- Render ------------- */
  function render(alpha){
    if(!p1) return;
    // Лерп prev→curr по alpha. Все draw-функции читают .renderX/.renderY
    // вместо .x/.y, чтобы между физ-тиками не было stutter.
    const a = (alpha == null) ? 1 : alpha;
    renderAlpha = a;
    const lerp = (p, c) => p + (c - p) * a;
    p1.renderX = lerp(p1.prevX, p1.x); p1.renderY = lerp(p1.prevY, p1.y);
    p2.renderX = lerp(p2.prevX, p2.x); p2.renderY = lerp(p2.prevY, p2.y);
    if(ball){
      ball.renderX = lerp(ball.prevX, ball.x);
      ball.renderY = lerp(ball.prevY, ball.y);
      ball.renderAngle = lerp(ball.prevAngle, ball.angle);
    }
    const cw = canvas.width, ch = canvas.height;
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0,0,cw,ch);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    // Clip every world-space draw to the playfield rect so particles, big
    // text etc. never bleed into the letterbox bars on wide screens.
    ctx.beginPath();
    ctx.rect(0, 0, WORLD_W, WORLD_H);
    ctx.clip();

    // Sky + backdrop-glow запечены в один спрайт — 1 drawImage вместо 3
    // полноэкранных alpha-fill'ов каждый кадр.
    buildBackdropSprite();
    ctx.drawImage(_backdropSprite, 0, 0, WORLD_W, WORLD_H);
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
    // Trail — 15 накладных arc+fill на быстром мяче. На мобиле в lowQuality
    // срубаем: мяч и так хорошо виден по squash+hitFlash, а GPU-fill-rate
    // разгружается заметно.
    if(!(isTouch && lowQuality)) drawTrail();
    drawPlayer(p1, playerUser(1));
    drawPlayer(p2, playerUser(2));
    drawServeIndicator();
    drawBall();
    drawParticles();
    drawEmotes();
    drawBigText();

    ctx.restore();

    // Off-screen мяч-индикатор живёт в canvas-space (вне world-clip),
    // чтобы его можно было прижать к нижнему краю HUD-панельки, а не
    // к верхней границе мира (которая при cover-fit уходит за canvas).
    drawBallOffscreenIndicator();
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

  // Каждое облако — набор статичных векторных фигур. Один раз рендерим
  // в офскрин-спрайт, дальше просто blit через drawImage (+ translate/rotate),
  // чтобы освободить 2D-контекст от десятков path-команд за кадр.
  function buildCloudSprite(c){
    const s = c.size;
    const side = Math.ceil(s * 2.4);
    const off = document.createElement("canvas");
    off.width = side;
    off.height = side;
    const octx = off.getContext("2d");
    const cx = side / 2, cy = side / 2;
    if(c.kind === "logo")      drawCloudLogo(octx, cx, cy, s, c.color);
    else if(c.kind === "icon") drawCloudIcon(octx, cx, cy, s, c.color, c.mark);
    else                       drawCloudBubble(octx, cx, cy, s, c.color);
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
    // Fade from oldest to newest; only while ball is moving fast enough.
    const speed2 = ball.vx*ball.vx + ball.vy*ball.vy;
    if(speed2 < 260*260) return;
    if(trailCount < 3) return;
    // Ring buffer: trailHead — новейший, шаги назад = (head - i + TRAIL_LEN)%TRAIL_LEN.
    // Тело мяча — lerp(trail[1], trail[0]). Каждая точка смещается на alpha:
    // effective[i] = lerp(trail[i+1], trail[i]).
    const a = renderAlpha;
    const inv = 1 / TRAIL_LEN;
    for(let i = 1; i < trailCount - 1; i++){
      const cIdx = (trailHead - i + TRAIL_LEN) % TRAIL_LEN;
      const oIdx = (trailHead - (i+1) + TRAIL_LEN) % TRAIL_LEN;
      const x = trailX[oIdx] + (trailX[cIdx] - trailX[oIdx]) * a;
      const y = trailY[oIdx] + (trailY[cIdx] - trailY[oIdx]) * a;
      const t = i * inv;
      const alpha = (1 - t) * 0.35;
      const r = ball.r * (1 - t*0.6);
      ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
    }
  }

  function drawParticles(){
    for(let i = 0; i < PARTICLE_CAP; i++){
      const pt = particles[i];
      if(pt.dead) continue;
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

    const headY = p.renderY - p.r - 24;
    const cx = p.renderX + wobble;
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
    for(let i = 0; i < EMOTE_CAP; i++){ if(!emotes[i].dead) drawEmote(emotes[i]); }
    ctx.globalAlpha = 1;
  }

  function drawServeIndicator(){
    // Small arrow above the server's head until they first hit the ball
    if(rallyHits > 0 || roundOver) return;
    const sp = servingSide === 1 ? p1 : p2;
    const sx = sp.renderX;
    const sy = sp.renderY - sp.r - 18;
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
  let _netHaloGrad = null, _netPostsGrad = null,
      _ballNormalGrad = null, _ballFlashGrad = null;

  const BALL_TEX = new Image();
  BALL_TEX.src = "assets/volleyball.png";

  // Static backdrop baked to OffscreenCanvas (или обычный canvas для Safari ≤16.3):
  // раньше каждый кадр рисовали sky-gradient + два radial-glow полноэкранно —
  // это 3 тяжёлых alpha-fill'а на GPU. Теперь один drawImage, сам спрайт
  // строится один раз и пересобирается только на смене quality (lo/hi).
  let _backdropSprite = null;
  let _backdropSpriteQ = "";
  function _makeOffscreen(w, h){
    if(typeof OffscreenCanvas !== "undefined"){
      try{ return new OffscreenCanvas(w, h); }catch(_){}
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  function buildBackdropSprite(){
    const q = (!isTouch && !lowQuality) ? "hi" : "lo";
    if(_backdropSprite && _backdropSpriteQ === q) return;
    if(!_backdropSprite) _backdropSprite = _makeOffscreen(WORLD_W, WORLD_H);
    const g = _backdropSprite.getContext("2d");
    g.clearRect(0, 0, WORLD_W, WORLD_H);
    const sky = g.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0,    "#1e1f22");
    sky.addColorStop(0.55, "#2b2d31");
    sky.addColorStop(1,    "#313338");
    g.fillStyle = sky;
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    if(q === "hi"){
      const gl1 = g.createRadialGradient(WORLD_W*0.78, 110, 0, WORLD_W*0.78, 110, 320);
      gl1.addColorStop(0,    "rgba(88,101,242,0.38)");
      gl1.addColorStop(0.55, "rgba(88,101,242,0.10)");
      gl1.addColorStop(1,    "rgba(88,101,242,0)");
      g.fillStyle = gl1;
      g.fillRect(0, 0, WORLD_W, GROUND_Y);
      const gl2 = g.createRadialGradient(WORLD_W*0.18, GROUND_Y*0.7, 0, WORLD_W*0.18, GROUND_Y*0.7, 260);
      gl2.addColorStop(0, "rgba(35,165,90,0.18)");
      gl2.addColorStop(1, "rgba(35,165,90,0)");
      g.fillStyle = gl2;
      g.fillRect(0, 0, WORLD_W, GROUND_Y);
    }
    _backdropSpriteQ = q;
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

  // Кеш атласов украшений: один Image на URL, переиспользуется между
  // игроками, матчами и ре-рендерами. Пустой src никогда не кешируем —
  // такая запись может блокировать будущие попытки.
  // После загрузки атлас разрезается на массив offscreen-канвасов по кадрам:
  // render рисует готовый кадр одним drawImage без аргументов-кропа, что на
  // слабых GPU дешевле, чем сэмплить из большой текстуры с sx/sy/sw/sh каждый
  // кадр на каждого игрока.
  const decoAtlasCache = new Map();
  function getDecoAtlas(url){
    if(!url) return null;
    let entry = decoAtlasCache.get(url);
    if(!entry){
      const img = new Image();
      img.decoding = "async";
      entry = { img, frames: null };
      img.src = url;
      decoAtlasCache.set(url, entry);
    }
    return entry;
  }
  function getDecoFrameCanvas(entry, cols, rows, frames, idx){
    if(!entry || !entry.img || !entry.img.complete || !entry.img.naturalWidth) return null;
    if(!entry.frames || entry.frames.length !== frames
       || entry._cols !== cols || entry._rows !== rows){
      const fw = entry.img.naturalWidth  / cols;
      const fh = entry.img.naturalHeight / rows;
      const arr = new Array(frames);
      for(let i = 0; i < frames; i++){
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.floor(fw));
        c.height = Math.max(1, Math.floor(fh));
        const g = c.getContext("2d");
        const col = i % cols;
        const row = (i / cols) | 0;
        try{ g.drawImage(entry.img, col*fw, row*fh, fw, fh, 0, 0, c.width, c.height); }
        catch(_){ return null; }
        arr[i] = c;
      }
      entry.frames = arr;
      entry._cols = cols; entry._rows = rows;
    }
    return entry.frames[idx] || null;
  }

  // Фолбэк-юзер для рендера, когда state.opponent/state.user временно
  // null — например, peer_left мидматч после forfeit: оппонент чистится,
  // но render продолжается до unmount overlay'ем. Без фолбэка drawPlayer
  // кидал TypeError по .avatar_url на каждый кадр, забивая консоль и сжирая
  // CPU перехватами ошибок на слабых устройствах.
  const FALLBACK_USER = { color: "#5865f2", global_name: "?", avatar_url: null };
  function getAvatarCanvas(user, size){
    if(!user) user = FALLBACK_USER;
    // Фастпас: в пределах одного матча user-объект не меняется, и аватар
    // нам нужен одного и того же размера каждый кадр. Пришиваем ссылку на
    // canvas прямо к user и возвращаем без аллокаций. На мобиле это снимает
    // 2 строковые аллокации + sanitizeAvatarUrl regex каждый кадр × 2 игрока
    // × 60 fps = ощутимая GC-нагрузка.
    if(user._avatarCanvas && user._avatarCanvasSize === size) return user._avatarCanvas;
    const safeUrl = Auth.sanitizeAvatarUrl(user.avatar_url);
    const key = (safeUrl || user.color || "?") + "|" + (user.global_name||user.username||"?") + "|" + size;
    const hit = avatarCacheGet(key);
    if(hit){ user._avatarCanvas = hit; user._avatarCanvasSize = size; return hit; }
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
    user._avatarCanvas = c;
    user._avatarCanvasSize = size;
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
    const px = p.renderX, py = p.renderY;
    // Ground shadow scales with height off the ground.
    // p.y is the CENTER; on the ground p.y == GROUND_Y - r (feet on floor).
    const feetY = py + r;
    const air = Math.min(1, Math.max(0, (GROUND_Y - feetY) / 200));
    const sh  = 1 - air*0.5;
    ctx.fillStyle = "rgba(0,0,0," + (0.32 - air*0.18) + ")";
    ctx.beginPath();
    ctx.ellipse(px, GROUND_Y - 1, r*0.95*sh, 6*sh, 0, 0, Math.PI*2);
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
    ctx.translate(px, py + r * (1 - syAxis));
    ctx.scale(sxAxis, syAxis);

    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.clip();
    ctx.drawImage(av, -r, -r, size, size);
    ctx.restore();

    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4; ctx.stroke();

    // Украшение: берём заранее нарезанный кадр из атласа и рисуем поверх
    // аватара. Размер — тот же «inset:-18%», что и в DOM (avatar ×1.36).
    // Без clip — нимб/звёзды должны выходить за рамку.
    const deco = user && user.decoration;
    if(deco && deco.atlas && (deco.frames|0) > 0 && (deco.cols|0) > 0 && (deco.rows|0) > 0){
      const entry = getDecoAtlas(deco.atlas);
      const fps    = Math.max(1, deco.fps|0);
      const frames = deco.frames|0;
      const cols   = deco.cols|0;
      const rows   = deco.rows|0;
      const idx    = Math.floor(performance.now() * fps / 1000) % frames;
      const frame  = getDecoFrameCanvas(entry, cols, rows, frames, idx);
      if(frame){
        const dSize = size * 1.36;
        try {
          ctx.drawImage(frame, -dSize/2, -dSize/2, dSize, dSize);
        } catch(_){}
      }
    }

    ctx.restore();
  }

  function drawBall(){
    if(_ballHiddenTeleport) return;
    const bx = ball.renderX, by = ball.renderY;
    // Soft ground shadow scaled by height above court
    const shf = 1 - Math.min(0.7, (GROUND_Y - by)/GROUND_Y);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(bx, GROUND_Y - 2, ball.r*1.15*shf, 5*shf, 0, 0, Math.PI*2);
    ctx.fill();

    // Squash-and-stretch along velocity vector for a brief moment after a hit
    const sqAmt = squash.ball > 0 ? (squash.ball / 0.16) : 0;
    const stretch = 1 + sqAmt * 0.28;
    const squeeze = 1 - sqAmt * 0.22;
    const ang = Math.atan2(ball.vy, ball.vx);

    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang);
    ctx.scale(stretch, squeeze);
    ctx.rotate(-ang);
    ctx.rotate(ball.renderAngle);

    if(BALL_TEX.complete && BALL_TEX.naturalWidth){
      ctx.drawImage(BALL_TEX, -ball.r, -ball.r, ball.r*2, ball.r*2);
      if(hitFlash > 0){
        // На PC мяч ~96 px — overlay #fff7c2 с "lighter" при alpha 0.55
        // заметно обесцвечивает текстуру. На мобилке ~12 px это незаметно.
        // Снижаем кап и скорость нарастания, чтобы вспышка подчёркивала удар,
        // а не выжигала оранжевый.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.min(0.28, hitFlash * 1.4);
        ctx.fillStyle = "#fff7c2";
        ctx.beginPath(); ctx.arc(0, 0, ball.r, 0, Math.PI*2); ctx.fill();
        ctx.restore();
      }
    } else {
      ctx.fillStyle = hitFlash > 0 ? ballFlashGrad() : ballNormalGrad();
      ctx.beginPath(); ctx.arc(0, 0, ball.r, 0, Math.PI*2); ctx.fill();
    }

    ctx.restore();
  }

  // Когда мяч улетает выше видимой области, рисуем прямо под HUD-панелькой
  // со счётом стрелку, указывающую вверх, и едущую по X за мячом. Работаем
  // в canvas-space (после ctx.restore()), чтобы стрелка гарантированно
  // оказалась ниже HUD DOM-элемента, а не упиралась в верхнюю границу мира
  // (при cover-fit она выезжает за canvas). Цвет в тон мяча (amber).
  const _hudBarEl = document.querySelector(".hud");
  function drawBallOffscreenIndicator(){
    if(!ball) return;
    if(_ballHiddenTeleport) return;
    const offTop = -ball.renderY;
    if(offTop <= ball.r) return;
    const alpha = Math.min(1, (offTop - ball.r) / 24);
    if(alpha <= 0) return;

    const canvasRect = canvas.getBoundingClientRect();
    if(!canvasRect.width || !canvasRect.height) return;
    const physPerCss = canvas.width / canvasRect.width;

    // Нижний край HUD в канвас-физических пикселях + отступ. Fallback на
    // фикс. значение, если по какой-то причине HUD не нашёлся.
    let iy;
    if(_hudBarEl){
      const hr = _hudBarEl.getBoundingClientRect();
      iy = (hr.bottom - canvasRect.top + 10) * physPerCss;
    } else {
      iy = 64 * physPerCss;
    }

    // X мяча в canvas-space (поверх world-transform). Мяч может быть
    // ball.renderX > WORLD_W / < 0 при сильном боковом вылете — клампим,
    // чтобы стрелка жила в кадре.
    const bxWorld = Math.max(0, Math.min(WORLD_W, ball.renderX));
    const bxCanvas = offsetX + bxWorld * scale;
    const pulse = 1 + 0.08 * Math.sin(matchTime * 7);
    const w = 30 * physPerCss * pulse;
    const h = 26 * physPerCss * pulse;
    const edgePad = w * 0.5 + 8 * physPerCss;
    const ix = Math.max(edgePad, Math.min(canvas.width - edgePad, bxCanvas));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ix, iy);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 6 * physPerCss;
    ctx.shadowOffsetY = 2 * physPerCss;
    ctx.fillStyle = "#f0b232";
    ctx.strokeStyle = "rgba(15,16,18,0.75)";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5 * physPerCss;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.55);
    ctx.lineTo(w * 0.5, h * 0.45);
    ctx.lineTo(-w * 0.5, h * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /* ------------- Loop ------------- */
  // Ядро тика: физика + опциональный рендер. Вызывается из rAF-loop, когда
  // вкладка видима, и из Worker-драйвера (`_bgTick`), когда вкладка в фоне —
  // браузер троттлит rAF до ~1 Гц на hidden-табах, и у хоста это ломает матч
  // для оппонента (мяч «замирает», потому что физ-шаг и broadcastSnapshot
  // перестают идти). Worker-таймеры троттлу не подвержены.
  function _tickCore(){
    const now = Clock.now();
    let dt = (now - last) / 1000;
    last = now;
    if(dt > 0.25) dt = 0.25;
    acc += dt;
    let steps = 0;
    const profile = window.__dvProfile === true;
    const t0 = profile ? performance.now() : 0;
    while(acc >= STEP && steps < 6){
      step(STEP);
      acc -= STEP;
      steps++;
    }
    if(steps === 6) acc = 0;
    _stepsLastFrame = steps;
    if(!document.hidden) _frameTimePush(dt * 1000);
    const t1 = profile ? performance.now() : 0;
    // alpha ∈ [0,1] — доля незакоммиченного физ-времени между последним
    // и следующим шагом. Передаём в render(), чтобы при рендер-частоте
    // выше физ-частоты (120/144/240 Гц) позиции между тиками интерполировались,
    // а не «дёргались». В hidden-режиме рендер пропускаем — экран не виден.
    if(!document.hidden){
      const alpha = Math.min(1, Math.max(0, acc / STEP));
      render(alpha);
    }
    if(profile){
      const t2 = performance.now();
      if(!window.__dvProf) window.__dvProf = { step: [], render: [], steps: [] };
      window.__dvProf.step.push(t1 - t0);
      window.__dvProf.render.push(t2 - t1);
      window.__dvProf.steps.push(steps);
    }
    // Адаптивное качество: считаем EWMA времени кадра. Порог 22 мс ≈ 45 FPS
    // — ниже этого на десктопе включаем lowQuality и скидываем тяжёлые
    // фоновые слои. Нужно подряд несколько «плохих» кадров, чтобы не
    // реагировать на разовый GC-пик. В hidden-режиме не считаем — dt там
    // фиксированный 16мс от воркера и к реальному frame-time не относится.
    if(!document.hidden && !lowQuality){
      const ft = dt * 1000;
      frameTimeAvg = frameTimeAvg * 0.9 + ft * 0.1;
      // Одиночный жирный кадр (>60 мс) — это уже catchup-стутер. На PC в
      // двух вкладках/браузерах такие хитчи идут каждые пару секунд от
      // GPU/CPU contention, и если ждать 60 подряд «плохих» кадров (EWMA-
      // порог), то деградации не произойдёт никогда — хитчи редкие, EWMA
      // усредняет их до нормы. Накидываем сразу 20 очков: три таких хитча
      // за короткий период уже переваливают порог и срубают тяжёлый glow/
      // trail. Мгновенный кап 150 мс = моментальный freeze — такой единичный
      // кадр сразу включает lowQuality, без ожидания. На мобиле пороги
      // щадящие (iGPU слабее, 30 fps — норма, деградируем только на явных
      // фризах: >200 мс single frame или >33 мс среднее).
      const hardFreeze = isTouch ? 200 : 150;
      const hitch      = isTouch ? 100 : 60;
      const avgSlow    = isTouch ? 33  : 22;
      if(ft > hardFreeze){ lowQuality = true; }
      else if(ft > hitch){ slowFrames += 20; if(slowFrames > 40) lowQuality = true; }
      else if(frameTimeAvg > avgSlow){
        slowFrames++;
        if(slowFrames > 40) lowQuality = true;
      } else {
        slowFrames = Math.max(0, slowFrames - 1);
      }
      // Как только деградировали на десктопе — снижаем физ-рейт со 120 до
      // 60 Гц. Это убирает второй step-вызов на каждый кадр (коллизии/
      // integrate/broadcast-аккумулятор), давая host'у в PvP запас на сеть
      // и рендер. В онлайне хостовой броадкаст идёт от acc в step(), так
      // что частота снапшотов не меняется — SNAP_STEP=33мс независимо от STEP.
      if(lowQuality && !isTouch && STEP !== STEP_LO) _switchStep(STEP_LO);
    }
  }

  function loop(){
    rafId = requestAnimationFrame(loop);
    _tickCore();
  }

  // Background-tick через Worker. Таймеры воркера НЕ троттлятся, так что
  // даже когда вкладка в фоне (rAF выдаёт ~1 Гц), мы продолжаем гонять
  // физику и рассылать снапшоты — это критично на стороне хоста, иначе
  // «оппонент переключил вкладку» = матч замерзает для второго игрока.
  let _bgWorker = null;
  let _bgActive = false;
  function _ensureBgWorker(){
    if(_bgWorker || typeof Worker === "undefined") return _bgWorker;
    try{
      const src =
        "let h=null;onmessage=function(e){" +
        "if(e.data===1){if(h)return;h=setInterval(function(){postMessage(0);},16);}" +
        "else{if(h){clearInterval(h);h=null;}}};";
      const url = URL.createObjectURL(new Blob([src], {type:"application/javascript"}));
      _bgWorker = new Worker(url);
      URL.revokeObjectURL(url);
      _bgWorker.onmessage = () => {
        if(!_bgActive) return;
        if(!state.inGame) return;
        _tickCore();
      };
    }catch(_){ _bgWorker = null; }
    return _bgWorker;
  }
  function _setBgTick(on){
    if(_bgActive === on) return;
    _bgActive = on;
    const w = _ensureBgWorker();
    if(w){ try{ w.postMessage(on ? 1 : 0); }catch(_){} }
  }

  // Синхронизация источника тика с видимостью вкладки. В foreground — rAF,
  // в background — worker-таймер, но только для участников, которые
  // двигают авторитетное состояние (host в legacy host-auth или bot).
  // В server-auth ни одному клиенту не надо тикать в фоне — авторитет
  // сервер, всё что нужно — принимать снапшоты при возврате во фронт.
  document.addEventListener("visibilitychange", () => {
    if(document.hidden){
      if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
      const needsBgTick =
        state.mode === "bot" ||
        (state.mode === "host" && state.netMode !== "auth");
      if(state.inGame && needsBgTick){
        // last обновится в первом же _tickCore — это нормально, просто первый
        // dt будет 0 (Clock.now() только что писали в last внутри loop).
        last = Clock.now();
        acc = 0;
        _setBgTick(true);
      }
    } else {
      _setBgTick(false);
      // Сбрасываем last/acc, чтобы по возврату из фона не было жирного
      // catchup-хитча (dt за время отсутствия мог быть большим).
      last = Clock.now();
      acc = 0;
      if(state.inGame && !rafId) rafId = requestAnimationFrame(loop);
    }
  });

  // Перерисовать тексты overlay после смены языка. Ничего не делает,
  // если overlay скрыт. На форфейте подзаголовок — локализованный, и
  // showEndOverlay перезапишет его по lastWinnerSide — для форфейта уже
  // нет точного признака, поэтому просто обновим title+name (sub-override
  // теряется на смену языка — редкий кейс, не стоит того).
  function refreshOverlay(){
    if(overlay.classList.contains("hidden")) return;
    if(state.matchOver){
      showEndOverlay(lastWinnerSide, score1, score2);
    }
  }

  // Debug-хук только под тестами. В продакшне p1/p2/ball инкапсулированы.
  function _debug(){
    const nowSec = Clock.now() / 1000;
    const ws = (typeof state !== "undefined") ? state.ws : null;
    const wsState = ws ? ({0:"CONN", 1:"OPEN", 2:"CLOSING", 3:"CLOSED"})[ws.readyState] || "?" : "(none)";
    const gws = (typeof state !== "undefined") ? state.gameWs : null;
    const gameWsState = gws ? ({0:"CONN", 1:"OPEN", 2:"CLOSING", 3:"CLOSED"})[gws.readyState] || "?" : "(none)";
    // performance.memory — только в Chrome/Edge. Null-безопасно: если движок
    // не отдаёт, ничего страшного, просто не показываем строку.
    const mem = (typeof performance !== "undefined" && performance.memory)
      ? performance.memory.usedJSHeapSize / 1048576
      : null;
    return {
      mode: state.mode, inGame: state.inGame, matchOver: state.matchOver,
      p1: p1 ? { x: p1.x, y: p1.y, vx: p1.vx, vy: p1.vy, g: p1.onGround } : null,
      p2: p2 ? { x: p2.x, y: p2.y, vx: p2.vx, vy: p2.vy, g: p2.onGround } : null,
      ball: ball ? { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy } : null,
      score1, score2, snapQLen: _snapCount,
      snapAtoB: snapAValid && _snapCount > 0 ? (_snapQAt(0).recvT - snapA.recvT) : null,
      renderDelay,
      // Perf-снимок: EWMA frame-time + p95 хвост, флаг деградации, current
      // STEP в Гц, slowFrames к lowQuality-порогу, сколько физ-шагов ушло
      // на прошлом кадре (6 = cap, post-hitch catchup). heapMB = JS-heap,
      // растущая кривая = утечка.
      frameTimeAvg, frameTimeP95: _frameTimeP95(),
      lowQuality, slowFrames, stepHz: Math.round(1 / STEP),
      stepsLastFrame: _stepsLastFrame,
      heapMB: mem,
      // Netcode-счётчики + live-поле «сколько мс назад приходил последний
      // снапшот»: если растёт и не обнуляется — поток от хоста встал.
      p1Drift: _lastP1Drift, bigSnaps: _bigSnapCount, extraps: _extrapCount,
      snapTotal: _snapTotalCount,
      timeSinceSnap: _lastSnapRecvT > 0 ? (nowSec - _lastSnapRecvT) : null,
      wsState, gameWsState,
      // Скорость мяча — «мяч должен двигаться, а vx/vy=0» = физика встала.
      ballSpeed: ball ? Math.hypot(ball.vx, ball.vy) : 0,
      // Jitter-статистика по 300 последним интер-арривалам снапшотов
      // (host→guest). Диагноз TCP head-of-line blocking: p99 заметно выше
      // p95 (например p95=45 мс, p99=250 мс) = редкие выпавшие сегменты
      // держат буфер ядра на время retransmit. Null, пока сэмплов мало.
      snapJitter: _snapDiagStats()
    };
  }
  return { start, stop, refreshOverlay, triggerEmote, applySnapshot, endByForfeit, _debug };
})();
if (typeof window !== "undefined") window.__dvDebug = () => Game._debug();

/* ========================================================================
   Runtime debug overlay. Toggle: ?debug=1 в URL или F9.
   Показывает perf + netcode-снимок в углу экрана. Обновляется 3 Гц, сам
   панель в DOM (не canvas), чтобы не влезать в render loop. При скрытом
   оверлее интервал снимается — нулевой cost для обычных игроков.
   ======================================================================== */
(function(){
  if(typeof window === "undefined" || typeof document === "undefined") return;
  let panel = null;
  let timerId = 0;
  let visible = false;

  function build(){
    const el = document.createElement("div");
    el.id = "dv-debug-overlay";
    el.style.cssText = [
      "position:fixed","top:8px","left:8px","z-index:9999",
      "padding:8px 10px","background:rgba(0,0,0,0.72)","color:#c6f",
      "font:11px/1.35 ui-monospace,Consolas,monospace","border-radius:6px",
      "pointer-events:none","white-space:pre","min-width:220px",
      "box-shadow:0 2px 8px rgba(0,0,0,0.4)"
    ].join(";");
    el.textContent = "debug: waiting for game…";
    document.body.appendChild(el);
    return el;
  }

  function fmt(n, digits){
    if(n == null || Number.isNaN(n)) return "—";
    if(typeof n !== "number") return String(n);
    return n.toFixed(digits == null ? 1 : digits);
  }

  function tick(){
    if(!panel || !visible) return;
    let d;
    try{ d = window.__dvDebug && window.__dvDebug(); }catch(_){ d = null; }
    if(!d){ panel.textContent = "debug: game not ready"; return; }
    const fps = d.frameTimeAvg > 0 ? 1000 / d.frameTimeAvg : 0;
    const j = d.snapJitter;
    // «Возраст» последнего снапшота в мс — если поток встал, значение растёт
    // без обнуления, визуальный сигнал на рост видно сразу.
    const sinceMs = d.timeSinceSnap != null ? d.timeSinceSnap * 1000 : null;
    const lines = [
      "mode: " + (d.mode || "—") + (d.inGame ? " (in-game)" : "") + (d.matchOver ? " END" : "") + (d.lowQuality ? " LQ" : ""),
      "fps:  " + fmt(fps, 0) + "   ft avg/p95: " + fmt(d.frameTimeAvg) + "/" + (d.frameTimeP95 != null ? fmt(d.frameTimeP95) : "—") + "ms",
      "step: " + d.stepHz + "Hz   steps/f: " + d.stepsLastFrame + (d.stepsLastFrame >= 6 ? "!" : "") + "   slow: " + d.slowFrames,
      "heap: " + (d.heapMB != null ? fmt(d.heapMB, 0) + "MB" : "—") + "   score: " + d.score1 + ":" + d.score2,
      "— netcode —",
      "ws: " + d.wsState + "   snaps: " + d.snapTotal + "   since: " + (sinceMs != null ? fmt(sinceMs, 0) + "ms" : "—"),
      "renderDelay: " + fmt(d.renderDelay * 1000, 0) + "ms   snapQ: " + d.snapQLen + "   A→B: " + (d.snapAtoB != null ? fmt(d.snapAtoB * 1000, 0) + "ms" : "—"),
      "drift: " + fmt(d.p1Drift, 0) + "px   hardsnap: " + d.bigSnaps + "   extrap: " + d.extraps,
      j
        ? "jitter p50/p95/p99: " + fmt(j.p50 * 1000, 0) + "/" + fmt(j.p95 * 1000, 0) + "/" + fmt(j.p99 * 1000, 0) + "ms (n=" + j.n + ")"
        : "jitter: collecting…",
      "ball: " + fmt(d.ballSpeed, 0) + "px/s"
    ];
    panel.textContent = lines.join("\n");
  }

  function show(){
    if(visible) return;
    visible = true;
    if(!panel) panel = build();
    panel.style.display = "block";
    tick();
    timerId = setInterval(tick, 300);
  }

  function hide(){
    if(!visible) return;
    visible = false;
    if(timerId){ clearInterval(timerId); timerId = 0; }
    if(panel) panel.style.display = "none";
  }

  function toggle(){ visible ? hide() : show(); }

  window.__dvDebugOverlay = { show, hide, toggle };

  document.addEventListener("keydown", (e) => {
    // F9 — тогглер. Не мешает игровому вводу (используем keydown на document,
    // но слаймы берут W/A/D/стрелки, так что F9 не конфликтует).
    if(e.key === "F9"){ e.preventDefault(); toggle(); }
  });

  function maybeAutoShow(){
    try{
      const q = new URLSearchParams(window.location.search);
      if(q.get("debug") === "1") show();
    }catch(_){}
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", maybeAutoShow, { once: true });
  } else {
    maybeAutoShow();
  }
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
  let target = WORLD_W * 0.75;
  // Физ-константы + world config — из общего DVPhysics (physics.js),
  // чтобы AI и движок не разъезжались при тюнинге.
  const { GRAV, PLR_R, NET_X, GROUND_Y } = DVPhysics;
  // AI aims to strike the ball at its ideal hit zone — just above the player's head.
  const STRIKE_Y = GROUND_Y - PLR_R * 2.4;

  function predictLanding(ball, targetY){
    const a = 0.5*GRAV, b = ball.vy, c = ball.y - targetY;
    const D = b*b - 4*a*c;
    if(D < 0) return ball.x;
    const tFall = (-b + Math.sqrt(D)) / (2*a);
    let x = ball.x + ball.vx * tFall;
    if(x < 0) x = -x;
    if(x > WORLD_W) x = 2 * WORLD_W - x;
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
      const home = WORLD_W * 0.75 - 50*cfg.homeBias;
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

/* ---------------- Decorations ----------------
   UI для покупки и выбора украшений аватара. Каталог и состояние
   (owned / selected / coins) берём из /api/decorations; покупка и выбор —
   POST-ручки с query-параметром id. Сервер — единственный авторитет:
   клиентская сумма монет никогда не передаётся, цену и валидность id
   сервер проверяет сам.

   Почему не рисуем каталог из захардкоженного списка: добавление нового
   украшения должно сводиться к правке server.js (и файлы ассетов), без
   обновления клиента. */
const Decorations = (function(){
  let catalog = null;
  let owned = [];
  let selected = null;
  const modal = $("decorations-modal");
  const list  = $("decorations-list");

  async function open(){
    modal.classList.remove("hidden");
    await refresh();
  }
  function close(){ modal.classList.add("hidden"); }

  async function refresh(){
    try{
      const r = await fetch("/api/decorations", { credentials: "same-origin" });
      if(!r.ok){ renderError(); return; }
      const j = await r.json();
      catalog  = Array.isArray(j.catalog) ? j.catalog : [];
      owned    = Array.isArray(j.owned)   ? j.owned   : [];
      selected = j.selected || null;
      if(typeof j.coins === "number") Wallet.set(j.coins, 0);
      render();
    }catch(_){ renderError(); }
  }

  function renderError(){
    list.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.style.textAlign = "center";
    msg.style.padding = "16px";
    msg.textContent = "—";
    list.appendChild(msg);
  }

  function render(){
    list.innerHTML = "";
    list.appendChild(rowNone());
    for(const d of catalog) list.appendChild(rowDeco(d));
  }

  function rowNone(){
    const row = document.createElement("div");
    row.className = "deco-row";
    if(!selected) row.classList.add("is-selected");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;

    const thumb = document.createElement("div");
    thumb.className = "avatar deco-thumb";
    // Превью: сам аватар юзера без украшения. Так видно, как будет
    // выглядеть профиль, если сбросить выбор украшения.
    if(state.user) Auth.renderAvatarInto(thumb, { ...state.user, decoration: null });

    const info = document.createElement("div");
    info.className = "deco-info";
    const name = document.createElement("div");
    name.className = "deco-name";
    name.textContent = I18n.t("deco.none");
    info.appendChild(name);

    const radio = document.createElement("div");
    radio.className = "deco-radio";

    row.append(thumb, info, radio);
    const activate = ()=>{ if(selected !== null) select(null); };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (e)=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); } });
    return row;
  }

  function rowDeco(d){
    const row = document.createElement("div");
    row.className = "deco-row";
    const isOwned = owned.indexOf(d.id) >= 0;
    const isSel   = selected === d.id;
    if(isSel) row.classList.add("is-selected");
    row.setAttribute("role", "listitem");

    const thumb = document.createElement("div");
    thumb.className = "avatar deco-thumb";
    // Превью: аватар юзера + украшение сверху — так видно, как будет
    // выглядеть профиль даже до покупки.
    if(state.user){
      Auth.renderAvatarInto(thumb, { ...state.user, decoration: d });
    }else{
      Auth.attachDecoration(thumb, d);
    }

    const info = document.createElement("div");
    info.className = "deco-info";
    const name = document.createElement("div");
    name.className = "deco-name";
    // Кастомные (загруженные админом) украшения приходят со своим title —
    // его и показываем. Для встроенных deco1..deco4 title пуст, и фоллбек
    // идёт на i18n-ключ deco.name_<id>, где живёт локализованное имя.
    name.textContent = (d.title && d.title.trim()) ? d.title : I18n.t("deco.name_" + d.id);
    info.appendChild(name);
    const sub = document.createElement("div");
    sub.className = "deco-sub";
    if(!isOwned){
      const coinImg = document.createElement("img");
      coinImg.className = "coin";
      coinImg.src = "assets/coin.gif";
      coinImg.alt = "";
      coinImg.setAttribute("aria-hidden", "true");
      coinImg.width = 14; coinImg.height = 14;
      const price = document.createElement("span");
      price.textContent = String(d.price | 0);
      sub.append(coinImg, price);
    }else{
      sub.textContent = I18n.t(isSel ? "deco.selected" : "deco.owned");
    }
    info.appendChild(sub);

    let action;
    if(!isOwned){
      action = document.createElement("button");
      action.className = "btn btn-primary";
      action.textContent = I18n.t("deco.buy");
      action.addEventListener("click", (e)=>{ e.stopPropagation(); buy(d, action); });
    }else if(isSel){
      action = document.createElement("div");
      action.className = "deco-radio";
    }else{
      action = document.createElement("button");
      action.className = "btn btn-ghost";
      action.textContent = I18n.t("deco.select");
      action.addEventListener("click", (e)=>{ e.stopPropagation(); select(d.id); });
    }

    row.append(thumb, info, action);
    // Клик по всей строке купленного украшения — тоже выбор (как в примере).
    if(isOwned && !isSel){
      row.addEventListener("click", ()=> select(d.id));
    }
    return row;
  }

  async function buy(d, btnEl){
    const price = d.price | 0;
    if(btnEl) btnEl.disabled = true;
    try{
      const r = await fetch("/api/decorations/buy?id=" + encodeURIComponent(d.id), {
        method: "POST",
        credentials: "same-origin"
      });
      const j = await r.json().catch(()=>({}));
      if(r.status === 402){
        if(btnEl){
          btnEl.disabled = false;
          const orig = btnEl.textContent;
          btnEl.textContent = I18n.t("deco.insufficient");
          setTimeout(()=>{ btnEl.textContent = orig; }, 1500);
        }
        return;
      }
      if(!r.ok){ if(btnEl) btnEl.disabled = false; return; }
      if(typeof j.coins === "number") Wallet.set(j.coins, -price);
      owned = Array.isArray(j.owned) ? j.owned : owned;
      render();
    }catch(_){ if(btnEl) btnEl.disabled = false; }
  }

  async function select(id){
    try{
      const url = "/api/decorations/select" + (id == null ? "" : ("?id=" + encodeURIComponent(id)));
      const r = await fetch(url, { method: "POST", credentials: "same-origin" });
      if(!r.ok) return;
      const j = await r.json();
      selected = j.selected || null;
      // Синхронизируем state.user и перерисовываем все видимые аватары.
      if(state.user){
        state.user.decoration = j.decoration || null;
        Auth.renderAvatarInto($("user-avatar"), state.user);
        if(!screens.game.classList.contains("hidden")) refreshLocalizedDynamicUI();
      }
      render();
    }catch(_){}
  }

  return { open, close };
})();

$("btn-decorations").addEventListener("click", (e)=>{
  e.stopPropagation();
  closeUserPopup();
  Decorations.open();
});
$("btn-decorations-close").addEventListener("click", Decorations.close);
$("decorations-modal").addEventListener("click", (e)=>{
  if(e.target.id === "decorations-modal") Decorations.close();
});
document.addEventListener("keydown", (e)=>{
  if(e.key === "Escape" && !$("decorations-modal").classList.contains("hidden")) Decorations.close();
});

/* Admin -----------------------------------------------------------------
   Строго UI-only модуль: решение, админ ты или нет, принимает сервер
   (user.is_admin в /api/me). Режим — клиентский переключатель (что
   показывать в шапке), в localStorage. Даже при ручном включении в
   DevTools серверные ручки /api/admin/* проверят право отдельно. */
const Admin = (function(){
  const KEY = "dv_admin_mode_v1";
  const toggleBtn = $("btn-admin-toggle");
  const addBtn    = $("btn-admin-add");
  const shopBtn   = $("btn-admin-shop");
  const modal     = $("admin-modal");
  const form      = $("admin-form");
  const targetIn  = $("admin-target");
  const amountIn  = $("admin-amount");
  const msgEl     = $("admin-msg");

  function isAllowed(){ return !!(state.user && state.user.is_admin); }
  function isOn(){
    if(!isAllowed()) return false;
    try{ return localStorage.getItem(KEY) === "1"; }catch(_){ return false; }
  }
  function setOn(v){
    try{ localStorage.setItem(KEY, v ? "1" : "0"); }catch(_){}
    applyUi();
  }
  function applyUi(){
    const allowed = isAllowed();
    toggleBtn.classList.toggle("hidden", !allowed);
    const on = allowed && isOn();
    toggleBtn.classList.toggle("is-on", on);
    toggleBtn.setAttribute("aria-checked", on ? "true" : "false");
    addBtn.classList.toggle("hidden", !on);
    if(shopBtn) shopBtn.classList.toggle("hidden", !on);
  }

  toggleBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    if(!isAllowed()){ closeUserPopup(); return; }
    setOn(!isOn());
    closeUserPopup();
  });
  addBtn.addEventListener("click", ()=>{
    if(!isOn()) return;
    openModal();
  });
  if(shopBtn) shopBtn.addEventListener("click", ()=>{
    if(!isOn()) return;
    AdminShop.open();
  });

  function openModal(){
    setMsg("", "");
    targetIn.value = "";
    amountIn.value = "";
    modal.classList.remove("hidden");
    setTimeout(()=> targetIn.focus(), 30);
  }
  function closeModal(){ modal.classList.add("hidden"); }
  function setMsg(text, kind){
    msgEl.textContent = text || "";
    msgEl.classList.remove("is-err", "is-ok");
    if(kind === "err") msgEl.classList.add("is-err");
    if(kind === "ok")  msgEl.classList.add("is-ok");
  }

  $("btn-admin-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e)=>{ if(e.target.id === "admin-modal") closeModal(); });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const q = targetIn.value.trim();
    // Принимаем +N / −N / -N; NBSP минус (−, U+2212) отдельно, пользователь
    // может вставить его из системной клавиатуры. Знак обязателен — иначе
    // команда двусмысленная («100» это +100 или −100?).
    const raw = amountIn.value.trim().replace(/\u2212/g, "-");
    const m = /^([+-])(\d+)$/.exec(raw);
    if(!q){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
    if(!m){ setMsg(I18n.t("admin.err_amount"), "err"); return; }
    const delta = (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10);
    if(!Number.isFinite(delta) || delta === 0){ setMsg(I18n.t("admin.err_amount"), "err"); return; }
    try{
      // Резолвим id: числовой snowflake Discord / dev-id → сразу, иначе
      // lookup по username/global_name.
      let id = q;
      if(!/^\d{5,}$/.test(q)){
        const r = await fetch("/api/admin/lookup?q=" + encodeURIComponent(q), { credentials: "same-origin" });
        if(r.status === 404){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
        if(!r.ok){ setMsg(I18n.t("admin.err_generic"), "err"); return; }
        const j = await r.json();
        id = j.id;
      }
      const r2 = await fetch("/api/admin/coins?id=" + encodeURIComponent(id) + "&delta=" + delta, {
        method: "POST", credentials: "same-origin"
      });
      if(r2.status === 404){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
      if(!r2.ok){ setMsg(I18n.t("admin.err_generic"), "err"); return; }
      const j2 = await r2.json();
      setMsg(fmtI18n("admin.ok", { coins: j2.coins }), "ok");
    }catch(_){ setMsg(I18n.t("admin.err_generic"), "err"); }
  });

  return { applyUi };
})();

/* ---------------- Admin shop ----------------
   CRUD каталога украшений без редеплоя: GET /api/admin/decorations (список),
   POST multipart (создание/обновление), DELETE по id. Клиент строит список +
   форму, но все проверки (права, валидация полей, PNG-сигнатура атласа)
   лежат на сервере — UI тут чисто удобство. */
const AdminShop = (function(){
  const modal   = $("admin-shop-modal");
  const list    = $("admin-shop-list");
  const form    = $("admin-shop-form");
  const newBtn  = $("btn-admin-shop-new");
  const closeBtn= $("btn-admin-shop-close");
  const cancelBtn = $("btn-admin-shop-cancel");
  const formHead = $("admin-shop-form-head");
  const idIn     = $("admin-shop-id");
  const titleIn  = $("admin-shop-title-in");
  const priceIn  = $("admin-shop-price");
  const sortIn   = $("admin-shop-sort");
  const framesIn = $("admin-shop-frames");
  const fpsIn    = $("admin-shop-fps");
  const frameWIn = $("admin-shop-framew");
  const frameHIn = $("admin-shop-frameh");
  const colsIn   = $("admin-shop-cols");
  const rowsIn   = $("admin-shop-rows");
  const atlasIn  = $("admin-shop-atlas");
  const atlasHint= $("admin-shop-atlas-hint");
  const msgEl    = $("admin-shop-msg");

  let catalog = [];
  let editingId = null; // null = новое украшение, иначе id редактируемого

  function open(){
    modal.classList.remove("hidden");
    hideForm();
    refresh();
  }
  function close(){ modal.classList.add("hidden"); hideForm(); }

  function setMsg(text, kind){
    msgEl.textContent = text || "";
    msgEl.classList.remove("is-err", "is-ok");
    if(kind === "err") msgEl.classList.add("is-err");
    if(kind === "ok")  msgEl.classList.add("is-ok");
  }

  async function refresh(){
    try{
      const r = await fetch("/api/admin/decorations", { credentials: "same-origin" });
      if(!r.ok){ renderError(); return; }
      const j = await r.json();
      catalog = Array.isArray(j.catalog) ? j.catalog : [];
      render();
    }catch(_){ renderError(); }
  }

  function renderError(){
    list.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.style.padding = "12px";
    msg.style.textAlign = "center";
    msg.textContent = "—";
    list.appendChild(msg);
  }

  function render(){
    list.innerHTML = "";
    if(!catalog.length){
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "12px";
      empty.style.textAlign = "center";
      empty.textContent = "—";
      list.appendChild(empty);
      return;
    }
    for(const d of catalog) list.appendChild(rowOf(d));
  }

  function rowOf(d){
    const row = document.createElement("div");
    row.className = "admin-shop-row";
    if(d.builtin) row.classList.add("is-builtin");

    const thumb = document.createElement("div");
    thumb.className = "admin-shop-thumb";
    if(d.atlas){
      // Для превью берём кадр 0 (левый-верхний угол атласа) через
      // background-size / background-position, не страдая от тяжёлого
      // анимационного рендера в списке.
      // updatedAt = epoch ms: Number(...) без побитовых трюков, иначе v=
      // превратится в отрицательное число и cache-buster станет мусором.
      const ver = Number(d.updatedAt) || 0;
      thumb.style.backgroundImage = `url("${d.atlas}${d.atlas.includes("?") ? "&" : "?"}v=${ver}")`;
      thumb.style.backgroundSize = `${(d.cols|0)*100}% ${(d.rows|0)*100}%`;
      thumb.style.backgroundPosition = "0 0";
    }

    const meta = document.createElement("div");
    meta.className = "admin-shop-meta";
    const title = document.createElement("div");
    title.className = "admin-shop-meta-title";
    title.textContent = (d.title && d.title.trim()) || d.id;
    const sub = document.createElement("div");
    sub.className = "admin-shop-meta-sub";
    const idTag = document.createElement("span");
    idTag.className = "tag";
    idTag.textContent = d.id;
    sub.appendChild(idTag);
    if(d.builtin){
      const bi = document.createElement("span");
      bi.className = "tag";
      bi.textContent = I18n.t("admin.shop_builtin");
      sub.appendChild(bi);
    }
    const price = document.createElement("span");
    price.textContent = (d.price|0) + " ◦ " + (d.frames|0) + "×" + (d.cols|0) + "×" + (d.rows|0) + " @" + (d.fps|0);
    sub.appendChild(price);
    meta.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "admin-shop-actions-row";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-ghost";
    editBtn.textContent = I18n.t("admin.shop_edit");
    editBtn.addEventListener("click", ()=> openEdit(d));
    actions.appendChild(editBtn);
    if(!d.builtin){
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost";
      delBtn.textContent = I18n.t("admin.shop_delete");
      delBtn.addEventListener("click", ()=> del(d.id));
      actions.appendChild(delBtn);
    }

    row.append(thumb, meta, actions);
    return row;
  }

  function showForm(){ form.classList.remove("hidden"); }
  function hideForm(){
    form.classList.add("hidden");
    form.reset();
    editingId = null;
    idIn.disabled = false;
    setMsg("", "");
  }

  function openNew(){
    hideForm();
    editingId = null;
    formHead.textContent = I18n.t("admin.shop_new_title");
    idIn.disabled = false;
    sortIn.value = "100";
    fpsIn.value  = "12";
    frameWIn.value = "96";
    frameHIn.value = "96";
    showForm();
    setTimeout(()=> idIn.focus(), 30);
  }

  function openEdit(d){
    hideForm();
    editingId = d.id;
    formHead.textContent = fmtI18n("admin.shop_edit_title", { id: d.id });
    idIn.value = d.id;
    idIn.disabled = true;
    titleIn.value = d.title || "";
    priceIn.value = String(d.price | 0);
    sortIn.value  = String(d.sortOrder | 0);
    framesIn.value = String(d.frames | 0);
    fpsIn.value    = String(d.fps | 0);
    frameWIn.value = String(d.frameW | 0);
    frameHIn.value = String(d.frameH | 0);
    colsIn.value   = String(d.cols | 0);
    rowsIn.value   = String(d.rows | 0);
    atlasIn.value = "";
    showForm();
    setTimeout(()=> titleIn.focus(), 30);
  }

  async function del(id){
    const msg = fmtI18n("admin.shop_confirm_del", { id });
    if(!window.confirm(msg)) return;
    try{
      const r = await fetch("/api/admin/decorations/" + encodeURIComponent(id), {
        method: "DELETE", credentials: "same-origin"
      });
      if(!r.ok){ setMsg(I18n.t("admin.shop_err_generic"), "err"); return; }
      setMsg(I18n.t("admin.shop_deleted"), "ok");
      refresh();
    }catch(_){ setMsg(I18n.t("admin.shop_err_generic"), "err"); }
  }

  function serverErrorToI18n(err){
    switch(err){
      case "bad_id":            return "admin.shop_err_id";
      case "missing_field":
      case "bad_field":         return "admin.shop_err_field";
      case "atlas_bad_format":  return "admin.shop_err_format";
      case "atlas_too_large":   return "admin.shop_err_big";
      case "frames_exceed_grid":return "admin.shop_err_grid";
      case "atlas_required":    return "admin.shop_err_atlas_req";
      default:                  return "admin.shop_err_generic";
    }
  }

  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData();
    fd.set("id",        idIn.value.trim());
    fd.set("title",     titleIn.value.trim());
    fd.set("price",     String(parseInt(priceIn.value, 10) || 0));
    fd.set("sortOrder", String(parseInt(sortIn.value, 10) || 0));
    fd.set("frames",    String(parseInt(framesIn.value, 10) || 0));
    fd.set("fps",       String(parseInt(fpsIn.value, 10) || 0));
    fd.set("frameW",    String(parseInt(frameWIn.value, 10) || 0));
    fd.set("frameH",    String(parseInt(frameHIn.value, 10) || 0));
    fd.set("cols",      String(parseInt(colsIn.value, 10) || 0));
    fd.set("rows",      String(parseInt(rowsIn.value, 10) || 0));
    const file = atlasIn.files && atlasIn.files[0];
    if(file) fd.set("atlas", file);
    try{
      const r = await fetch("/api/admin/decorations", {
        method: "POST", credentials: "same-origin", body: fd
      });
      const j = await r.json().catch(()=>({}));
      if(!r.ok){
        setMsg(I18n.t(serverErrorToI18n(j && j.error)), "err");
        return;
      }
      setMsg(I18n.t("admin.shop_saved"), "ok");
      hideForm();
      refresh();
    }catch(_){ setMsg(I18n.t("admin.shop_err_generic"), "err"); }
  });

  newBtn.addEventListener("click", openNew);
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", hideForm);
  modal.addEventListener("click", (e)=>{ if(e.target.id === "admin-shop-modal") close(); });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !modal.classList.contains("hidden")){
      if(!form.classList.contains("hidden")) hideForm(); else close();
    }
  });

  return { open, close };
})();

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
