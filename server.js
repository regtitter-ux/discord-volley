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
  res.json({
    id:          u.id,
    username:    u.username,
    global_name: u.global_name,
    avatar_url:  u.avatar_url
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
const QUEUE_TIMEOUT_MS = 3000;

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
  const roomId = crypto.randomBytes(6).toString("hex");
  host.peer  = guest; guest.peer = host;
  host.role  = "host"; guest.role = "guest";
  host.roomId = guest.roomId = roomId;
  send(host,  { type: "matched", role: "host",  room: roomId, opponent: safeUser(guest.user) });
  send(guest, { type: "matched", role: "guest", room: roomId, opponent: safeUser(host.user)  });
  console.log(`[ws] matched host=${host.user.id} guest=${guest.user.id} room=${roomId}`);
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

  send(ws, { type: "hello", user: safeUser(user) });

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
  });

  ws.on("error", () => {});
});

httpServer.listen(Number(PORT), () => {
  console.log(`[discord-volley] listening on :${PORT}`);
  console.log(`[discord-volley] public: ${APP_URL}`);
  console.log(`[discord-volley] redirect_uri: ${REDIRECT_URI}`);
  console.log(`[discord-volley] NODE_ENV=${NODE_ENV}`);
});
