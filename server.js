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
  const deco = DB.getDecorations(u.id);
  res.json({
    id:          u.id,
    username:    u.username,
    global_name: u.global_name,
    avatar_url:  u.avatar_url,
    coins:       userCoins(u.id),
    trophies:    userTrophies(u.id),
    decoration:  selectedDecorationPayload(deco.selected)
  });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Dev-only login shortcut для E2E-тестов. Подписывает поддельную session-
// куку без Discord OAuth. Никогда не активен в проде: отключён, если
// NODE_ENV==="production" ИЛИ если не выставлен DV_DEV_LOGIN=1, так что
// даже случайный запуск с NODE_ENV!=production на публичном узле без явной
// опт-ин переменной его не откроет.
if (NODE_ENV !== "production" && process.env.DV_DEV_LOGIN === "1"){
  app.get("/dev/login", (req, res) => {
    const id   = String(req.query.id || "").slice(0, 32) || ("t-" + crypto.randomBytes(4).toString("hex"));
    const name = String(req.query.name || "").slice(0, 32) || id;
    const user = {
      id, username: name, global_name: name, avatar_url: null, iat: Date.now()
    };
    res.cookie(SESSION_COOKIE, JSON.stringify(user), sessionCookieOpts);
    res.json({ ok: true, user });
  });
  console.log("[dev] /dev/login enabled (DV_DEV_LOGIN=1)");
}

/* ---------- Build version (cache-busting / auto-reload) ---------- */

app.get("/api/version", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ build: BUILD_ID });
});

/* ---------- Leaderboard (trophies) + wallet (coins) ----------
   Хранение — SQLite (data/volley.sqlite). Одна таблица users со всеми
   полями лидерборда/кошелька. Писатели — applyMatchOutcome (+трофеи/-трофеи)
   и awardCoins (+монеты); читатель /api/leaderboard идёт через индекс по
   trophies DESC и работает за O(log n + pageSize). При росте таблицы
   in-memory LB.users + sort() в каждом ответе стал бы узким местом. */

// Путь к каталогу персистентных данных. На локалке — ./data (под .gitignore).
// В проде на Railway FS эфемерна между деплоями — нужно смонтировать Volume
// (например, в /data) и задать DATA_DIR=/data в Variables. Иначе топ и
// балансы кошелька сбросятся на каждом редеплое.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// SQLite (node:sqlite, WAL-mode). Заменил JSON-файл, который блокировал
// event loop на каждый flush и требовал сериализации всей таблицы при
// любом изменении. Теперь update — это одна транзакция в пару мс без
// участия event loop'а в I/O. Миграция leaderboard.json → users делается
// внутри openDb() лениво, при первом старте на чистой базе.
const { openDb } = require("./db");
const DB = openDb(DATA_DIR);

function ensureUser(user){ return DB.ensureUser(user); }

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
const MATCH_STAKES_TTL_MS = 15 * 60 * 1000;

function randInt(min, max){ return min + Math.floor(Math.random() * (max - min + 1)); }

function rollStakes(){
  return {
    win:  randInt(TROPHY_WIN_MIN,  TROPHY_WIN_MAX),
    loss: randInt(TROPHY_LOSS_MIN, TROPHY_LOSS_MAX),
    winnerReportedBy: null,
    loserReportedBy:  null
  };
}

// userRates растёт линейно по числу уникальных юзеров за время аптайма и
// никогда не освобождается. Раз в 5 минут выкидываем записи, где последняя
// активность старше часа — кулдауны за это время всё равно истекли.
// В multi-instance режиме userRates per-instance: это ок, т.к. ws-сессия
// клиента держится одним инстансом, и все award'ы одного матча приходят
// туда же. Суммарный кап по match.win защищён global-cooldown'ом 30с
// (приближение, а не строгая гарантия через Redis — сознательный trade-off).
const USER_RATES_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - USER_RATES_TTL_MS;
  for (const [id, rec] of userRates){
    let latest = rec._lastMatchWinAt || 0;
    for (const k of Object.keys(rec)){
      if (k.startsWith("_")) continue;
      const st = rec[k];
      if (st && st.lastAt > latest) latest = st.lastAt;
    }
    if (latest < cutoff) userRates.delete(id);
  }
}, 5 * 60 * 1000).unref();

