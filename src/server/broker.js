"use strict";

/* Broker — слой, за которым прячется различие между single-instance
   (in-memory) и multi-instance (Redis) режимами. Ничего не знает про
   WebSocket — работает с абстрактным клиентом {wsId, userId, send}.

   Два бэкенда:
     LocalBroker  — вся очередь/pub-sub/stakes/online в памяти процесса.
                    Используется, если REDIS_URL не задан. Поведение
                    ровно как до рефакторинга.
     RedisBroker  — очередь на Redis LIST с атомарным LPOP+LPUSH, relay
                    через Redis pub/sub на per-room каналах, stakes в
                    Redis ключах с EX-TTL, online — INCRBY с общим
                    счётчиком.

   Контракт:
     init()                             — async ready
     generateWsId()                     — короткий uid (чтобы идентифицировать клиента между инстансами)
     registerClient(client)             — broker запоминает local wsId → client
     unregisterClient(client)           — снимаем
     enqueue(client)                    — возвращает {kind,...} или null
     dequeue(client)
     joinRoom(roomId, client)           — добавить в локальный map + pub-sub sub (если Redis)
     leaveRoom(roomId, client)          — удалить + unsub, если комната опустела локально
     publishRoom(roomId, senderId, obj) — доставить всем членам комнаты (кроме отправителя)
     onPairFromPeer(cb)                 — cb({hostWsId, guestInfo, roomId, matchId, stakes}) если пару собрал другой инстанс
     onStatsUpdate(cb)                  — cb(total) при изменении глобального онлайна
     incrOnline() / decrOnline() / getOnline()
     setStakes(matchId, stakes, ttlMs)
     getStakes(matchId)
     claimOutcome(matchId, userId, outcome) — { delta, win, loss } или null
*/

const crypto = require("crypto");

function newId(n = 10){
  return crypto.randomBytes(n).toString("hex");
}

/* ============================================================
   LocalBroker — одноинстансовая реализация, полностью in-memory
   ============================================================ */
class LocalBroker {
  constructor(){
    this.kind = "local";
    this.clients = new Map();   // wsId → client
    this.rooms = new Map();     // roomId → Set<wsId>
    this.waiting = null;        // client или null
    this.stakes = new Map();    // matchId → stakes
    this.online = 0;
    this._onPair = () => {};
    this._onStats = () => {};
  }
  async init(){}
  generateWsId(){ return newId(); }
  registerClient(c){ this.clients.set(c.wsId, c); }
  unregisterClient(c){ this.clients.delete(c.wsId); }

  enqueue(c){
    // Защёлка: если waiting-клиент «зомби» (ws закрылся, но ws.on("close")
    // ещё не прокрутился и clearQueue не вызвался), не пытаемся его сопрячь.
    // Иначе pairLocal проверит readyState !== 1 и молча пропустит pair —
    // а обратившийся клиент упадёт в дыру (очередь пустая, таймер не
    // поставлен, pair не случился). Сбрасываем мёртвого и даём путь как
    // свежему waiter.
    if (this.waiting && !(this.waiting.ws && this.waiting.ws.readyState === 1)){
      this.waiting = null;
    }
    if (this.waiting && this.waiting.wsId !== c.wsId){
      const partner = this.waiting;
      this.waiting = null;
      return { kind: "local", partner };
    }
    this.waiting = c;
    return null;
  }
  dequeue(c){
    if (this.waiting && this.waiting.wsId === c.wsId) this.waiting = null;
  }

  joinRoom(roomId, c){
    let s = this.rooms.get(roomId);
    if (!s){ s = new Set(); this.rooms.set(roomId, s); }
    s.add(c.wsId);
  }
  leaveRoom(roomId, c){
    const s = this.rooms.get(roomId);
    if (!s) return;
    s.delete(c.wsId);
    if (s.size === 0) this.rooms.delete(roomId);
  }
  // Локальные клиенты, подписанные на комнату на ЭТОМ инстансе — нужны
  // серверу, чтобы после чужого leaveRoom сбросить у оставшегося ws.roomId/
  // activeMatchId (иначе следующий queue у него игнорится как "уже в матче").
  getLocalRoomClients(roomId){
    const s = this.rooms.get(roomId);
    if (!s) return [];
    const out = [];
    for (const wsId of s){
      const c = this.clients.get(wsId);
      if (c) out.push(c);
    }
    return out;
  }
  // Важно: в local-режиме ограничение на «не отправить самому себе» идёт по wsId,
  // а не по ссылке — ws может уходить/переподключаться, но wsId стабилен на коннект.
  publishRoom(roomId, senderId, frame){
    const s = this.rooms.get(roomId);
    if (!s) return;
    for (const wsId of s){
      if (wsId === senderId) continue;
      const c = this.clients.get(wsId);
      if (c && c.sendRaw) c.sendRaw(frame);
    }
  }

