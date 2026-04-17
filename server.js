/* Discord OAuth2 + static frontend server.
   Логика максимально простая:
     GET  /auth/discord   — редирект на Discord с state-cookie
     GET  /auth/callback  — exchange code, сохраняем подписанную session-cookie
     GET  /api/me         — возвращает профиль или 401
     POST /auth/logout    — чистит session-cookie
   Client-secret хранится только на сервере (в Railway → Variables). */

"use strict";

// Мини-.env для локалки. В проде (NODE_ENV=production на Railway) пропускаем,
// Railway инжектит переменные сам.
if (process.env.NODE_ENV !== "production") {
  try {
    const fs = require("fs");
    for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (_) { /* .env отсутствует — ок */ }
}

const express      = require("express");
const cookieParser = require("cookie-parser");
const crypto       = require("crypto");
const path         = require("path");
const fs           = require("fs");
const http         = require("http");
const { WebSocketServer } = require("ws");

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  SESSION_SECRET,
  PUBLIC_URL,
  PORT = 8080,
  NODE_ENV = "development"
} = process.env;

function must(name, val){
  if (!val) {
    console.error(`[fatal] env ${name} is required`);
    process.exit(1);
  }
  return val;
}
must("DISCORD_CLIENT_ID",     DISCORD_CLIENT_ID);
must("DISCORD_CLIENT_SECRET", DISCORD_CLIENT_SECRET);
must("SESSION_SECRET",        SESSION_SECRET);

