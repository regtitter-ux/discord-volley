/* Volleyball Online — lightweight vanilla canvas game.
   No frameworks, no build. Fixed-timestep physics @ 120Hz, rendered via rAF.

   Не оборачиваем в IIFE: decorations-ui.js / admin.js подгружаются
   отдельными <script>-тегами и обращаются к state / Wallet / Auth / I18n /
   closeUserPopup / screens / fmtI18n / refreshLocalizedDynamicUI напрямую
   через shared script scope. IIFE изолировала бы эти имена и сломала
   ссылки из соседних скриптов. */
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
  // Пауза на время активного canvas-матча: rAF-тикер DecoAnim крутится
  // параллельно с Game.loop и на каждый кадр дёргает dataset + пишет в
  // style.backgroundPosition для всех attached элементов (DOM-write +
  // partial style recalc). Во время матча анимация украшений в HUD-аватарах
  // визуально теряется на фоне canvas, и выгоднее приглушить второй rAF.
  let paused = false;
  function attach(el){
    if(!el) return;
    layers.add(el);
    if(!running && !paused){ running = true; requestAnimationFrame(tick); }
  }
  function detach(el){ layers.delete(el); }
  function pause(){
    paused = true;
    // running сам сбросится в tick() — не форсим, чтобы не терять кадр.
  }
  function resume(){
    if(!paused) return;
    paused = false;
    if(!running && layers.size > 0){ running = true; requestAnimationFrame(tick); }
  }
  function tick(){
    if(paused){ running = false; return; }
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
  return { attach, detach, pause, resume };
})();
window.DecoAnim = DecoAnim;