  onPairFromPeer(){ /* никогда не срабатывает в local */ }
  onStatsUpdate(cb){ this._onStats = cb; }

  incrOnline(){ this.online++; this._onStats && this._onStats(this.online); return this.online; }
  decrOnline(){ this.online = Math.max(0, this.online - 1); this._onStats && this._onStats(this.online); return this.online; }
  getOnline(){ return this.online; }

  setStakes(matchId, stakes, _ttlMs){
    stakes.createdAt = Date.now();
    this.stakes.set(matchId, stakes);
  }
  getStakes(matchId){ return this.stakes.get(matchId) || null; }
  claimOutcome(matchId, userId, outcome){
    const st = this.stakes.get(matchId);
    if (!st) return null;
    const field = outcome === "win" ? "winnerReportedBy" : "loserReportedBy";
    const opposite = outcome === "win" ? "loserReportedBy" : "winnerReportedBy";
    if (st[field]) return null;
    // Тот же юзер не может получить и win, и loss по одному матчу: если он уже
    // заявил обратный исход (например, пришёл match_win, а потом leaveRoom
    // пытается засчитать −loss), второй claim игнорируем.
    if (st[opposite] === userId) return null;
    st[field] = userId;
    const delta = outcome === "win" ? st.win : -st.loss;
    return { delta, win: st.win, loss: st.loss };
  }
  deleteStakes(matchId){ this.stakes.delete(matchId); }

  // GC старых ставок — в локальном режиме гоняем раз в минуту.
  startHousekeeping(ttlMs){
    setInterval(() => {
      const cutoff = Date.now() - ttlMs;
      for (const [k, v] of this.stakes){
        if ((v.createdAt || 0) < cutoff) this.stakes.delete(k);
      }
    }, 60 * 1000).unref();
  }
}

/* ============================================================
   RedisBroker — multi-instance
   ============================================================ */
class RedisBroker {
  constructor({ url, instanceId }){
    this.kind = "redis";
    this.url = url;
    this.instanceId = instanceId || newId(6);
    this.clients = new Map(); // wsId → local client
    this.localRooms = new Map(); // roomId → Set<wsId>
    this._onPair = () => {};
    this._onStats = () => {};
    this.pub = null;
    this.sub = null;
    this.INST_CHAN = `dv:inst:${this.instanceId}`;
    this.STATS_CHAN = "dv:stats";
    this.QUEUE_KEY  = "dv:queue";
    this.ONLINE_KEY = "dv:online";
    this.STAKES_PREFIX = "dv:stakes:";
    this.ROOM_PREFIX   = "dv:room:";
  }
  async init(){
    const { createClient } = require("redis");
    this.pub = createClient({ url: this.url });
    this.sub = this.pub.duplicate();
    this.pub.on("error", e => console.error("[broker] pub error:", e && e.message));
    this.sub.on("error", e => console.error("[broker] sub error:", e && e.message));
    await this.pub.connect();
    await this.sub.connect();

    // Канал для событий, адресованных нашему инстансу (pair-событие).
    await this.sub.subscribe(this.INST_CHAN, (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || !msg.type) return;
      if (msg.type === "pair") this._onPair(msg);
    });
    // Глобальный канал stats — пульс апдейтит раз в секунду любой инстанс,
    // а фронты получают по всем узлам.
    await this.sub.subscribe(this.STATS_CHAN, (raw) => {
      const total = parseInt(raw, 10) | 0;
      this._onStats(total);
    });