// Атомарный claim через broker: под Redis это Lua-скрипт, гарантирующий,
// что даже два инстанса не смогут выплатить win/loss дважды. Под LocalBroker
// — обычная проверка поля на in-memory записи.
async function applyMatchOutcome(userObj, matchId, outcome){
  const r = await broker.claimOutcome(matchId, userObj.id, outcome);
  if (!r) return null;
  const total = DB.addTrophies(userObj, r.delta);
  console.log(`[lb] ${outcome} ${userObj.id} Δ${r.delta} → ${total}`);
  return { total, delta: r.delta };
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
// Env-оверрайды оставлены для интеграционных тестов: поднимать per-match cap
// или 30с global cooldown на живом сервере на время теста дешевле и честнее,
// чем мокать awardCoins. В проде env не задан — работают дефолты.
const AWARDS = {
  "rally.hit":   { amount: 1,  minGapMs: 250,  maxPerMatch: Number(process.env.WALLET_RALLY_MAX) || 200 },
  "rally.combo": { amount: 0,  minGapMs: 400,  maxPerMatch: 40, fromContext: true },
  "round.win":   { amount: 5,  minGapMs: 500,  maxPerMatch: 100 },
  "match.win":   { amount: 50, minGapMs: 1000, maxPerMatch: 1,  globalGapMs: Number(process.env.WALLET_MATCHWIN_GLOBAL_MS) || 30000 }
};
// userId → { kind → { lastAt, count, matchId } } + _lastMatchWinAt
const userRates = new Map();

function awardCoins(user, kind, matchId, context){
  const cfg = AWARDS[kind];
  if (!cfg) return null;
  if (!matchId || typeof matchId !== "string" || matchId.length > 64) return null;
  if (!user || !user.id) return null;
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
  const coins = DB.addCoins(user, amount);
  return { coins, delta: amount };
}

function userCoins(id){    return DB.getCoins(id); }
function userTrophies(id){ return DB.getTrophies(id); }

const LB_PAGE_SIZE = 10;

app.get("/api/leaderboard", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const me = getSession(req);
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  // Индексированный SELECT ORDER BY trophies DESC LIMIT/OFFSET — при росте
  // таблицы до десятков тысяч пользователей остаётся O(log n + pageSize),
  // а не O(n log n) как было при сортировке in-memory массива.
  const pg = DB.leaderboardPage(page, LB_PAGE_SIZE);
  const mine = me ? DB.meRank(me.id, LB_PAGE_SIZE) : null;
  res.json({
    top: pg.entries,
    me: mine,
    total: pg.total,
    page: pg.page,
    pages: pg.pages,
    pageSize: LB_PAGE_SIZE
  });
});

app.get("/api/stats", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const online = broker ? await broker.getOnline() : 0;
  res.json({ online });
});

/* ---------- Decorations ----------
   Каталог — статический сервер-авторитетный словарь: id, цена в монетах
   и параметры атласа (размер кадра + сетка + длительность кадра). Клиент
   использует их, чтобы проиграть анимацию через background-position без
   догадок. Добавление нового украшения = строка сюда + спрайт-лист в
   /assets/decorations/<id>/atlas.png. Цены и размеры никогда не приходят
   с клиента. */
const DECORATIONS = {
  deco1: {
    id:         "deco1",
    price:      100,
    atlas:      "/assets/decorations/deco1/atlas.png",
    frames:     60,
    fps:        12,
    frameW:     96,
    frameH:     96,
    cols:       6,
    rows:       10
  }
};
const DECORATION_IDS = new Set(Object.keys(DECORATIONS));

function decorationCatalogList(){
  return Object.values(DECORATIONS).map(d => ({ ...d }));
}