/* ---------------- State ---------------- */
const state = {
  user: null,
  bot: null,
  mode: "bot",
  ws: null,
  targetScore: 10,
  inGame: false,
  matchOver: false,
  // Защёлка: match_win/match_loss уходят на сервер не больше одного раза
  // за матч.
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
   Под именем у p1 — баланс кубков (из Trophies, обновляется от сервера).
   У p2 (бот) трофей нет — прячем. */
function renderHudTrophies(){
  const p1el  = $("hud-trophies-p1");
  const p1val = $("hud-trophies-val-p1");
  if(p1el && p1val){
    p1val.textContent = String(Trophies.get());
    p1el.hidden = false;
  }
  const p2el = $("hud-trophies-p2");
  if(p2el) p2el.hidden = true;
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

// В каких ролях на поле показаны игроки. Игрок всегда слева (p1), бот справа (p2).
function playerUser(side){
  return side === 1 ? state.user : state.bot;
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
    $("hud-name-p2").textContent = botDisplayName(right);
  }
  $("hud-diff").textContent = I18n.t("hud.bot");
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
  state.mode = "bot";
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
  // Любой ресайз → инвалидируем кеш rect'ов, которым пользуется
  // drawBallOffscreenIndicator. Фоллбэк на условие — на случай если Game
  // IIFE ещё не подгрузилась на момент первого вызова.
  if (typeof window.__dvInvalidateLayout === "function") window.__dvInvalidateLayout();
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
  state.mode = "bot";
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
  // Локальный игрок всегда рисуется слева (сторона 1).
  Game.triggerEmote(1, btn.dataset.emoteId);
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
  // На PC под нагрузкой (GPU contention от соседних вкладок/браузеров) 120-гц
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
  // Сторона, на которой мяч был в прошлом физ-тике (1=слева от сетки, 2=справа).
  // Любое пересечение NET_X обнуляет ball.touches — чтобы отскоки от стены
  // на чужой половине и возврат к тому же игроку не засчитывались как фол.
  let lastBallSide = 1;
  let roundOver = false;
  let roundTimer = 0;
  let lastWinnerSide = 0;         // выставляется в endMatch — для перерисовки overlay
  let ai;
  let _stepsLastFrame = 0;
  // Ring-buffer frame-time'ов для p95 (а не только EWMA). EWMA усредняет
  // спайки до невидимости, хвост распределения точнее показывает stutter.
  const FT_WINDOW = 120;
  const _frameTimeBuf = new Float32Array(FT_WINDOW);
  // Отдельный буфер для sort — держим на уровне замыкания, не аллоцируем
  // новый TypedArray на каждый вызов. При открытом debug-overlay _debug()
  // крутится каждые 300 мс, и раньше каждый вызов порождал ArrayBuffer,
  // засоряющий heap ровно тогда, когда пользователь диагностирует фризы.
  const _frameTimeSort = new Float32Array(FT_WINDOW);
  let _frameTimeHead = 0;
  let _frameTimeCount = 0;
  function _frameTimePush(ft){
    _frameTimeBuf[_frameTimeHead] = ft;
    _frameTimeHead = (_frameTimeHead + 1) % FT_WINDOW;
    if(_frameTimeCount < FT_WINDOW) _frameTimeCount++;
  }
  function _frameTimeP95(){
    if(_frameTimeCount < 8) return null;
    for(let i = 0; i < _frameTimeCount; i++) _frameTimeSort[i] = _frameTimeBuf[i];
    // Float32Array.prototype.sort — in-place, числовой сорт по дефолту,
    // без compare-функции и без аллокаций.
    const view = _frameTimeSort.subarray(0, _frameTimeCount);
    view.sort();
    return view[Math.min(_frameTimeCount - 1, Math.floor(_frameTimeCount * 0.95))];
  }
  let hitFlash = 0;
  let jumpBufferT = 0;
  let stuckT = 0;
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
  // Буферы для батчинга drawParticles по (цвет × alpha-бакет) — тот же
  // приём, что у sparkles. Без этого на rally каждая из до 80 живых
  // частиц ставила globalAlpha + fillStyle + beginPath + arc + fill =
  // state-flush GPU-батча на каждую. С бакетами — 1 fill на бакет.
  const _PART_BUCKETS = 4;
  const _PART_MAX_COLORS = 8;
  const _partAlphaIdx = new Int8Array(PARTICLE_CAP);
  const _partColorKey = new Int8Array(PARTICLE_CAP);
  const _partColors   = new Array(_PART_MAX_COLORS);
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
  // Счётчик подряд «хороших» кадров после деградации — для recovery.
  // Нужно достаточно длинное окно (~10 сек @ 60 FPS), чтобы не дёргать
  // настройки туда-сюда на временно успокоившемся GC-давлении.
  let goodFramesInLowQ = 0;
  // 1200 (~20 с при 60 FPS) вместо 600: на нестабильной машине (iGPU + GC
  // contention) 10 с чистых кадров подряд почти недостижимы, но recovery
  // периодически срабатывает на короткой «хорошей» серии и пересобирает
  // backdrop-sprite + переключает STEP_HI↔STEP_LO — каждый переход
  // порождает transient-хитч. Удвоенное окно гасит flip-flop, не меняя
  // поведение на реально восстановившемся железе.
  const LOWQ_RECOVERY_FRAMES = 1200;
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
  let lastHitSide = 0;                   // side (1/2) последнего касания

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
      // Web Animations API вместо class-toggle + `void offsetWidth` для
      // рестарта: старый приём форсировал синхронный reflow в критическом
      // игровом событии (очко = 1-2 раза за rally), что на слабом ПК
      // воровало 1-3 мс кадрового бюджета. el.animate() возвращает свежую
      // Animation каждый вызов, без reflow и без class-гонок.
      if(typeof pulseEl.animate === "function"){
        pulseEl.animate(
          [
            { transform: "scale(1)",    color: "var(--text, #fff)" },
            { transform: "scale(1.55)", color: "#ffd34a", offset: 0.35 },
            { transform: "scale(1)",    color: "var(--text, #fff)" }
          ],
          { duration: 450, easing: "ease" }
        );
      } else {
        // Фолбэк для старых браузеров: прежний reflow-трюк.
        pulseEl.classList.remove("pulse");
        void pulseEl.offsetWidth;
        pulseEl.classList.add("pulse");
      }
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
    // Первая подача создаёт ball со всеми render-полями. Последующие
    // мутируют in-place — убирает Object.assign-аллокацию на каждом голе.
    // DVPhysics.serveBall всё равно возвращает свежий литерал (он shared
    // с shadowsim на сервере, trivially переиспользовать нельзя), но мы
    // хотя бы не плодим второй объект-обёртку на клиенте.
    if(!ball){
      ball = {
        x: core.x, y: core.y,
        vx: core.vx, vy: core.vy,
        r: core.r, angle: core.angle,
        touches: { left: 0, right: 0 },
        prevX: core.x,  prevY: core.y,  prevAngle: 0,
        renderX: core.x, renderY: core.y, renderAngle: 0
      };
    } else {
      ball.x = core.x; ball.y = core.y;
      ball.vx = core.vx; ball.vy = core.vy;
      ball.r = core.r; ball.angle = core.angle;
      ball.touches.left = 0; ball.touches.right = 0;
      ball.prevX = core.x;  ball.prevY = core.y;  ball.prevAngle = 0;
      ball.renderX = core.x; ball.renderY = core.y; ball.renderAngle = 0;
    }
    trailHead = 0; trailCount = 0;
    hitFlash = 0;
    squash.ball = 0;
    rallyHits = 0;
    lastBallSide = (ball.x < NET_X) ? 1 : 2;
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
    hitFlash = 0;
    matchTime = 0;
    _stepsLastFrame = 0;
    _frameTimeHead = 0; _frameTimeCount = 0;
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
    // Новая сессия: свой matchId, seq=0. Если startBotMatch уже подложил
    // сессию (с matchId под ставки трофеев) — НЕ перезаписываем.
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
    resetMatch();
    ai = makeAI("medium", rng);
    last = Clock.now();
    acc = 0;
    cancelAnimationFrame(rafId);
    // Приглушаем параллельный rAF-тикер DecoAnim на время матча: анимация
    // украшений в HUD-аватарах не читается на фоне canvas-геймплея, а
    // лишний rAF-callback + DOM-write каждый кадр бьёт по слабым ПК.
    if(typeof DecoAnim !== "undefined" && DecoAnim.pause) DecoAnim.pause();
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
    if(typeof DecoAnim !== "undefined" && DecoAnim.resume) DecoAnim.resume();
  }

  function endMatch(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // Keep the simulation running in the background (ball/players coast on
    // inertia, backdrop keeps drifting). Only input is gated — see step().
    $("btn-replay").style.display = "";
    showEndOverlay(winnerSide, score1, score2);
    // Drop any keys the user was still holding so players don't keep accelerating.
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      Wallet.award("match.win", 50);
      reportMatchWin();
    }else{
      sfx.lose();
      reportMatchLoss();
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
    // 0.75 вместо 0.5: на пике скорости (MAX_BSPD=1300) travel ≈ 10.8 px при
    // STEP=1/120 → раньше было 2 sub-шага, теперь 1 (12.75 > 10.8). Tunneling
    // риск нулевой — 12.75 < ball.r=17, мяч не проскочит сетку/игрока.
    // При STEP_LO=1/60 (lowQuality) travel ≈ 21.7 → 2 sub-шага вместо 3.
    const maxPerSub = ball.r * 0.75;
    const subs = Math.max(1, Math.ceil(travel / maxPerSub));
    const subDt = dt / subs;
    for(let s = 0; s < subs; s++){
      ball.x += ball.vx * subDt;
      ball.y += ball.vy * subDt;
      ball.angle += ball.vx * subDt * 0.025;

      // Net-crossing reset. Любое пересечение центра сетки по X сбрасывает
      // счётчик касаний — так отскоки от стены чужой половины, возвращающие
      // мяч к тому же игроку, не накапливаются в фол.
      {
        const side = (ball.x < NET_X) ? 1 : 2;
        if(side !== lastBallSide){
          ball.touches.left = 0;
          ball.touches.right = 0;
          lastBallSide = side;
        }
      }

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

  // Pure-физика — в shared physics.js. Здесь — только application-state:
  // FX, счётчики touches, 4-touch rule, Wallet.award. rally.hit начисляется
  // только для p.side===1 (свой игрок).
  function collideBallPlayer(p){
    const ev = DVPhysics.collideBallPlayer(ball, p, GROUND_Y);
    if(!ev.hit) return;
    Fx.hit(p.side, ev.fxX, ev.fxY, ev.isSpike);
    rallyHits++;
    lastHitSide = p.side;
    Fx.combo(rallyHits);
    if(p.side === 1){
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
    // Монеты: +5 за выигранное очко (свой игрок = side 1).
    if(side === 1) Wallet.award("round.win", 5);
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
    // Инлайн-интерполяция вместо стрелочного замыкания: раньше `const lerp`
    // создавал 60 closure/сек в hot path, плюс 5 invocation'ов на render.
    p1.renderX = p1.prevX + (p1.x - p1.prevX) * a;
    p1.renderY = p1.prevY + (p1.y - p1.prevY) * a;
    p2.renderX = p2.prevX + (p2.x - p2.prevX) * a;
    p2.renderY = p2.prevY + (p2.y - p2.prevY) * a;
    if(ball){
      ball.renderX = ball.prevX + (ball.x - ball.prevX) * a;
      ball.renderY = ball.prevY + (ball.y - ball.prevY) * a;
      ball.renderAngle = ball.prevAngle + (ball.angle - ball.prevAngle) * a;
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
    // Облака — декоративный parallax. 10 штук × save/translate/rotate/
    // drawImage/restore. rotate() отключает HW-батчинг на каждое облако,
    // что ощутимо на iGPU. В lowQuality скипаем — поле и так читается.
    if(!lowQuality) drawClouds();
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
  // Батчим 40 точек в 6 bucket'ов по квантованной альфе: на каждый bucket —
  // один beginPath + arc×N + fill. До фикса было 40 отдельных state-change'ей
  // (alpha-set + beginPath + arc + fill) за кадр, что ломало GPU batching.
  const _SPARKLE_BUCKETS = 6;
  const _sparkleBucketA = new Float32Array(_SPARKLE_BUCKETS);
  const _sparkleIdx = new Int8Array(64);
  for(let i=0;i<_SPARKLE_BUCKETS;i++){
    _sparkleBucketA[i] = 0.08 + ((i + 0.5) / _SPARKLE_BUCKETS) * 0.18;
  }
  function drawSparkles(){
    if(!sparkles) return;
    const n = sparkles.length;
    if(n > _sparkleIdx.length) return;
    for(let i=0;i<n;i++){
      const s = sparkles[i];
      const tw = 0.5 + 0.5 * Math.sin(matchTime * s.freq + s.phase);
      let bi = (tw * _SPARKLE_BUCKETS)|0;
      if(bi < 0) bi = 0; else if(bi >= _SPARKLE_BUCKETS) bi = _SPARKLE_BUCKETS - 1;
      _sparkleIdx[i] = bi;
    }
    ctx.fillStyle = "#ffffff";
    for(let b=0; b<_SPARKLE_BUCKETS; b++){
      let started = false;
      for(let i=0;i<n;i++){
        if(_sparkleIdx[i] !== b) continue;
        const s = sparkles[i];
        if(!started){ ctx.globalAlpha = _sparkleBucketA[b]; ctx.beginPath(); started = true; }
        ctx.moveTo(s.x + s.r, s.y);
        ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
      }
      if(started) ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Soft Blurple halo behind the net, so it reads against the dark backdrop.
  // Запекаем radial-gradient в 360×360 sprite один раз и bl'итим drawImage:
  // fillRect+radial-gradient каждый кадр стоит 0.5–1 ms на ЦПУ-растеризации.
  let _netHaloSprite = null;
  // Flash-overlay для мяча при hit: прозрачный круг с жёлтым glow внутри.
  // Размер спрайта привязан к физическому радиусу — при ресайзе инвалидируем.
  let _ballFlashOverlay = null;
  let _ballFlashOverlayR = 0;
  function _getBallFlashOverlay(r){
    const side = Math.max(8, Math.ceil(r * 2));
    if(_ballFlashOverlay && _ballFlashOverlayR === side) return _ballFlashOverlay;
    _ballFlashOverlay = _makeOffscreen(side, side);
    const g = _ballFlashOverlay.getContext("2d");
    const cx = side * 0.5, cy = side * 0.5;
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, cx);
    rg.addColorStop(0,    "rgba(255,247,194,1)");
    rg.addColorStop(0.55, "rgba(255,230,130,0.55)");
    rg.addColorStop(1,    "rgba(255,200,80,0)");
    g.fillStyle = rg;
    g.beginPath(); g.arc(cx, cy, cx, 0, Math.PI*2); g.fill();
    _ballFlashOverlayR = side;
    return _ballFlashOverlay;
  }
  function drawNetHalo(){
    const cx = NET_X, cy = GROUND_Y - NET_H * 0.55;
    if(!_netHaloSprite){
      _netHaloSprite = _makeOffscreen(360, 360);
      const g = _netHaloSprite.getContext("2d");
      const rg = g.createRadialGradient(180, 180, 0, 180, 180, 180);
      rg.addColorStop(0, "rgba(88,101,242,0.22)");
      rg.addColorStop(1, "rgba(88,101,242,0)");
      g.fillStyle = rg;
      g.fillRect(0, 0, 360, 360);
    }
    ctx.drawImage(_netHaloSprite, cx - 180, cy - 180, 360, 360);
  }

  // Каждое облако — набор статичных векторных фигур. Один раз рендерим
  // в офскрин-спрайт. Tilt у каждого облака ФИКСИРОВАН (buildClouds выставляет
  // и не меняет), поэтому запекаем rotation прямо в спрайт — drawClouds
  // рисует голым drawImage без save/rotate/restore. На iGPU каждый ctx.rotate()
  // ломает GPU-батчинг drawImage, 10 облаков × rotate = 10 batch flush за кадр.
  function buildCloudSprite(c){
    const s = c.size;
    // Запас под поворот: после rotate диагональ ≈ side*√2. Tilt ≤ ±0.18 рад
    // → √2 с запасом, bounds гарантировано вмещаются.
    const side = Math.ceil(s * 2.4 * 1.45);
    const off = _makeOffscreen(side, side);
    const octx = off.getContext("2d");
    const cx = side / 2, cy = side / 2;
    // Bake rotation: translate→rotate→draw→restore, причём рисуем от (0,0)
    // а не от центра, потому что drawCloud* функции уже принимают центр.
    octx.save();
    octx.translate(cx, cy);
    octx.rotate(c.tilt);
    if(c.kind === "logo")      drawCloudLogo(octx, 0, 0, s, c.color);
    else if(c.kind === "icon") drawCloudIcon(octx, 0, 0, s, c.color, c.mark);
    else                       drawCloudBubble(octx, 0, 0, s, c.color);
    octx.restore();
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
    // Rotation запечена в спрайт (см. buildCloudSprite) — рисуем плоским
    // drawImage без save/rotate/restore. GPU-батчинг drawImage сохраняется,
    // что снимает 10 batch-flush'ей на кадр на iGPU.
    for(const c of clouds){
      if(!c._sprite) buildCloudSprite(c);
      const x = ((c.x + matchTime * c.speed) % (WORLD_W + 160)) - 80;
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(c._sprite, x - c._spriteHalf, c.y - c._spriteHalf);
    }
    ctx.globalAlpha = 1;
  }

  function drawNet(){
    const left = NET_X - NET_W*0.5, top = GROUND_Y - NET_H;
    // Posts (subtle gradient)
    ctx.fillStyle = netPostsGrad();
    ctx.fillRect(left, top + 4, NET_W, NET_H - 4);

    // Mesh texture — grid lines inside the post area. Один beginPath +
    // всё moveTo/lineTo + один stroke(): 14 линий раньше давали 14 раздельных
    // path-flush'ей на GPU за кадр.
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for(let y = top + 10; y < GROUND_Y - 2; y += 10){
      ctx.moveTo(left + 1, y);
      ctx.lineTo(left + NET_W - 1, y);
    }
    ctx.stroke();

    // Top band — Blurple cap
    ctx.fillStyle = "#5865f2";
    ctx.fillRect(left - 2, top - 5, NET_W + 4, 8);
    ctx.fillStyle = "#4752c4";
    ctx.fillRect(left - 2, top + 2, NET_W + 4, 2);
  }

  // Буферы для батчинга trail по alpha-бакету. До TRAIL_LEN точек, ≤8
  // итераций в drawTrail. Держим в замыкании, без аллокаций на вызов.
  const _TRAIL_BUCKETS = 4;
  const _trailX = new Float32Array(TRAIL_LEN);
  const _trailYb = new Float32Array(TRAIL_LEN);
  const _trailR = new Float32Array(TRAIL_LEN);
  const _trailB = new Int8Array(TRAIL_LEN);
  function drawTrail(){
    // Fade from oldest to newest; плавно гаснет по скорости, чтобы хвост не
    // обрубался одним кадром, когда мяч замедляется и точки схлопываются
    // обратно в тело мяча.
    const speed2 = ball.vx*ball.vx + ball.vy*ball.vy;
    const SPEED_HIDE = 180;
    const SPEED_FULL = 340;
    if(speed2 < SPEED_HIDE*SPEED_HIDE) return;
    if(trailCount < 3) return;
    const speed = Math.sqrt(speed2);
    // smoothstep для мягкого выхода (без линейного излома у краёв окна).
    let u = (speed - SPEED_HIDE) / (SPEED_FULL - SPEED_HIDE);
    if(u > 1) u = 1; else if(u < 0) u = 0;
    const speedFade = u*u*(3 - 2*u);
    // Ring buffer: trailHead — новейший, шаги назад = (head - i + TRAIL_LEN)%TRAIL_LEN.
    // Тело мяча — lerp(trail[1], trail[0]). Каждая точка смещается на alpha:
    // effective[i] = lerp(trail[i+1], trail[i]).
    const a = renderAlpha;
    const inv = 1 / TRAIL_LEN;
    // Проход 1: вычисляем x/y/r/bucket для всех точек.
    const n = trailCount - 2;
    for(let i = 1; i <= n; i++){
      const idx = i - 1;
      const cIdx = (trailHead - i + TRAIL_LEN) % TRAIL_LEN;
      const oIdx = (trailHead - (i+1) + TRAIL_LEN) % TRAIL_LEN;
      _trailX[idx]  = trailX[oIdx] + (trailX[cIdx] - trailX[oIdx]) * a;
      _trailYb[idx] = trailY[oIdx] + (trailY[cIdx] - trailY[oIdx]) * a;
      const t = i * inv;
      _trailR[idx] = ball.r * (1 - t*0.6) * (0.85 + 0.15*speedFade);
      const al = (1 - t) * 0.35 * speedFade;
      let bi = (al * _TRAIL_BUCKETS / 0.35)|0;
      if(bi < 0) bi = 0; else if(bi >= _TRAIL_BUCKETS) bi = _TRAIL_BUCKETS - 1;
      _trailB[idx] = bi;
    }
    // Проход 2: один beginPath+N*arc+fill на каждый bucket. Было до 8
    // отдельных fill() вызовов (GPU state-flush на каждом); стало ≤4.
    ctx.fillStyle = "#ffffff";
    for(let b = 0; b < _TRAIL_BUCKETS; b++){
      let started = false;
      for(let i = 0; i < n; i++){
        if(_trailB[i] !== b) continue;
        if(!started){
          // Средняя альфа бакета: (b+0.5) / _TRAIL_BUCKETS × 0.35_max.
          ctx.globalAlpha = ((b + 0.5) / _TRAIL_BUCKETS) * 0.35;
          ctx.beginPath();
          started = true;
        }
        const r = _trailR[i];
        ctx.moveTo(_trailX[i] + r, _trailYb[i]);
        ctx.arc(_trailX[i], _trailYb[i], r, 0, Math.PI*2);
      }
      if(started) ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles(){
    // Первый проход: для каждой живой частицы находим цветовой индекс (линейный
    // поиск по небольшому массиву — ≤8 уникальных цветов) и альфа-бакет.
    // Мёртвые/отгоревшие помечаются _partAlphaIdx=-1.
    let colorsN = 0;
    for(let i = 0; i < PARTICLE_CAP; i++){
      const pt = particles[i];
      if(pt.dead){ _partAlphaIdx[i] = -1; continue; }
      const k = 1 - pt.age/pt.life;
      if(k <= 0){ _partAlphaIdx[i] = -1; continue; }
      let bi = (k * _PART_BUCKETS) | 0;
      if(bi < 0) bi = 0; else if(bi >= _PART_BUCKETS) bi = _PART_BUCKETS - 1;
      _partAlphaIdx[i] = bi;
      let ci = -1;
      for(let c = 0; c < colorsN; c++){
        if(_partColors[c] === pt.color){ ci = c; break; }
      }
      if(ci < 0){
        if(colorsN >= _PART_MAX_COLORS){ _partAlphaIdx[i] = -1; continue; }
        ci = colorsN++;
        _partColors[ci] = pt.color;
      }
      _partColorKey[i] = ci;
    }
    // Второй проход: для каждой (color, bucket) пары — один beginPath + N arc + один fill.
    for(let c = 0; c < colorsN; c++){
      ctx.fillStyle = _partColors[c];
      for(let b = 0; b < _PART_BUCKETS; b++){
        let started = false;
        for(let i = 0; i < PARTICLE_CAP; i++){
          if(_partAlphaIdx[i] !== b || _partColorKey[i] !== c) continue;
          const pt = particles[i];
          if(!started){
            ctx.globalAlpha = (b + 0.5) / _PART_BUCKETS;
            ctx.beginPath();
            started = true;
          }
          const k = 1 - pt.age/pt.life;
          const r = pt.size * k;
          ctx.moveTo(pt.x + r, pt.y);
          ctx.arc(pt.x, pt.y, r, 0, Math.PI*2);
        }
        if(started) ctx.fill();
      }
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
  let _netPostsGrad = null,
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
  // LRU-кеп: ключ включает `?v=<updatedAt>`, поэтому при обновлении атласа
  // админом старая запись становится недоступной навсегда, но раньше висела
  // в Map + до 60 offscreen canvas. Игрок одновременно видит максимум 2-4
  // разных украшения (своё + оппонента + history), держим 6 — с запасом.
  const DECO_ATLAS_CACHE_MAX = 6;
  const decoAtlasCache = new Map();
  function getDecoAtlas(url){
    if(!url) return null;
    let entry = decoAtlasCache.get(url);
    if(entry){
      // Touch: переносим в конец Map — в Map.keys() порядок вставки.
      decoAtlasCache.delete(url);
      decoAtlasCache.set(url, entry);
      return entry;
    }
    if(decoAtlasCache.size >= DECO_ATLAS_CACHE_MAX){
      const oldestKey = decoAtlasCache.keys().next().value;
      decoAtlasCache.delete(oldestKey);
    }
    const img = new Image();
    img.decoding = "async";
    entry = { img, frames: null };
    img.src = url;
    decoAtlasCache.set(url, entry);
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

  // Фолбэк-юзер для рендера, когда state.user/state.bot временно null.
  // Без фолбэка drawPlayer кидал TypeError по .avatar_url на каждый кадр.
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
        }
        g.restore();
        // Освобождаем замыкание: иначе `img` держит g/c/size + сам себя
        // через handler'ы, а при частой смене ботов (replay) такие
        // orphan bitmap'ы висят в heap до major GC.
        img.onload = img.onerror = null;
      };
      img.onerror = ()=>{ img.onload = img.onerror = null; };
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
    // fillStyle+globalAlpha вместо "rgba(...," + a + ")" — убирает
    // 2 string-аллокации/кадр в hot path (2 игрока × 60 FPS = 120/сек
    // уникальных строк в GC). Тот же трюк уже в drawTrail.
    ctx.fillStyle = "#000000";
    ctx.globalAlpha = 0.32 - air*0.18;
    ctx.beginPath();
    ctx.ellipse(px, GROUND_Y - 1, r*0.95*sh, 6*sh, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.globalAlpha = 1;

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
        // Bake прозрачный градиентный overlay в sprite и blit через drawImage
        // (source-over) вместо `globalCompositeOperation="lighter"`: смена
        // композит-режима каждый кадр пока hitFlash>0 форсирует GPU batch flush
        // и давала классический микрофриз на миг после столкновения.
        const overlay = _getBallFlashOverlay(ball.r);
        if(overlay){
          const prevA = ctx.globalAlpha;
          ctx.globalAlpha = prevA * Math.min(0.55, hitFlash * 2.0);
          ctx.drawImage(overlay, -ball.r, -ball.r, ball.r*2, ball.r*2);
          ctx.globalAlpha = prevA;
        }
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
  // Layout-кеш: getBoundingClientRect на canvas+HUD внутри rAF-цикла даёт
  // forced reflow, если в том же кадре где-то был DOM-write (а HUD со счётом
  // как раз пишется textContent при каждом очке). Читаем rect'ы один раз
  // после resize/scroll — в стабильном кадре 0 layout-query.
  let _layoutDirty = true;
  let _cachedCanvasTop = 0;
  let _cachedPhysPerCss = 1;
  let _cachedHudBottomCss = 0;
  let _cachedHudValid = false;
  function _invalidateLayoutCache(){ _layoutDirty = true; }
  // Пробрасываем наружу IIFE: resizeCanvas() и ResizeObserver определены в
  // модульном scope и не видят локальный _invalidateLayoutCache.
  window.__dvInvalidateLayout = _invalidateLayoutCache;
  window.addEventListener("scroll", _invalidateLayoutCache, { passive: true });
  function _refreshLayoutCache(){
    const canvasRect = canvas.getBoundingClientRect();
    if(!canvasRect.width || !canvasRect.height) return false;
    _cachedCanvasTop  = canvasRect.top;
    _cachedPhysPerCss = canvas.width / canvasRect.width;
    if(_hudBarEl){
      const hr = _hudBarEl.getBoundingClientRect();
      _cachedHudBottomCss = hr.bottom;
      _cachedHudValid = true;
    } else {
      _cachedHudValid = false;
    }
    _layoutDirty = false;
    return true;
  }
  function drawBallOffscreenIndicator(){
    if(!ball) return;
    const offTop = -ball.renderY;
    if(offTop <= ball.r) return;
    const alpha = Math.min(1, (offTop - ball.r) / 24);
    if(alpha <= 0) return;

    if(_layoutDirty && !_refreshLayoutCache()) return;
    const physPerCss = _cachedPhysPerCss;

    // Нижний край HUD в канвас-физических пикселях + отступ. Fallback на
    // фикс. значение, если по какой-то причине HUD не нашёлся.
    const iy = _cachedHudValid
      ? (_cachedHudBottomCss - _cachedCanvasTop + 10) * physPerCss
      : 64 * physPerCss;

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
    // Дешёвая тень через смещённую залитую path вместо shadowBlur — последний
    // стоит 2–5 ms/кадр на HiDPI, пока стрелка на экране.
    const shadowOff = 2 * physPerCss;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.55 + shadowOff);
    ctx.lineTo(w * 0.5, h * 0.45 + shadowOff);
    ctx.lineTo(-w * 0.5, h * 0.45 + shadowOff);
    ctx.closePath();
    ctx.fill();
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
    // Кеп 4 вместо 6: на слабых ПК catch-up spiral самоусиливается
    // (фриз → долг acc → больше step() в следующем кадре → больше физики
    // и коллизий → новый фриз). Потолок в 4 шага достаточен для восстановления
    // после ~30 FPS-кадра при STEP=1/120, но не даёт спирали раскрутиться
    // до полного freeze. Лучше потерять немного точности под нагрузкой, чем
    // войти в 150+ мс jank.
    while(acc >= STEP && steps < 4){
      step(STEP);
      acc -= STEP;
      steps++;
    }
    if(steps === 4) acc = 0;
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
      // Ring-buffer, а не unbounded .push(): при `__dvProfile=true` старый
      // код рос линейно (3 массива × 60 записей/сек ≈ 11 тыс/мин), без
      // инвалидации в resetMatch — классический heap-leak. Кеп 600 ≈ 10 с
      // истории, достаточно для репрезентативной выборки.
      const PROF_CAP = 600;
      let prof = window.__dvProf;
      if(!prof) prof = window.__dvProf = { step: [], render: [], steps: [] };
      if(prof.step.length >= PROF_CAP) prof.step.shift();
      if(prof.render.length >= PROF_CAP) prof.render.shift();
      if(prof.steps.length >= PROF_CAP) prof.steps.shift();
      prof.step.push(t1 - t0);
      prof.render.push(t2 - t1);
      prof.steps.push(steps);
    }
    // Адаптивное качество: считаем EWMA времени кадра. Порог 22 мс ≈ 45 FPS
    // — ниже этого на десктопе включаем lowQuality и скидываем тяжёлые
    // фоновые слои. Нужно подряд несколько «плохих» кадров, чтобы не
    // реагировать на разовый GC-пик. В hidden-режиме не считаем — dt там
    // фиксированный 16мс от воркера и к реальному frame-time не относится.
    if(!document.hidden){
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
      // Порог 15 (было 40): при 25 FPS (40мс/кадр) старое окно ≈1.6 с
      // лагающего gameplay ДО деградации — достаточно, чтобы spiral of death
      // успел раскрутиться (STEP=1/120 копит acc, step() жирнеет, GC хуже).
      // 15 кадров ≈ 0.4 с — реагируем до лавины. Hitch-boost увеличен
      // симметрично: 3 хитча должны мгновенно переключать качество.
      const SLOW_LIMIT = 15;
      // Ранний детект слабого ПК: к 15-му кадру у нас уже есть осмысленный
      // EWMA. Если он сразу выше порога, не ждём 15 медленных подряд —
      // переключаемся сходу. Это ловит низкий baseline (Intel HD, старый
      // ноут), а не разовые хитчи при старте.
      const earlyProbeReady = _frameTimeCount === 15 && frameTimeAvg > avgSlow;
      if(!lowQuality){
        if(ft > hardFreeze){ lowQuality = true; }
        else if(earlyProbeReady){ lowQuality = true; }
        else if(ft > hitch){ slowFrames += 8; if(slowFrames > SLOW_LIMIT) lowQuality = true; }
        else if(frameTimeAvg > avgSlow){
          slowFrames++;
          if(slowFrames > SLOW_LIMIT) lowQuality = true;
        } else {
          slowFrames = Math.max(0, slowFrames - 1);
        }
        // Как только деградировали на десктопе — снижаем физ-рейт со 120 до
        // 60 Гц. Это убирает второй step-вызов на каждый кадр (коллизии/
        // integrate), давая кадровый бюджет обратно.
        if(lowQuality && !isTouch && STEP !== STEP_LO) _switchStep(STEP_LO);
        if(lowQuality) goodFramesInLowQ = 0;
      } else {
        // Recovery: после устойчивых «хороших» кадров поднимаем качество
        // обратно. Кадр считается хорошим, если и мгновенный ft, и EWMA
        // ниже порога deg'a с запасом. Хитч или medium-фрейм обнуляют
        // счётчик — recovery только по длинной чистой серии, иначе мы
        // запустили бы flip-flop на нестабильной машине.
        const goodMs = isTouch ? 26 : 18;
        if(ft < goodMs && frameTimeAvg < goodMs) goodFramesInLowQ++;
        else goodFramesInLowQ = 0;
        if(goodFramesInLowQ >= LOWQ_RECOVERY_FRAMES){
          lowQuality = false;
          slowFrames = 0;
          goodFramesInLowQ = 0;
          if(!isTouch && STEP !== STEP_HI) _switchStep(STEP_HI);
        }
      }
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
        // Race-guard: при visibilitychange → visible мы успеваем запустить
        // rAF-loop ДО того, как worker получит postMessage(0) и остановит
        // свой setInterval. В окне между этими событиями tick от worker'а
        // и rAF могли сработать в одном кадре — получался double step()
        // + double render. Проверкой rafId гарантируем: если rAF активен,
        // worker молчит.
        if(rafId) return;
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
  // в background — worker-таймер (rAF троттлится до 1 Гц). Таймеры воркера
  // не троттлятся — бот-матч продолжается при свёрнутой вкладке.
  document.addEventListener("visibilitychange", () => {
    if(document.hidden){
      if(rafId){ cancelAnimationFrame(rafId); rafId = 0; }
      if(state.inGame){
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
    const ws = (typeof state !== "undefined") ? state.ws : null;
    const wsState = ws ? ({0:"CONN", 1:"OPEN", 2:"CLOSING", 3:"CLOSED"})[ws.readyState] || "?" : "(none)";
    // performance.memory — только в Chrome/Edge. Null-безопасно.
    const mem = (typeof performance !== "undefined" && performance.memory)
      ? performance.memory.usedJSHeapSize / 1048576
      : null;
    return {
      mode: state.mode, inGame: state.inGame, matchOver: state.matchOver,
      p1: p1 ? { x: p1.x, y: p1.y, vx: p1.vx, vy: p1.vy, g: p1.onGround } : null,
      p2: p2 ? { x: p2.x, y: p2.y, vx: p2.vx, vy: p2.vy, g: p2.onGround } : null,
      ball: ball ? { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy } : null,
      score1, score2,
      // Perf-снимок: EWMA frame-time + p95 хвост, флаг деградации, current
      // STEP в Гц, slowFrames к lowQuality-порогу, сколько физ-шагов ушло
      // на прошлом кадре (6 = cap, post-hitch catchup). heapMB = JS-heap,
      // растущая кривая = утечка.
      frameTimeAvg, frameTimeP95: _frameTimeP95(),
      lowQuality, slowFrames, stepHz: Math.round(1 / STEP),
      stepsLastFrame: _stepsLastFrame,
      heapMB: mem,
      wsState,
      ballSpeed: ball ? Math.hypot(ball.vx, ball.vy) : 0
    };
  }
  return { start, stop, refreshOverlay, triggerEmote,_debug };
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
    const lines = [
      "mode: " + (d.mode || "—") + (d.inGame ? " (in-game)" : "") + (d.matchOver ? " END" : "") + (d.lowQuality ? " LQ" : ""),
      "fps:  " + fmt(fps, 0) + "   ft avg/p95: " + fmt(d.frameTimeAvg) + "/" + (d.frameTimeP95 != null ? fmt(d.frameTimeP95) : "—") + "ms",
      "step: " + d.stepHz + "Hz   steps/f: " + d.stepsLastFrame + (d.stepsLastFrame >= 6 ? "!" : "") + "   slow: " + d.slowFrames,
      "heap: " + (d.heapMB != null ? fmt(d.heapMB, 0) + "MB" : "—") + "   score: " + d.score1 + ":" + d.score2,
      "ws: " + d.wsState,
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

  // Reused output object — decide() вызывается 60–120 раз/сек и свежий литерал
  // на каждый тик создаёт заметное GC-давление (особенно в bot-mode, где это
  // единственный per-tick allocator).
  const out = { left:false, right:false, jump:false };

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

      out.left = false; out.right = false; out.jump = false;
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
