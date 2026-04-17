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
  opponent: null,
  // mode: 'bot' (SP vs AI) | 'host' (authoritative online left player)
  //     | 'guest' (online right player, driven by host snapshots)
  mode: "bot",
  ws: null,
  peerKeys: { left:false, right:false, jump:false },
  targetScore: 10,
  inGame: false,
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
  if(u){
    state.user = u;
    // Стартовый баланс приходит с сервера — кошелёк серверно-авторитетный.
    if(typeof u.coins === "number") Wallet.set(u.coins, 0);
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
  refreshOnlineCount();
  refreshLeaderboard();
  // Держим WS открытым с момента входа в меню: счётчик онлайна считает
  // именно подключённых юзеров (не тех, кто в матчмейкинге), а кошелёк
  // получает серверные апдейты балланса пушем.
  ensureMenuSocket();
}

// Один постоянный сокет на сессию. Переиспользуем его для matchmaking,
// онлайн-счётчика и пушей кошелька. Закрываем только на logout/выгрузке.
async function ensureMenuSocket(){
  if(state.ws && state.ws.readyState === 1) return state.ws;
  if(state.ws && state.ws.readyState === 0){
    // Уже идёт handshake — подождём его завершения (race между вкладками).
    return new Promise((res)=>{
      const ws = state.ws;
      const done = ()=> res(ws.readyState === 1 ? ws : null);
      ws.addEventListener("open",  done, { once: true });
      ws.addEventListener("error", done, { once: true });
    });
  }
  const ws = await openSocket();
  if(!ws) return null;
  state.ws = ws;
  attachSocketHandlers(ws);
  return ws;
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

const lbListEl  = $("lb-list");
const lbEmptyEl = $("lb-empty");
const lbMeEl    = $("lb-me");
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
  const winsEl = document.createElement("span");
  winsEl.className = "lb-wins";
  winsEl.textContent = String(entry.wins || 0);
  const suffixEl = document.createElement("span");
  suffixEl.className = "suffix";
  suffixEl.textContent = I18n.t("lb.wins_suffix");
  winsEl.appendChild(suffixEl);

  li.appendChild(rankEl);
  li.appendChild(avatarEl);
  li.appendChild(nameEl);
  li.appendChild(winsEl);
  return li;
}
async function refreshLeaderboard(){
  if(!lbListEl) return;
  try {
    const r = await fetch("/api/leaderboard", { credentials: "same-origin", cache: "no-store" });
    if(!r.ok) return;
    const j = await r.json();
    const top = Array.isArray(j.top) ? j.top : [];
    const meId = state.user && state.user.id;

    lbListEl.innerHTML = "";
    for(let i = 0; i < top.length; i++){
      lbListEl.appendChild(renderLbRow(top[i], i + 1, meId));
    }
    if(lbEmptyEl) lbEmptyEl.style.display = top.length === 0 ? "" : "none";

    if(lbMeEl){
      if(j.me && j.me.rank && j.me.wins > 0){
        lbMeEl.textContent = fmtI18n("lb.me_rank", { rank: j.me.rank, wins: j.me.wins });
        lbMeEl.classList.toggle("me-topped", j.me.rank <= 3);
      }else{
        lbMeEl.textContent = I18n.t("lb.me_empty");
        lbMeEl.classList.remove("me-topped");
      }
    }
  } catch(_){}
}

/* ---------------- Matchmaking ----------------
   Клик по «ИГРАТЬ» запускает поиск: открываем WebSocket, встаём в очередь,
   показываем лобби с обратным отсчётом. Если в течение QUEUE_TIMEOUT_MS
   никто не подключился — сервер пришлёт queue_timeout, и мы откатимся в
   матч против бота. По кнопке «Отмена» — закрываем сокет и уходим обратно
   в меню (в отличие от таймаута). */

const lobbyOverlay   = $("lobby-overlay");
const lobbyCountdown = $("lobby-countdown");
const lobbyTitle     = $("lobby-title");
const lobbySub       = $("lobby-sub");
const QUEUE_COUNTDOWN_MS = 3000;