// Клиент получает украшение вместе с /api/me и в WS hello — ему нужны
// параметры атласа (frameW/cols/fps), чтобы отрисовать. Если выбранное
// украшение было удалено из каталога (теоретический случай), возвращаем
// null — клиент просто отрендерит голый аватар.
function selectedDecorationPayload(id){
  if (!id) return null;
  const d = DECORATIONS[id];
  return d ? { ...d } : null;
}

app.get("/api/decorations", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const u = getSession(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const s = DB.getDecorations(u.id);
  res.json({
    catalog:  decorationCatalogList(),
    owned:    s.owned,
    selected: s.selected,
    coins:    s.coins
  });
});

// Покупка — query-параметр, чтобы не тащить body-parser ради одной ручки.
// Атомарный UPDATE в БД гарантирует, что даже при параллельных запросах
// монеты снимутся ровно один раз; повторный POST с тем же id вернёт
// already_owned (changes = 0 при instr-матче).
app.post("/api/decorations/buy", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const u = getSession(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const id = String(req.query.id || "");
  if (!DECORATION_IDS.has(id)) return res.status(400).json({ error: "unknown_decoration" });
  const cur = DB.getDecorations(u.id);
  if (cur.owned.includes(id)) return res.json({ ok: true, already_owned: true, ...cur });
  const price = DECORATIONS[id].price | 0;
  if ((cur.coins | 0) < price) return res.status(402).json({ error: "insufficient_coins", coins: cur.coins });
  const r = DB.buyDecoration(u, id, price);
  if (!r.ok) return res.status(409).json({ error: "buy_failed", coins: r.coins });
  // Пушим обновлённый баланс через живой WS-коннект, если он есть —
  // открытые в других вкладках меню сразу увидят новую сумму.
  pushCoinsToUser(u.id, r.coins);
  res.json({ ok: true, coins: r.coins, owned: r.owned, selected: r.selected });
});

app.post("/api/decorations/select", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const u = getSession(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  const raw = req.query.id;
  const id = (raw === "" || raw == null || raw === "null") ? null : String(raw);
  if (id && !DECORATION_IDS.has(id)) return res.status(400).json({ error: "unknown_decoration" });
  const r = DB.setSelectedDecoration(u, id);
  if (!r.ok) return res.status(403).json({ error: "not_owned" });
  res.json({
    ok: true,
    selected: r.selected,
    decoration: selectedDecorationPayload(r.selected),
    owned: r.owned,
    coins: r.coins
  });
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

// Broker — абстракция над (local | redis). Инициализируется в startup
// async IIFE ниже. Все multi-instance примитивы (очередь, relay, stakes,
// online-counter) идут через него; под капотом либо in-memory, либо Redis.
const { createBroker } = require("./broker");
let broker = null;
let INSTANCE_ID = crypto.randomBytes(6).toString("hex");

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

// Таймаут ожидания пары в очереди. В проде 30с, но тесты переопределяют
// через env QUEUE_TIMEOUT_MS, чтобы проверять regression-сценарии за <1с.
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 30000;

// stats broadcast — throttle 1 раз в 2с, leading-edge + trailing tail.
// Под Redis-брокером счётчик онлайна общий; пульс публикуется каждым
// инстансом в дружественный dv:stats канал, и каждый локально фанаутит
// в свои wss.clients. В local-режиме работает идентично.
const STATS_INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS) || 2000;
let _statsTimer   = null;
let _statsPending = false;
let _lastStatsTotal = 0;
function _doBroadcastStats(){
  const msg = JSON.stringify({ type: "stats", online: _lastStatsTotal });
  wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(msg); } catch {} } });
}