    console.log(`[broker] redis ready, instance=${this.instanceId}`);
  }

  generateWsId(){ return newId(); }
  registerClient(c){ this.clients.set(c.wsId, c); }
  unregisterClient(c){ this.clients.delete(c.wsId); }

  // Атомарный enqueue: если в очереди кто-то есть — LPOP его; иначе RPUSH
  // текущего. Redis однопоточный, EVAL гарантирует атомарность без гонок.
  async enqueue(c){
    const my = JSON.stringify({ wsId: c.wsId, userId: c.userId, instance: this.instanceId });
    const script = `
      local other = redis.call("LPOP", KEYS[1])
      if other then return other end
      redis.call("RPUSH", KEYS[1], ARGV[1])
      return nil
    `;
    const r = await this.pub.eval(script, { keys: [this.QUEUE_KEY], arguments: [my] });
    if (!r) return null;
    try {
      const p = JSON.parse(r);
      if (p.instance === this.instanceId){
        const partner = this.clients.get(p.wsId);
        if (partner) return { kind: "local", partner };
        // Партнёр «ушёл» между enqueue и pair — игнорируем, нас просто
        // пересунут в очередь выше по логике (caller это решает).
        return null;
      }
      return { kind: "remote", partner: p };
    } catch { return null; }
  }
  async dequeue(c){
    // LREM по сериализованной записи — O(N), но очередь короткая (ждущие, не
    // активные матчи). Для 10k одновременных матчей ждущих редко больше десятков.
    const my = JSON.stringify({ wsId: c.wsId, userId: c.userId, instance: this.instanceId });
    try { await this.pub.lRem(this.QUEUE_KEY, 0, my); } catch {}
  }

  async joinRoom(roomId, c){
    let s = this.localRooms.get(roomId);
    if (!s){
      s = new Set();
      this.localRooms.set(roomId, s);
      // Первый локальный клиент → две подписки: текстовая (peer_left и пр.)
      // и бинарная (снапшоты/инпут/эмоции). Разведены, чтобы бинарный канал
      // мог жить в bufferMode, а текстовый оставался обычной строкой — без
      // лишних Buffer→string конверсий на каждом кадре.
      const chanT = this.ROOM_PREFIX + "t:" + roomId;
      const chanB = this.ROOM_PREFIX + "b:" + roomId;
      await this.sub.subscribe(chanT, (raw) => this._onRoomFrame(roomId, raw, false));
      await this.sub.subscribe(chanB, (raw) => this._onRoomFrame(roomId, raw, true), true);
    }
    s.add(c.wsId);
  }
  async leaveRoom(roomId, c){
    const s = this.localRooms.get(roomId);
    if (!s) return;
    s.delete(c.wsId);
    if (s.size === 0){
      this.localRooms.delete(roomId);
      const chanT = this.ROOM_PREFIX + "t:" + roomId;
      const chanB = this.ROOM_PREFIX + "b:" + roomId;
      try { await this.sub.unsubscribe(chanT); } catch {}
      try { await this.sub.unsubscribe(chanB); } catch {}
    }
  }
  // Симметрично LocalBroker: возвращаем подписанных локально клиентов, чтобы
  // серверный leaveRoom мог сбросить roomId/activeMatchId у оставшегося пира.
  getLocalRoomClients(roomId){
    const s = this.localRooms.get(roomId);
    if (!s) return [];
    const out = [];
    for (const wsId of s){
      const c = this.clients.get(wsId);
      if (c) out.push(c);
    }
    return out;
  }

  _onRoomFrame(roomId, raw, isBinary){
    // Формат для обеих веток: первые 10 ASCII hex = senderWsId, затем ":",
    // дальше готовый фрейм для доставки (string либо Buffer). Это позволяет
    // не парсить содержимое при каждой доставке — мы знаем только
    // отправителя, чтобы не отправить ему эхо обратно.
    const s = this.localRooms.get(roomId);
    if (!s) return;
    let senderId, frame;
    if (isBinary){
      // raw — Buffer. Заголовок ровно 11 байт (10 hex + ':').
      if (raw.length < 11) return;
      senderId = raw.slice(0, 10).toString("ascii");
      frame = raw.slice(11);
    } else {
      const sep = raw.indexOf(":");
      if (sep < 0) return;
      senderId = raw.slice(0, sep);
      frame = raw.slice(sep + 1);
    }
    for (const wsId of s){
      if (wsId === senderId) continue;
      const c = this.clients.get(wsId);
      if (!c) continue;
      // peer_left, доставленный через Redis pub/sub с другого инстанса, —
      // признак того, что комната распалась. Чистим серверное состояние
      // локального пира, иначе его следующий queue будет отвергнут как
      // "уже в матче". Сниф через indexOf дешёвый (peer_left не встречается
      // в hot-path'ах relay/peer-снапшотах).
      if (!isBinary && typeof frame === "string" && frame.indexOf("peer_left") >= 0){
        try {
          const obj = JSON.parse(frame);
          if (obj && obj.type === "peer_left" && c.ws){
            // Освобождаем пира из комнаты: следующий queue должен работать.
            // activeMatchId оставляем — winner может дослать match_win без
            // matchId-в-пейлоаде, и сервер найдёт матч через этот флаг.
            c.ws.roomId = null;
          }
        } catch {}
      }
      if (c.sendRaw) c.sendRaw(frame);
    }
  }

  publishRoom(roomId, senderId, frame){
    // fire-and-forget — промахи по доставке не переспрашиваем (снапшоты 30Гц).
    // String → текстовый канал, Buffer → бинарный. Без JSON-слоя на горячем пути.
    if (typeof frame === "string"){
      const chan = this.ROOM_PREFIX + "t:" + roomId;
      this.pub.publish(chan, senderId + ":" + frame).catch(() => {});
    } else {
      const chan = this.ROOM_PREFIX + "b:" + roomId;
      const header = Buffer.from(senderId + ":", "ascii");
      const body = Buffer.isBuffer(frame) ? frame : Buffer.from(frame.buffer || frame);
      this.pub.publish(chan, Buffer.concat([header, body])).catch(() => {});
    }
  }

  onPairFromPeer(cb){ this._onPair = cb; }
  onStatsUpdate(cb){ this._onStats = cb; }

  async publishPair(targetInstanceId, payload){
    const chan = `dv:inst:${targetInstanceId}`;
    try { await this.pub.publish(chan, JSON.stringify({ type: "pair", ...payload })); } catch(e){ console.error("[broker] publishPair:", e); }
  }

  async incrOnline(){
    try {
      const n = await this.pub.incr(this.ONLINE_KEY);
      this.pub.publish(this.STATS_CHAN, String(n)).catch(() => {});
      return n;
    } catch { return 0; }
  }
  async decrOnline(){
    try {
      const n = await this.pub.decr(this.ONLINE_KEY);
      this.pub.publish(this.STATS_CHAN, String(Math.max(0, n))).catch(() => {});
      return Math.max(0, n);
    } catch { return 0; }
  }
  async getOnline(){
    try {
      const v = await this.pub.get(this.ONLINE_KEY);
      return parseInt(v || "0", 10) | 0;
    } catch { return 0; }
  }

  async setStakes(matchId, stakes, ttlMs){
    const key = this.STAKES_PREFIX + matchId;
    stakes.createdAt = Date.now();
    try { await this.pub.set(key, JSON.stringify(stakes), { PX: ttlMs }); } catch(e){ console.error("[broker] setStakes:", e); }
  }
  async getStakes(matchId){
    const key = this.STAKES_PREFIX + matchId;
    try {
      const raw = await this.pub.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  // Атомарный claim через Lua: ни win, ни loss не могут выдаться дважды
  // даже если два разных инстанса пришлют outcome одновременно.
  async claimOutcome(matchId, userId, outcome){
    const key = this.STAKES_PREFIX + matchId;
    const script = `
      local raw = redis.call("GET", KEYS[1])
      if not raw then return nil end
      local st = cjson.decode(raw)
      local field = (ARGV[2] == "win") and "winnerReportedBy" or "loserReportedBy"
      local opposite = (ARGV[2] == "win") and "loserReportedBy" or "winnerReportedBy"
      if st[field] then return nil end
      if st[opposite] == ARGV[1] then return nil end
      st[field] = ARGV[1]
      local ttl = redis.call("PTTL", KEYS[1])
      redis.call("SET", KEYS[1], cjson.encode(st))
      if ttl and ttl > 0 then redis.call("PEXPIRE", KEYS[1], ttl) end
      local d = (ARGV[2] == "win") and st.win or (-st.loss)
      return { d, st.win, st.loss }
    `;
    try {
      const r = await this.pub.eval(script, { keys: [key], arguments: [userId, outcome] });
      if (!Array.isArray(r)) return null;
      return { delta: Number(r[0]) | 0, win: Number(r[1]) | 0, loss: Number(r[2]) | 0 };
    } catch(e) { console.error("[broker] claimOutcome:", e); return null; }
  }
  async deleteStakes(matchId){
    const key = this.STAKES_PREFIX + matchId;
    try { await this.pub.del(key); } catch {}
  }

  // В Redis-режиме TTL встроен в SET EX, housekeeping не нужен.
  startHousekeeping(){}
}

async function createBroker({ redisUrl, instanceId }){
  if (redisUrl){
    const b = new RedisBroker({ url: redisUrl, instanceId });
    await b.init();
    return b;
  }
  const b = new LocalBroker();
  await b.init();
  return b;
}

module.exports = { createBroker, LocalBroker, RedisBroker };