let lobbyTickTimer = 0;
let lobbyCountdownStart = 0;
function startLobbyCountdown(){
  lobbyCountdownStart = performance.now();
  updateLobbyCountdown();
  if(lobbyTickTimer) clearInterval(lobbyTickTimer);
  lobbyTickTimer = setInterval(updateLobbyCountdown, 100);
}
function stopLobbyCountdown(){
  if(lobbyTickTimer){ clearInterval(lobbyTickTimer); lobbyTickTimer = 0; }
}
function updateLobbyCountdown(){
  const elapsed = performance.now() - lobbyCountdownStart;
  const left = Math.max(0, QUEUE_COUNTDOWN_MS - elapsed);
  lobbyCountdown.textContent = String(Math.ceil(left / 1000));
}

function showLobby(){
  lobbyTitle.textContent = I18n.t("lobby.searching");
  lobbySub.textContent   = I18n.t("lobby.fallback_hint");
  lobbyOverlay.classList.remove("hidden");
  startLobbyCountdown();
}
function hideLobby(){
  lobbyOverlay.classList.add("hidden");
  stopLobbyCountdown();
}

function openSocket(){
  return new Promise((resolve) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try { ws = new WebSocket(proto + "//" + location.host + "/ws"); }
    catch(_){ resolve(null); return; }
    let settled = false;
    const done = (val) => { if(!settled){ settled = true; resolve(val); } };
    ws.addEventListener("open",  ()=> done(ws));
    ws.addEventListener("error", ()=> done(null));
    // Подстраховка: если open не стрельнул за пару секунд — считаем,
    // что коннекта нет, и откатываемся к боту.
    setTimeout(()=> done(null), 2500);
  });
}

function attachSocketHandlers(ws){
  ws.addEventListener("message", (ev)=>{
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if(!msg || typeof msg.type !== "string") return;
    onServerMessage(msg);
  });
  ws.addEventListener("close", ()=>{
    // Если мы уже в матче — считаем это как уход соперника.
    if(state.inGame && state.mode !== "bot"){
      onPeerLeft("disconnect");
    }else{
      hideLobby();
    }
    if(state.ws === ws) state.ws = null;
  });
}

function onServerMessage(msg){
  switch(msg.type){
    case "hello":
      if(typeof msg.online === "number") setOnlineCount(msg.online);
      if(typeof msg.coins  === "number") Wallet.set(msg.coins, 0);
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
    case "matched":
      startOnlineMatch(msg.role, msg.opponent);
      break;
    case "queue_timeout":
      hideLobby();
      startBotMatch();
      break;
    case "peer":
      onPeerPayload(msg.payload);
      break;
    case "peer_left":
      onPeerLeft(msg.reason || "disconnect");
      break;
  }
}

function onPeerPayload(p){
  if(!p || typeof p.kind !== "string") return;
  if(p.kind === "input" && state.mode === "host"){
    state.peerKeys.left  = !!p.left;
    state.peerKeys.right = !!p.right;
    state.peerKeys.jump  = !!p.jump;
  }else if(p.kind === "state" && state.mode === "guest"){
    Game.applySnapshot(p);
  }else if(p.kind === "emote"){
    // Эмоция от оппонента. И у хоста, и у гостя оппонент стоит справа (p2)
    // — гостевая сторона зеркалирует снапшот, так что своя половина всегда p1.
    Game.triggerEmote(2, p.id);
  }
}

function onPeerLeft(reason){
  if(state.mode === "bot") return;
  // Если матч идёт — засчитываем форфейт: оставшийся игрок получает победу
  // (+50 монет) и видит обычный оверлей окончания матча. Сокет закрываем,
  // mode переключаем в "bot" — чтобы кнопка «В меню» на оверлее не пыталась
  // слать peer-сообщения обратно серверу.
  if(state.inGame && !state.matchOver){
    // Репортим свою форфейт-победу в лидерборд.
    try {
      state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify({ type: "match_win" }));
    } catch(_){}
    Game.endByForfeit();
    // Сокет НЕ закрываем: держим его постоянно открытым от меню до logout,
    // чтобы онлайн-счётчик и пуши кошелька работали между матчами.
    state.mode = "bot";
    state.opponent = null;
    return;
  }
  // Матч ещё не начат или уже завершён — просто возвращаем в меню.
  Game.stop();
  state.mode = "bot";
  state.opponent = null;
  show("menu");
  // Лёгкое уведомление поверх меню через тот же лобби-оверлей.
  lobbyTitle.textContent = I18n.t("lobby.disconnected");
  lobbySub.textContent   = "";
  lobbyCountdown.textContent = "×";
  lobbyOverlay.classList.remove("hidden");
  setTimeout(()=> lobbyOverlay.classList.add("hidden"), 1500);
}