// Точечный пуш нового баланса монет всем живым WS-сессиям этого юзера на
// текущем инстансе. Используется после HTTP-покупки украшения, чтобы
// открытое меню в другой вкладке не показывало устаревший баланс до
// следующего award'а.
function pushCoinsToUser(userId, coins){
  const msg = JSON.stringify({ type: "wallet", coins: coins | 0, delta: 0, kind: "deco.buy" });
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (!c.user || c.user.id !== userId) return;
    try { c.send(msg); } catch {}
  });
}
function scheduleStatsBroadcast(){
  if (_statsTimer){ _statsPending = true; return; }
  _doBroadcastStats();
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    if (_statsPending){ _statsPending = false; scheduleStatsBroadcast(); }
  }, STATS_INTERVAL_MS);
}

// Раз в 5с выкидываем клиентов с зависшим буфером отправки: если мы успели
// запушить >2МБ в сокет, значит клиент либо мёртв, либо не успевает читать —
// держать память процесса ради него опасно при 10k коннектов.
const WS_STUCK_BYTES = 2 * 1024 * 1024;
setInterval(() => {
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.bufferedAmount > WS_STUCK_BYTES){
      try { c.terminate(); } catch {}
    }
  });
}, 5000).unref();

// Token bucket на входящие сообщения — 120 msg/s с бёрстом 60. Защищает
// relay и switch от флуда одним клиентом. Сверх бюджета — тихо дропаем
// (ответ об ошибке сам по себе стоил бы ресурсов).
const MSG_RATE_PER_SEC = 120;
const MSG_BURST        = 60;
function takeToken(ws){
  const now = Date.now();
  const dt  = (now - ws._tokensT) / 1000;
  ws._tokensT = now;
  ws._tokens  = Math.min(MSG_BURST, (ws._tokens || 0) + dt * MSG_RATE_PER_SEC);
  if (ws._tokens < 1) return false;
  ws._tokens--;
  return true;
}

function safeUser(u){
  if (!u) return null;
  return {
    id:          u.id,
    username:    u.username,
    global_name: u.global_name || u.username,
    avatar_url:  u.avatar_url || null,
    trophies:    userTrophies(u.id)
  };
}