const APP_URL      = (PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const REDIRECT_URI = `${APP_URL}/auth/callback`;
const IS_HTTPS     = APP_URL.startsWith("https://");

// Build-ID для cache-busting статики. Railway сам подставляет git SHA
// деплоя в RAILWAY_GIT_COMMIT_SHA; локально — случайный короткий хэш
// на каждый запуск (перезапустил node — новый билд, браузер подхватит).
const BUILD_ID =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_DEPLOYMENT_ID ||
  crypto.randomBytes(6).toString("hex");

// Читаем index.html один раз, проставляем ?v=<build> на локальные ассеты и
// инлайним build-id в window.__BUILD__, чтобы фронт знал «свою» версию.
const INDEX_HTML = (function(){
  let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  html = html.replace(
    /(href|src)="(styles\.css|auth\.js|game\.js|i18n\.js)"/g,
    (_m, attr, file) => `${attr}="${file}?v=${BUILD_ID}"`
  );
  const tag = `<script>window.__BUILD__=${JSON.stringify(BUILD_ID)};</script>`;
  html = html.replace("</head>", `  ${tag}\n</head>`);
  return html;
})();

const SESSION_COOKIE   = "dv_session";
const STATE_COOKIE     = "dv_state";
const SESSION_MAX_AGE  = 7 * 24 * 3600 * 1000; // 7 дней
const STATE_MAX_AGE    = 10 * 60 * 1000;       // 10 минут

const app = express();
app.disable("x-powered-by");
// Railway терминирует TLS перед нами; без trust proxy secure-cookie не ставится.
app.set("trust proxy", 1);
app.use(cookieParser(SESSION_SECRET));

const baseCookieOpts = {
  signed:   true,
  httpOnly: true,
  secure:   IS_HTTPS,     // на localhost secure=false, иначе браузер не сохранит
  sameSite: "lax",        // OAuth-редирект — GET, lax проходит
  path:     "/"
};
const sessionCookieOpts = { ...baseCookieOpts, maxAge: SESSION_MAX_AGE };
const stateCookieOpts   = { ...baseCookieOpts, maxAge: STATE_MAX_AGE };

function getSession(req){
  const v = req.signedCookies[SESSION_COOKIE];
  if (!v) return null;
  try {
    const u = JSON.parse(v);
    if (!u || !u.id) return null;
    return u;
  } catch { return null; }
}

function cdnAvatar(id, hash){
  if (!hash) return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=128`;
}

/* ---------- OAuth routes ---------- */

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, stateCookieOpts);

  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id",     DISCORD_CLIENT_ID);
  u.searchParams.set("redirect_uri",  REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope",         "identify");
  u.searchParams.set("state",         state);
  res.redirect(u.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const saved = req.signedCookies[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/" });

  if (error) {
    return res.redirect("/?auth_error=" + encodeURIComponent(String(error)));
  }
  if (!code || !state || !saved || state !== saved) {
    return res.redirect("/?auth_error=state_mismatch");
  }

  try {
    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code:          String(code),
        redirect_uri:  REDIRECT_URI
      })
    });
    if (!tokenResp.ok) {
      throw new Error("token exchange failed: " + tokenResp.status);
    }
    const tok = await tokenResp.json();

    const meResp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    if (!meResp.ok) throw new Error("users/@me failed: " + meResp.status);
    const me = await meResp.json();

    const user = {
      id:          me.id,
      username:    me.username,
      global_name: me.global_name || me.username,
      avatar_url:  cdnAvatar(me.id, me.avatar),
      iat:         Date.now()
    };
    res.cookie(SESSION_COOKIE, JSON.stringify(user), sessionCookieOpts);
    res.redirect("/");
  } catch (e) {
    console.error("[auth] callback error:", e);
    res.redirect("/?auth_error=exchange_failed");
  }
});

app.get("/api/me", (req, res) => {
  const u = getSession(req);
  if (!u) return res.status(401).json(null);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    id:          u.id,
    username:    u.username,
    global_name: u.global_name,
    avatar_url:  u.avatar_url,
    coins:       userCoins(u.id),
    trophies:    userTrophies(u.id)
  });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

/* ---------- Build version (cache-busting / auto-reload) ---------- */

app.get("/api/version", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ build: BUILD_ID });
});

/* ---------- Leaderboard (wins) + live online counter ----------
   Хранение — простой JSON-файл (data/leaderboard.json). Схема: { users: {
   <id>: { id, username, global_name, avatar_url, wins, updatedAt } } }.
   Записи апдейтим на endMatch (type:"match_win") от хоста — он авторитетен
   по результату. Чтобы не потерять на рестарте, сохраняем debounced. */

// Путь к каталогу персистентных данных. На локалке — ./data (под .gitignore).
// В проде на Railway FS эфемерна между деплоями — нужно смонтировать Volume
// (например, в /data) и задать DATA_DIR=/data в Variables. Иначе топ и
// балансы кошелька сбросятся на каждом редеплое.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LB_PATH  = path.join(DATA_DIR, "leaderboard.json");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(_) {}

function loadLeaderboard(){
  try {
    const raw = fs.readFileSync(LB_PATH, "utf8");
    const j = JSON.parse(raw);
    if (j && j.users && typeof j.users === "object") return j;
  } catch(_) {}
  return { users: {} };
}
const LB = loadLeaderboard();

let _lbSaveTimer = null;
function saveLeaderboardDebounced(){
  if (_lbSaveTimer) return;
  _lbSaveTimer = setTimeout(() => {
    _lbSaveTimer = null;
    try { fs.writeFileSync(LB_PATH, JSON.stringify(LB), "utf8"); }
    catch(e){ console.error("[lb] write failed:", e); }
  }, 500);
}

function ensureUser(user){
  if (!user || !user.id) return null;
  let u = LB.users[user.id];
  if (!u){
    u = {
      id: user.id,
      username: user.username || "",
      global_name: user.global_name || user.username || "",
      avatar_url: user.avatar_url || null,
      wins: 0,
      trophies: 0,
      coins: 0,
      updatedAt: Date.now()
    };
    LB.users[user.id] = u;
  } else {
    if (typeof u.coins    !== "number") u.coins    = 0;
    if (typeof u.trophies !== "number") u.trophies = 0;
    if (user.username)    u.username    = user.username;
    if (user.global_name) u.global_name = user.global_name;
    if (user.avatar_url)  u.avatar_url  = user.avatar_url;
  }
  return u;
}

/* ---------- Match stakes (trophies) ----------
   На старте матча сервер катает две случайные величины:
     win  ∈ [20..35] — сколько +трофеев получит победитель
     loss ∈ [25..40] — сколько −трофеев потеряет проигравший (клампим в 0).
   Ставки хранятся по matchId, и match_win / match_loss смотрят именно
   туда — клиент не может подменить размер награды. Каждый исход на матч
   принимается один раз: повторный match_win с того же matchId → no-op.
   Через 15 минут запись стирается (GC на случай, если клиент не закрыл
   матч и не перезапросил). */
const TROPHY_WIN_MIN  = 20, TROPHY_WIN_MAX  = 35;
const TROPHY_LOSS_MIN = 25, TROPHY_LOSS_MAX = 40;
const matchStakes = new Map();

function randInt(min, max){ return min + Math.floor(Math.random() * (max - min + 1)); }

function rollStakes(){
  return {
    win:  randInt(TROPHY_WIN_MIN,  TROPHY_WIN_MAX),
    loss: randInt(TROPHY_LOSS_MIN, TROPHY_LOSS_MAX),
    winnerReportedBy: null,
    loserReportedBy:  null
  };
}

function registerStakes(matchId, stakes){
  matchStakes.set(matchId, stakes);
  setTimeout(()=> matchStakes.delete(matchId), 15 * 60 * 1000);
}

function applyMatchOutcome(ws, matchId, outcome){
  const st = matchStakes.get(matchId);
  if (!st) return null;
  if (outcome === "win") {
    if (st.winnerReportedBy) return null;
    st.winnerReportedBy = ws.user.id;
  } else {
    if (st.loserReportedBy) return null;
    st.loserReportedBy = ws.user.id;
  }
  const u = ensureUser(ws.user);
  if (!u) return null;
  const delta = outcome === "win" ? st.win : -st.loss;
  u.trophies = Math.max(0, (u.trophies | 0) + delta);
  u.updatedAt = Date.now();
  console.log(`[lb] ${outcome} ${ws.user.id} Δ${delta} → ${u.trophies}`);
  saveLeaderboardDebounced();
  return { total: u.trophies, delta };
}

/* ---------- Server-authoritative wallet ----------
   Клиент шлёт {type:"award", kind, matchId, context}. Сервер — единственный
   источник истины по балансу. Рейт-лимиты и размеры наград настроены тут,
   а не на клиенте: правка клиентского кода ни на что не влияет.
   Допустимые kind:
     rally.hit   — касание мяча; +1, до 200 за матч, не чаще 1 раз в 250 мс.
     rally.combo — серия касаний; +context.combo (клампим 1..200), до 40 за матч.
     round.win   — выигран раунд; +5, до 100 за матч.
     match.win   — выигран матч; +50, 1 раз за матч + 30 с кулдаун между
                   любыми match.win одного юзера (против фермы ботов).
   Лимиты «за матч» — по matchId (клиент генерит при старте). Новые matchId
   ресетят счётчик kind, поэтому общая кросс-матч защита — global cooldown на
   match.win и умеренные per-match лимиты для остальных событий. */
const AWARDS = {
  "rally.hit":   { amount: 1,  minGapMs: 250,  maxPerMatch: 200 },
  "rally.combo": { amount: 0,  minGapMs: 400,  maxPerMatch: 40, fromContext: true },
  "round.win":   { amount: 5,  minGapMs: 500,  maxPerMatch: 100 },
  "match.win":   { amount: 50, minGapMs: 1000, maxPerMatch: 1,  globalGapMs: 30000 }
};
// userId → { kind → { lastAt, count, matchId } } + _lastMatchWinAt
const userRates = new Map();

function awardCoins(user, kind, matchId, context){
  const cfg = AWARDS[kind];
  if (!cfg) return null;
  if (!matchId || typeof matchId !== "string" || matchId.length > 64) return null;
  const u = ensureUser(user);
  if (!u) return null;
  const now = Date.now();
  let rec = userRates.get(user.id);
  if (!rec){ rec = { _lastMatchWinAt: 0 }; userRates.set(user.id, rec); }
  // Global cooldown — защита от фарма ботом на коротких быстрых матчах.
  if (cfg.globalGapMs && kind === "match.win"){
    if (now - (rec._lastMatchWinAt || 0) < cfg.globalGapMs) return null;
  }
  let st = rec[kind];
  if (!st || st.matchId !== matchId) st = rec[kind] = { lastAt: -Infinity, count: 0, matchId };
  if (now - st.lastAt < cfg.minGapMs) return null;
  if (st.count >= cfg.maxPerMatch)    return null;
  let amount = cfg.amount;
  if (cfg.fromContext && context && typeof context.combo === "number"){
    amount = Math.max(1, Math.min(200, context.combo | 0));
  }
  st.lastAt = now;
  st.count++;
  if (kind === "match.win") rec._lastMatchWinAt = now;
  u.coins = (u.coins || 0) + amount;
  if (u.coins < 0) u.coins = 0;
  u.updatedAt = now;
  saveLeaderboardDebounced();
  return { coins: u.coins, delta: amount };
}

function userCoins(id){
  const u = LB.users[id];
  return (u && typeof u.coins === "number") ? u.coins : 0;
}

function userTrophies(id){
  const u = LB.users[id];
  return (u && typeof u.trophies === "number") ? u.trophies : 0;
}

const LB_PAGE_SIZE = 10;

// Отсортированный список юзеров с трофеями > 0. Лишний раз материализовать
// не страшно — LB.users в памяти, сортировка O(n log n) на горстке записей.
function rankedUsers(){
  return Object.values(LB.users)
    .filter(u => (u.trophies || 0) > 0)
    .sort((a, b) => (b.trophies || 0) - (a.trophies || 0) || (a.updatedAt || 0) - (b.updatedAt || 0));
}

app.get("/api/leaderboard", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const me = getSession(req);
  const list = rankedUsers();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / LB_PAGE_SIZE));
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > pages) page = pages;
  const start = (page - 1) * LB_PAGE_SIZE;
  const entries = list.slice(start, start + LB_PAGE_SIZE).map((u, i) => ({
    id: u.id,
    global_name: u.global_name || u.username || "",
    avatar_url: u.avatar_url || null,
    trophies: u.trophies || 0,
    rank: start + i + 1
  }));

  let mine = null;
  if (me) {
    const u = LB.users[me.id];
    const trophies = (u && u.trophies) || 0;
    if (trophies > 0) {
      const idx = list.findIndex(x => x.id === me.id);
      const rank = idx + 1;
      mine = { id: me.id, trophies, rank, page: Math.floor(idx / LB_PAGE_SIZE) + 1 };
    } else {
      mine = { id: me.id, trophies: 0, rank: null, page: null };
    }
  }
  res.json({ top: entries, me: mine, total, page, pages, pageSize: LB_PAGE_SIZE });
});

app.get("/api/stats", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ online: onlineCount() });
});

/* ---------- Static frontend ---------- */

function sendIndex(res){
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("html").send(INDEX_HTML);
}

app.get(["/", "/index.html"], (req, res) => sendIndex(res));

app.use(express.static(path.join(__dirname), {
  index: false,  // index.html отдаём сами — с проставленным build-id
  setHeaders: (res, p) => {
    if (/\.(webp|png|jpg|jpeg|svg|woff2|ico)$/i.test(p)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (/\.(js|css)$/i.test(p)) {
      // У версионированных URL (?v=...) ключ кеша меняется на каждом деплое,
      // поэтому можно кешировать агрессивно. Без ?v= всё равно релоад подтянет
      // свежее за счёт INDEX_HTML, где ссылки уже со свежим build-id.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }
}));

// SPA fallback: любой неизвестный GET → index.html (для будущих клиент-роутов).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) return next();
  sendIndex(res);
});

/* ---------- WebSocket matchmaking + relay ----------
   Очень простая одноочерёдная матчмейкинг:
     • клиент коннектится на /ws, проходит auth по session-cookie
     • шлёт {type:"queue"} — если кто-то уже ждёт, матчим пару
     • иначе встаёт в слот ожидания на 3 секунды; по таймауту клиент
       сам решает пойти в игру с ботом ({type:"timeout"} → dequeue)
     • после матча оба получают {type:"matched", role, opponent};
       host = первый встал в очередь, guest = второй (пара хост/гость
       важна, поскольку физика автортитарна на хосте)
     • внутриигровые сообщения ретранслируются через {type:"relay", payload}
       → пир получает {type:"peer", payload} */

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Разбор cookie + проверка HMAC-подписи тем же секретом, что и Express.
const cookieLib       = require("cookie");
const cookieSignature = require("cookie-signature");
function authUserFromCookie(req){
  const header = req.headers.cookie || "";
  const parsed = cookieLib.parse(header);
  const signed = parsed[SESSION_COOKIE];
  if (!signed) return null;
  const body = signed.startsWith("s:") ? signed.slice(2) : signed;
  const raw = cookieSignature.unsign(body, SESSION_SECRET);
  if (raw === false) return null;
  try {
    const u = JSON.parse(raw);
    if (!u || !u.id) return null;
    return u;
  } catch { return null; }
}

let waiting = null;        // WebSocket или null
const QUEUE_TIMEOUT_MS = 30000;

// Счётчик активных авторизованных соединений. Использует внутреннее
// состояние wss.clients, но мы фильтруем по ws.user (анон сюда не доходит
// — мы закрываем соединение при отсутствии cookie) и readyState=1.
function onlineCount(){
  let n = 0;
  wss.clients.forEach(c => { if (c.user && c.readyState === 1) n++; });
  return n;
}
function broadcastStats(){
  const msg = JSON.stringify({ type: "stats", online: onlineCount() });
  wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(msg); } catch {} } });
}

function safeUser(u){
  if (!u) return null;
  return {
    id:          u.id,
    username:    u.username,
    global_name: u.global_name || u.username,
    avatar_url:  u.avatar_url || null
  };
}

function send(ws, obj){
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function clearQueue(ws){
  if (waiting === ws) {
    waiting = null;
    if (ws._queueTimer) { clearTimeout(ws._queueTimer); ws._queueTimer = null; }
  }
}

function pair(host, guest){
  clearQueue(host);
  clearQueue(guest);
  const roomId  = crypto.randomBytes(6).toString("hex");
  const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
  const stakes  = rollStakes();
  registerStakes(matchId, stakes);
  host.peer  = guest; guest.peer = host;
  host.role  = "host"; guest.role = "guest";
  host.roomId = guest.roomId = roomId;
  host.activeMatchId = guest.activeMatchId = matchId;
  const stakesMsg = { win: stakes.win, loss: stakes.loss };
  send(host,  { type: "matched", role: "host",  room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(guest.user) });
  send(guest, { type: "matched", role: "guest", room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(host.user)  });
  console.log(`[ws] matched host=${host.user.id} guest=${guest.user.id} room=${roomId} match=${matchId} stakes=+${stakes.win}/-${stakes.loss}`);
}

function onQueue(ws){
  if (ws.peer) return; // уже в матче — игнорируем повторный queue
  if (waiting && waiting !== ws && waiting.readyState === 1) {
    pair(waiting, ws);
    return;
  }
  waiting = ws;
  if (ws._queueTimer) clearTimeout(ws._queueTimer);
  ws._queueTimer = setTimeout(() => {
    if (waiting === ws) {
      waiting = null;
      send(ws, { type: "queue_timeout" });
    }
  }, QUEUE_TIMEOUT_MS);
}

function leaveRoom(ws, reason){
  const peer = ws.peer;
  // Анти-ренакт: уходящий из активного матча автоматически получает
  // поражение (−loss трофеев). Только если матч ещё не закрыт и исход
  // от этого юзера ещё не пришёл. Cancel в лобби (до pair) не достигает
  // этой ветки — activeMatchId там не выставлен.
  const mid = ws.activeMatchId;
  if (mid && reason !== "cancel") {
    const st = matchStakes.get(mid);
    if (st && !st.loserReportedBy && !st.winnerReportedBy){
      const res = applyMatchOutcome(ws, mid, "loss");
      if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
    }
  }
  ws.activeMatchId = null;
  if (peer) {
    peer.peer = null;
    send(peer, { type: "peer_left", reason: reason || "disconnect" });
  }
  ws.peer = null;
  ws.roomId = null;
}

wss.on("connection", (ws, req) => {
  const user = authUserFromCookie(req);
  if (!user) {
    try { ws.close(4401, "unauthorized"); } catch {}
    return;
  }
  ws.user = user;
  ws.peer = null;
  ws.roomId = null;

  send(ws, { type: "hello", user: safeUser(user), online: onlineCount(), coins: userCoins(user.id), trophies: userTrophies(user.id) });
  broadcastStats();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "queue":
        onQueue(ws);
        break;
      case "cancel":
        clearQueue(ws);
        if (ws.peer) leaveRoom(ws, "cancel");
        break;
      case "leave":
        leaveRoom(ws, "leave");
        break;
      case "match_stakes_request": {
        // Бот-матч: клиент сгенерил matchId локально и просит сервер
        // зафиксировать ставки трофеев. Если для этого matchId уже есть
        // запись — возвращаем кэш (ре-коннекты, повторный запрос).
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : "";
        if (!mid) break;
        let st = matchStakes.get(mid);
        if (!st){
          st = rollStakes();
          registerStakes(mid, st);
        }
        ws.activeMatchId = mid;
        send(ws, { type: "match_stakes", matchId: mid, win: st.win, loss: st.loss });
        break;
      }
      case "match_win": {
        // Сервер берёт размер награды из зафиксированных ставок — клиент
        // не может раздуть сумму. Защищено одноразовостью: повторный
        // match_win с тем же matchId → no-op.
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : (ws.activeMatchId || "");
        if (!mid) break;
        const res = applyMatchOutcome(ws, mid, "win");
        if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
        break;
      }
      case "match_loss": {
        // Потеря трофеев: сервер применяет ставку loss (с клампом в 0).
        // Повторный match_loss с тем же matchId проигнорируется.
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : (ws.activeMatchId || "");
        if (!mid) break;
        const res = applyMatchOutcome(ws, mid, "loss");
        if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
        break;
      }
      case "award": {
        // Серверно-авторитетные награды (все kind из AWARDS, включая match.win).
        // Клиент шлёт {kind, matchId, context}. Клиентский amount игнорируется —
        // размер награды определяет сервер. Защита от фарма бота:
        // global cooldown 30 с между match.win + per-match cap по каждому kind.
        const kind = String(msg.kind || "");
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : "";
        if (!mid) break;
        const ctx = (msg.context && typeof msg.context === "object") ? msg.context : null;
        const res = awardCoins(ws.user, kind, mid, ctx);
        if (res) send(ws, { type: "wallet", coins: res.coins, delta: res.delta, kind });
        break;
      }
      case "relay":
        // relay-payload прозрачно отдаём сопернику. Ограничение размера —
        // 4KB на сообщение, чтобы не положить рилей флудом.
        if (ws.peer && ws.peer.readyState === 1) {
          const payload = msg.payload;
          try {
            const str = JSON.stringify(payload || {});
            if (str.length < 4096) {
              ws.peer.send(JSON.stringify({ type: "peer", payload }));
            }
          } catch {}
        }
        break;
    }
  });

  ws.on("close", () => {
    clearQueue(ws);
    leaveRoom(ws, "disconnect");
    // Счётчик онлайна изменился — уведомим всех подключённых клиентов.
    broadcastStats();
  });

  ws.on("error", () => {});
});

httpServer.listen(Number(PORT), () => {
  console.log(`[discord-volley] listening on :${PORT}`);
  console.log(`[discord-volley] public: ${APP_URL}`);
  console.log(`[discord-volley] redirect_uri: ${REDIRECT_URI}`);
  console.log(`[discord-volley] NODE_ENV=${NODE_ENV}`);
});