function closeSocket(){
  const ws = state.ws;
  state.ws = null;
  if(!ws) return;
  try { ws.close(); } catch(_){}
}

function startBotMatch(){
  state.mode = "bot";
  state.opponent = null;
  state.bot = Auth.makeBot();
  $("hud-score-p1").textContent = "0";
  $("hud-score-p2").textContent = "0";
  refreshLocalizedDynamicUI();
  show("game");
  resizeCanvas();
  Game.start();
}

function startOnlineMatch(role, opponent){
  hideLobby();
  state.mode = role; // 'host' | 'guest'
  // Нормализуем пришедшего с сервера пользователя — добиваем color по id,
  // чтобы fallback-круг оппонента был стабильно окрашен, а не серо-дефолтным.
  state.opponent = Auth.normalize(opponent) || opponent;
  state.bot = null;
  state.peerKeys.left = state.peerKeys.right = state.peerKeys.jump = false;
  // Важно: модульный _relayLastMask сохраняется между матчами. Если гость
  // играл прошлый матч и у него в конце была зажата, например, стрелка
  // (или просто mask оказался 0), в новом матче первое нажатие с тем же
  // mask-значением не отправится из-за дедупа — и гость не двигается.
  // Форсим «ни разу не отправляли» состояние.
  _relayLastMask = -1;
  $("hud-score-p1").textContent = "0";
  $("hud-score-p2").textContent = "0";
  refreshLocalizedDynamicUI();
  show("game");
  resizeCanvas();
  Game.start();
}

async function startMatchmaking(){
  showLobby();
  // Переиспользуем постоянный сокет из меню. Если его ещё нет (boot не успел
  // или сеть упала) — пытаемся открыть; при неудаче откатываемся к боту.
  const ws = await ensureMenuSocket();
  if(!ws){
    hideLobby();
    startBotMatch();
    return;
  }
  try { ws.send(JSON.stringify({ type: "queue" })); } catch(_){}
}

$("btn-play").addEventListener("click", startMatchmaking);

$("btn-lobby-cancel").addEventListener("click", ()=>{
  hideLobby();
  if(state.ws){
    try { state.ws.send(JSON.stringify({ type: "cancel" })); } catch(_){}
  }
  // Сокет держим открытым — он общий для матчмейкинга, онлайн-счётчика и кошелька.
});

/* ---------------- Canvas sizing ---------------- */
const WORLD_W = 1000, WORLD_H = 500;
let scale = 1, offsetX = 0, offsetY = 0;