const WS_BACKPRESSURE_DROP = 1 * 1024 * 1024;
function send(ws, obj){
  if (!ws || ws.readyState !== 1) return;
  // Не забиваем сокет, если клиент уже отстаёт: дальнейший push только
  // раздувает буфер процесса. terminate отдан фоновому sweep'у.
  if (ws.bufferedAmount > WS_BACKPRESSURE_DROP) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

async function clearQueue(ws){
  if (ws._inQueue){
    ws._inQueue = false;
    await broker.dequeue(ws._client);
  }
  if (ws._queueTimer){ clearTimeout(ws._queueTimer); ws._queueTimer = null; }
}

// Локальный сброс таймера + флага, БЕЗ обращения к broker (на момент
// pairLocal/onRemotePair нас уже достали из очереди — dequeue не нужен, а
// на Redis он был бы лишним round-trip'ом). Ровно то, что нужно, чтобы
// отсроченный queue_timeout не выстрелил в середине уже начатого матча.
function clearQueueTimer(ws){
  if (!ws) return;
  if (ws._queueTimer){ clearTimeout(ws._queueTimer); ws._queueTimer = null; }
  ws._inQueue = false;
}

// Локальный pair: оба клиента на этом инстансе. host — тот, что ждал,
// guest — тот, что только что подошёл и заключил пару.
async function pairLocal(host, guest){
  const roomId  = crypto.randomBytes(6).toString("hex");
  const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
  const stakes  = rollStakes();
  await broker.setStakes(matchId, stakes, MATCH_STAKES_TTL_MS);
  host.role  = "host"; guest.role = "guest";
  host.roomId = guest.roomId = roomId;
  host.activeMatchId = guest.activeMatchId = matchId;
  // Критично: хост ждал в очереди — у него стоит _inQueue + _queueTimer.
  // Без сброса через QUEUE_TIMEOUT_MS (30с) таймер сработает прямо посреди
  // живого матча, увидит _inQueue=true и отправит хосту {type:"queue_timeout"}.
  // Клиент воспримет это как «не нашли пару» и запустит startBotMatch поверх
  // активного PvP-матча (→ бот у хоста, зависшая картинка у гостя).
  clearQueueTimer(host);
  clearQueueTimer(guest);
  await broker.joinRoom(roomId, host._client);
  await broker.joinRoom(roomId, guest._client);
  const stakesMsg = { win: stakes.win, loss: stakes.loss };
  send(host,  { type: "matched", role: "host",  room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(guest.user) });
  send(guest, { type: "matched", role: "guest", room: roomId, matchId, stakes: stakesMsg, opponent: safeUser(host.user)  });
  console.log(`[ws] matched host=${host.user.id} guest=${guest.user.id} room=${roomId} match=${matchId} stakes=+${stakes.win}/-${stakes.loss}`);
}

// Cross-instance pair: нас забрали из очереди на другом инстансе. Пришло
// сообщение в наш dv:inst:<id> канал. Мы — host (ждали в очереди).
async function onRemotePair(info){
  const host = broker.clients.get(info.hostWsId);
  if (!host || host.ws.readyState !== 1) return;
  host.ws.role = "host";
  host.ws.roomId = info.roomId;
  host.ws.activeMatchId = info.matchId;
  // Тот же хазард, что и в pairLocal: у ждавшего хоста висит _queueTimer,
  // который без сброса через 30с рубит живой матч через queue_timeout.
  clearQueueTimer(host.ws);
  await broker.joinRoom(info.roomId, host);
  const stakesMsg = { win: info.stakes.win, loss: info.stakes.loss };
  send(host.ws, { type: "matched", role: "host", room: info.roomId, matchId: info.matchId, stakes: stakesMsg, opponent: info.guestUser });
  console.log(`[ws] remote-matched host=${host.ws.user.id} room=${info.roomId} match=${info.matchId}`);
}

async function onQueue(ws){
  if (ws.roomId) return; // уже в матче — игнорируем повторный queue
  if (ws._inQueue) return;

  const res = await broker.enqueue(ws._client);
  if (res && res.kind === "local"){
    const partner = res.partner.ws; // client wraps ws
    if (partner && partner.readyState === 1){
      await pairLocal(partner, ws);
    }
    return;
  }
  if (res && res.kind === "remote"){
    // Партнёр на другом инстансе — мы guest, он host. Сгенерим общие
    // идентификаторы и отправим pair туда.
    const roomId  = crypto.randomBytes(6).toString("hex");
    const matchId = "pm-" + crypto.randomBytes(8).toString("hex");
    const stakes  = rollStakes();
    await broker.setStakes(matchId, stakes, MATCH_STAKES_TTL_MS);
    ws.role = "guest";
    ws.roomId = roomId;
    ws.activeMatchId = matchId;
    await broker.joinRoom(roomId, ws._client);
    const stakesMsg = { win: stakes.win, loss: stakes.loss };
    send(ws, { type: "matched", role: "guest", room: roomId, matchId, stakes: stakesMsg, opponent: { id: res.partner.userId } });
    await broker.publishPair(res.partner.instance, {
      hostWsId:  res.partner.wsId,
      guestUser: safeUser(ws.user),
      roomId, matchId,
      stakes: { win: stakes.win, loss: stakes.loss }
    });
    console.log(`[ws] cross-instance matched guest=${ws.user.id} room=${roomId} match=${matchId}`);
    return;
  }
  // null → нас поставили в очередь, ждём.
  ws._inQueue = true;
  if (ws._queueTimer) clearTimeout(ws._queueTimer);
  ws._queueTimer = setTimeout(async () => {
    ws._queueTimer = null;
    if (ws._inQueue){
      ws._inQueue = false;
      await broker.dequeue(ws._client);
      send(ws, { type: "queue_timeout" });
    }
  }, QUEUE_TIMEOUT_MS);
}

async function leaveRoom(ws, reason){
  // Анти-ренакт: уходящий из активного матча автоматически получает
  // поражение (−loss трофеев). Только если матч ещё не закрыт и исход
  // от этого юзера ещё не пришёл. Cancel в лобби (до pair) не достигает
  // этой ветки — activeMatchId там не выставлен.
  const mid = ws.activeMatchId;
  if (mid && reason !== "cancel"){
    const res = await applyMatchOutcome(ws.user, mid, "loss");
    if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
  }
  const roomId = ws.roomId;
  ws.activeMatchId = null;
  ws.roomId = null;
  if (roomId){
    // Уведомим пира (где бы он ни был) «control»-фреймом через publishRoom.
    // В local-режиме это прямой send, в Redis-режиме — publish по каналу.
    const frame = JSON.stringify({ type: "peer_left", reason: reason || "disconnect" });
    broker.publishRoom(roomId, ws.wsId, frame);
    // Симметрично сбрасываем серверное состояние локальных пиров в этой
    // комнате: матч кончился, комната больше не нужна. Иначе у пира
    // остаётся ws.roomId, и его следующий queue игнорится как "уже в
    // матче", пока он не нажмёт cancel. В Redis-режиме аналогичная
    // чистка отдалённого пира происходит в broker._onRoomFrame при
    // доставке peer_left — так покрыты оба layout'а.
    if (broker.getLocalRoomClients){
      const peers = broker.getLocalRoomClients(roomId);
      for (const c of peers){
        if (!c || c.wsId === ws.wsId) continue;
        // Только roomId — это ворота для "уже в матче" в onQueue. activeMatchId
        // держим: оставшийся пир всё ещё может прислать match_win/match_loss
        // без matchId-в-пейлоаде, и сервер найдёт нужный matchId через него.
        if (c.ws) c.ws.roomId = null;
      }
    }
    await broker.leaveRoom(roomId, ws._client);
  }
}

wss.on("connection", async (ws, req) => {
  const user = authUserFromCookie(req);
  if (!user) {
    try { ws.close(4401, "unauthorized"); } catch {}
    return;
  }
  ws.user          = user;
  ws.roomId        = null;
  ws.activeMatchId = null;
  ws._tokens       = MSG_BURST;
  ws._tokensT      = Date.now();
  // wsId — стабильный идентификатор клиента на время жизни WebSocket-коннекта,
  // общий для всех инстансов через Redis. В local-режиме тоже нужен:
  // publishRoom использует его как senderId, чтобы не отправлять эхо себе.
  ws.wsId    = broker.generateWsId();
  ws._client = {
    wsId:   ws.wsId,
    userId: user.id,
    ws,
    // sendRaw — горячий путь доставки уже сериализованного фрейма (снапшот
    // 30 Гц). Проверки readyState/bufferedAmount здесь обязательны, потому
    // что broker.publishRoom зовёт sendRaw без собственных проверок.
    sendRaw: (frame) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > WS_BACKPRESSURE_DROP) return;
      try { ws.send(frame); } catch {}
    }
  };
  broker.registerClient(ws._client);
  _lastStatsTotal = await broker.incrOnline();

  send(ws, { type: "hello", user: safeUser(user), online: _lastStatsTotal, coins: userCoins(user.id), trophies: userTrophies(user.id) });
  scheduleStatsBroadcast();

  ws.on("message", async (raw, isBinary) => {
    if (!takeToken(ws)) return;
    // Сверхгабаритные фреймы отрезаем по сырому размеру ещё до JSON.parse.
    if (raw && raw.length > 8192) return;
    // Бинарный горячий путь — relay без JSON.parse/JSON.stringify.
    // Клиент шлёт снапшоты/инпут/эмоции как бинарные WS-фреймы (см. Codec
    // в game.js); сервер forward'ит байты как есть всем в комнате через
    // broker.publishRoom. При 10k матчей × 30 Гц это снимает ~300k JSON-
    // циклов в секунду с главного event loop'а.
    if (isBinary) {
      if (!ws.roomId) return;
      if (!raw || raw.length < 2 || raw.length > 256) return;
      broker.publishRoom(ws.roomId, ws.wsId, raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "queue":
        await onQueue(ws);
        break;
      case "cancel":
        await clearQueue(ws);
        if (ws.roomId) await leaveRoom(ws, "cancel");
        break;
      case "leave":
        await leaveRoom(ws, "leave");
        break;
      case "match_stakes_request": {
        // Бот-матч: клиент сгенерил matchId локально и просит сервер
        // зафиксировать ставки трофеев. Если для этого matchId уже есть
        // запись — возвращаем кэш (ре-коннекты, повторный запрос).
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : "";
        if (!mid) break;
        let st = await broker.getStakes(mid);
        if (!st){
          st = rollStakes();
          await broker.setStakes(mid, st, MATCH_STAKES_TTL_MS);
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
        const res = await applyMatchOutcome(ws.user, mid, "win");
        if (res) send(ws, { type: "trophies", total: res.total, delta: res.delta });
        break;
      }
      case "match_loss": {
        // Потеря трофеев: сервер применяет ставку loss (с клампом в 0).
        // Повторный match_loss с тем же matchId проигнорируется.
        const mid = (typeof msg.matchId === "string") ? msg.matchId.slice(0, 64) : (ws.activeMatchId || "");
        if (!mid) break;
        const res = await applyMatchOutcome(ws.user, mid, "loss");
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
      case "relay": {
        // Горячий путь — 30 Гц на матч, при 10k матчей это ~600k msg/s
        // через всех пиров. Минимизируем работу: один JSON.stringify
        // итогового пакета, отсечка по длине уже сериализованной строки
        // (4KB). В local-режиме publishRoom синхронно фанаутит фрейм всем
        // членам комнаты на этом инстансе; в Redis — PUBLISH на per-room
        // канале, fire-and-forget (снапшот идемпотентный, следующий
        // долетит через 33 мс). Свой senderId broker использует, чтобы
        // не доставлять эхо обратно отправителю.
        if (!ws.roomId) break;
        const payload = msg.payload;
        if (!payload) break;
        let out;
        try { out = JSON.stringify({ type: "peer", payload }); } catch { break; }
        if (out.length >= 4096) break;
        broker.publishRoom(ws.roomId, ws.wsId, out);
        break;
      }
    }
  });

  ws.on("close", async () => {
    _lastStatsTotal = await broker.decrOnline();
    await clearQueue(ws);
    await leaveRoom(ws, "disconnect");
    broker.unregisterClient(ws._client);
    // Счётчик онлайна изменился — уведомим всех подключённых клиентов.
    scheduleStatsBroadcast();
  });

  ws.on("error", () => {});
});

// Брокер инициализируем ДО listen(): wss прицеплен к httpServer, пока он
// не слушает — upgrade-запросы не приходят, так что обработчик connection
// не дёрнет ещё-пустой broker. После init регистрируем колбэки для
// cross-instance pair (нас разбудили через dv:inst:<id>) и stats pulse,
// и запускаем housekeeping ставок (в Redis-режиме — no-op, там TTL в SET).
(async () => {
  broker = await createBroker({ redisUrl: process.env.REDIS_URL, instanceId: INSTANCE_ID });
  broker.onPairFromPeer(onRemotePair);
  broker.onStatsUpdate(total => { _lastStatsTotal = total; scheduleStatsBroadcast(); });
  broker.startHousekeeping(MATCH_STAKES_TTL_MS);
  httpServer.listen(Number(PORT), () => {
    console.log(`[discord-volley] listening on :${PORT}`);
    console.log(`[discord-volley] public: ${APP_URL}`);
    console.log(`[discord-volley] redirect_uri: ${REDIRECT_URI}`);
    console.log(`[discord-volley] NODE_ENV=${NODE_ENV} broker=${broker.kind} instance=${INSTANCE_ID}`);
  });
})().catch(e => {
  console.error("[fatal] startup failed:", e);
  process.exit(1);
});