// Кап DPR: на 3x-Retina (iPhone) честный рендер в 3× увеличивает площадь
// пикселей в 9 раз по сравнению с 1× — это ощутимо бьёт по мобильным
// iGPU. На десктопе допускаем 2×, на тач-устройствах жёстче — 1.25×,
// т.к. мобильный GPU под радиальными градиентами/частицами захлёбывается
// при честных 1080×2400 пикселях на физтик.
const DPR_CAP_DESKTOP = 2;
const DPR_CAP_TOUCH   = 1.25;
function resizeCanvas(){
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

// Гость шлёт своё состояние клавиш хосту. Отправляем немедленно при каждом
// изменении (keydown/keyup/touch/blur) + фоновый heartbeat на 30 Гц как
// страховка на случай, если где-то изменение keys произошло вне наших хуков.
// Сетевые пакеты уходят только когда маска (left|right|jump) поменялась.
let _relayLastMask = -1;
function relayInputIfGuest(){
  if(state.mode !== "guest") return;
  if(!state.ws || state.ws.readyState !== 1) return;
  const mask = (keys.left?1:0) | (keys.right?2:0) | (keys.jump?4:0);
  if(mask === _relayLastMask) return;
  _relayLastMask = mask;
  try {
    // На гостe картинка зеркалирована: он видит себя слева, но в мировых
    // координатах хоста он — правый игрок. Левая стрелка гостя = движение p2
    // вправо у хоста, поэтому при отправке меняем left↔right.
    state.ws.send(JSON.stringify({
      type: "relay",
      payload: { kind:"input", left: keys.right, right: keys.left, jump: keys.jump }
    }));
  } catch(_){}
}
setInterval(relayInputIfGuest, 33);

/* ---------------- Pause & overlay ---------------- */
const overlay = $("overlay");
const overlayTitle = $("overlay-title");
const overlaySub = $("overlay-sub");
$("btn-replay").addEventListener("click", ()=> Game.start());
function quitToMenu(){
  // Если мы в онлайне — корректно уведомим сервер через {type:"leave"},
  // чтобы соперник увидел peer_left сразу. Сокет НЕ закрываем — это общий
  // сокет для online-счётчика и серверного кошелька, он живёт всю сессию.
  if(state.mode !== "bot" && state.ws){
    try { state.ws.send(JSON.stringify({ type: "leave" })); } catch(_){}
  }
  state.mode = "bot";
  state.opponent = null;
  Game.stop();
  show("menu");
  // На случай, если за матч изменился счёт побед — перерисовать топ сразу.
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
  if(state.ws && state.ws.readyState === 1 && state.mode !== "bot"){
    try {
      state.ws.send(JSON.stringify({ type:"relay", payload:{ kind:"emote", id: btn.dataset.emoteId } }));
    } catch(_){}
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
  // Аккумулятор для 30 Гц-снапшота хоста. Раздельно от физического acc,
  // чтобы сеть не зависела от частоты рендера.
  let snapAcc = 0;
  const SNAP_STEP = 1/30;
  let hitFlash = 0;
  let prevJump1 = false;
  let jumpBufferT = 0;
  let stuckT = 0;

  // --- Production polish state ---
  const particles = [];                  // hit spark particles
  const trail = [];                      // ball position trail (newest first)
  const TRAIL_LEN = 10;
  const PARTICLE_CAP = 160;
  // alpha последнего render() — нужен drawTrail, чтобы «хвост» смещался
  // синхронно с телом мяча (иначе между физ-тиками точки трейла отстают).
  let renderAlpha = 1;
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
  let lastHitSide = 0;                   // side (1/2) последнего касания — для гостевых наград
  let prevSnapRallyHits = 0;             // на клиенте-госте: последний отрисованный счётчик касаний

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
    const bx = serverX + offset;
    ball = {
      x: bx,
      y: SERVE_SPAWN_Y,
      vx: 0, vy: 0,
      r: BALL_R,
      angle: 0,
      touches: { left:0, right:0 },
      prevX: bx, prevY: SERVE_SPAWN_Y, prevAngle: 0,
      renderX: bx, renderY: SERVE_SPAWN_Y, renderAngle: 0
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
    lastHitSide = 0;
    prevSnapRallyHits = 0;
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
    overlay.classList.add("hidden");
  }

  function endMatch(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // Keep the simulation running in the background (ball/players coast on
    // inertia, backdrop keeps drifting). Only input is gated — see step().
    overlayTitle.textContent = I18n.t(winnerSide===1 ? "game.victory" : "game.defeat");
    const name = winnerSide===1 ? ($("hud-name-p1").textContent) : ($("hud-name-p2").textContent);
    overlaySub.textContent = name + " — " + score1 + " : " + score2;
    // В онлайне повтор без пары невозможен — скрываем «Играть заново».
    $("btn-replay").style.display = state.mode === "bot" ? "" : "none";
    overlay.classList.remove("hidden");
    // Drop any keys the user was still holding so players don't keep accelerating.
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      // Приз за матч: в bot/host — своему игроку (p1), в guest матч-монеты
      // ставит endMatchAsSnapshot после зеркалирования.
      if(state.mode === "bot" || state.mode === "host"){
        Wallet.award("match.win", 50);
        try {
          state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify({ type: "match_win" }));
        } catch(_){}
      }
    }else{
      sfx.lose();
    }
    // Хост отправляет финальный снапшот, чтобы гость корректно закрыл матч.
    if(state.mode === "host"){
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

    // В роли гостя физика авторитетна у хоста — мы получаем её снапшотами
    // и рендерим; локально только визуальные тики (частицы/эмоции/трейл) выше.
    // Важно выйти ДО post-point countdown: иначе guest со своим roundTimer=0
    // каждый кадр, пока хост показывает ro=1, вызывал spawnPlayers()/serveBall()
    // и тем самым «телепортировал» фигурки обратно в спауны — визуально
    // выглядело как «игрок не двигается».
    if(state.mode === "guest"){
      return;
    }

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

    // Хост рассылает снапшот на 30 Гц. Физика у нас STEP=1/120, так что
    // в среднем один снапшот на 4 физтика, но считаем в аккумуляторе.
    if(state.mode === "host"){
      snapAcc += dt;
      if(snapAcc >= SNAP_STEP){
        snapAcc = 0;
        broadcastSnapshot();
      }
    }
  }

  function broadcastSnapshot(){
    const ws = state.ws;
    if(!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        type: "relay",
        payload: {
          kind: "state",
          p1: { x:p1.x, y:p1.y, vx:p1.vx, vy:p1.vy, g:p1.onGround?1:0 },
          p2: { x:p2.x, y:p2.y, vx:p2.vx, vy:p2.vy, g:p2.onGround?1:0 },
          b:  { x:ball.x, y:ball.y, vx:ball.vx, vy:ball.vy, a:ball.angle },
          s1: score1, s2: score2,
          mo: state.matchOver ? 1 : 0,
          w:  lastWinnerSide,
          ss: servingSide,
          ro: roundOver ? 1 : 0,
          rh: rallyHits,
          lh: lastHitSide
        }
      }));
    } catch(_){}
  }

  function applySnapshot(s){
    if(state.mode !== "guest" || !p1 || !p2 || !ball) return;
    // Зеркалим по X, чтобы гость видел себя слева. В мировых координатах
    // хоста гость — p2 (справа), поэтому p1 у нас собираем из s.p2 с
    // отражением x и vx, а p2 — из s.p1. Счёт и сторону подачи тоже
    // меняем местами, иначе при первой подаче мяч уедет не туда.
    p1.x = WORLD_W - s.p2.x; p1.y = s.p2.y; p1.vx = -s.p2.vx; p1.vy = s.p2.vy; p1.onGround = !!s.p2.g;
    p2.x = WORLD_W - s.p1.x; p2.y = s.p1.y; p2.vx = -s.p1.vx; p2.vy = s.p1.vy; p2.onGround = !!s.p1.g;
    ball.x = WORLD_W - s.b.x; ball.y = s.b.y;
    ball.vx = -s.b.vx; ball.vy = s.b.vy; ball.angle = -s.b.a;
    // Снапшот — телепорт к авторитетной позиции. Подтягиваем prev к curr,
    // иначе интерполятор между кадрами нарисовал бы «резиновый» полёт от
    // старой позиции к новой.
    p1.prevX = p1.x; p1.prevY = p1.y;
    p2.prevX = p2.x; p2.prevY = p2.y;
    ball.prevX = ball.x; ball.prevY = ball.y; ball.prevAngle = ball.angle;
    servingSide = s.ss === 1 ? 2 : 1;
    roundOver = !!s.ro;
    const incomingRh = s.rh || 0;
    // Гостевые награды за касания мяча. В мировых координатах хоста
    // гость — p2 (lh===2). Счётчик rh у хоста только растёт в пределах
    // раунда и сбрасывается в 0 на очко; зеркалим это, смотрим прирост.
    if(incomingRh > prevSnapRallyHits && s.lh === 2){
      const deltaHits = incomingRh - prevSnapRallyHits;
      for(let i = 0; i < deltaHits; i++){
        Wallet.award("rally.hit", 1);
        const combo = prevSnapRallyHits + i + 1;
        if(combo > 0 && combo % 5 === 0) Wallet.award("rally.combo", combo);
      }
    }
    prevSnapRallyHits = incomingRh;
    rallyHits = incomingRh;
    const newS1 = s.s2, newS2 = s.s1;
    if(newS1 !== score1 || newS2 !== score2){
      const wasP1 = score1, wasP2 = score2;
      score1 = newS1; score2 = newS2;
      const elA = $("hud-score-p1"), elB = $("hud-score-p2");
      elA.textContent = String(score1); elB.textContent = String(score2);
      const pulseEl = (score1 > wasP1) ? elA : (score2 > wasP2) ? elB : null;
      if(pulseEl){
        pulseEl.classList.remove("pulse");
        void pulseEl.offsetWidth;
        pulseEl.classList.add("pulse");
      }
      // Очко гостя = рост score1 (его собственной половины в зеркалке).
      if(score1 > wasP1) Wallet.award("round.win", 5);
    }
    if(s.mo && !state.matchOver){
      // winnerSide тоже зеркалим: если хост выиграл (s.w===1),
      // у гостя это сторона 2 (справа, соперник).
      endMatchAsSnapshot(s.w === 1 ? 2 : 1);
    }
  }

  function endMatchAsSnapshot(winnerSide){
    state.matchOver = true;
    lastWinnerSide = winnerSide;
    // После зеркалирования снапшота гость тоже видит «себя» как сторону 1.
    overlayTitle.textContent = I18n.t(winnerSide === 1 ? "game.victory" : "game.defeat");
    const name = winnerSide === 1 ? ($("hud-name-p1").textContent) : ($("hud-name-p2").textContent);
    overlaySub.textContent = name + " — " + score1 + " : " + score2;
    // В онлайне «Играть заново» без пары бессмысленно — выходим в меню.
    $("btn-replay").style.display = "none";
    overlay.classList.remove("hidden");
    keys.left = keys.right = keys.jump = false;
    if(winnerSide === 1){
      sfx.win();
      // В зеркалке гостя side 1 — это его «я», так что матч-приз его.
      Wallet.award("match.win", 50);
      // Гость репортит в лидерборд только свои победы.
      try {
        state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify({ type: "match_win" }));
      } catch(_){}
    }else{
      sfx.lose();
    }
  }

  // Соперник вышел из матча — засчитываем форфейт, победа «нашей» стороне (p1)
  // c призом, как за честную победу. Вызывается из onPeerLeft при активном
  // матче. Если матч уже завершён — просто ничего не делаем.
  function endByForfeit(){
    if(!state.inGame || state.matchOver) return;
    state.matchOver = true;
    lastWinnerSide = 1;
    overlayTitle.textContent = I18n.t("game.victory");
    overlaySub.textContent = I18n.t("game.opponent_left");
    $("btn-replay").style.display = "none";
    overlay.classList.remove("hidden");
    keys.left = keys.right = keys.jump = false;
    sfx.win();
    Wallet.award("match.win", 50);
    try {
      state.ws && state.ws.readyState === 1 && state.ws.send(JSON.stringify({ type: "match_win" }));
    } catch(_){}
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
    lastHitSide = p.side;
    // Монеты за касания своего игрока. В bot/host свой игрок — p.side===1;
    // у гостя физика не крутится локально, поэтому его награда приезжает
    // через applySnapshot (lastHitSide=2 у хоста — это как раз гость).
    const isOwnHit = (p.side === 1) && (state.mode === "bot" || state.mode === "host");
    if(isOwnHit) Wallet.award("rally.hit", 1);
    if(rallyHits > 0 && rallyHits % 5 === 0){
      showBig("x" + rallyHits, "#ffd34a", 0.6, 52);
      if(isOwnHit) Wallet.award("rally.combo", rallyHits);
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
    drawPlayer(p1, playerUser(1));
    drawPlayer(p2, playerUser(2));
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
    // trail[i] — snapshot i физ-шагов назад. Тело мяча рисуется в
    // lerp(trail[1], trail[0], renderAlpha). Чтобы хвост не отставал, каждую
    // точку тоже сдвигаем: эффективная позиция i-й точки — lerp(trail[i+1], trail[i]).
    const a = renderAlpha;
    for(let i = 1; i < trail.length - 1; i++){
      const cur = trail[i], old = trail[i+1];
      const x = old.x + (cur.x - old.x) * a;
      const y = old.y + (cur.y - old.y) * a;
      const alpha = (1 - i/trail.length) * 0.35;
      const r = ball.r * (1 - i/trail.length*0.6);
      ctx.fillStyle = "rgba(255,255,255," + alpha + ")";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
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
    for(const e of emotes) drawEmote(e);
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
    // alpha ∈ [0,1] — доля незакоммиченного физ-времени между последним
    // и следующим шагом. Передаём в render(), чтобы при рендер-частоте
    // выше физ-частоты (120/144/240 Гц) позиции между тиками интерполировались,
    // а не «дёргались».
    const alpha = Math.min(1, Math.max(0, acc / STEP));
    render(alpha);
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
    }
  }

  return { start, stop, refreshOverlay, triggerEmote, applySnapshot, endByForfeit };
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
