"use strict";
// Hathora Cloud REST wrapper — создать эфемерную room на Hathora и получить
// адрес, куда клиент должен открыть game-WS. Используется на Stage 7.2+ в
// server.js:pairHathora за DV_ROOMS=hathora.
//
// Документация: https://hathora.dev/api. Мы дергаем ровно два endpoint'а:
//   POST /rooms/v2/{appId}/create                  → { roomId }
//   GET  /rooms/v2/{appId}/connectioninfo/{roomId} → { status, exposedPort }
//
// Polling: create возвращает roomId моментально, но connectioninfo может
// какое-то время отдавать status="starting", пока Hathora тянет контейнер.
// Обёртка прячет этот polling и возвращает готовый {roomId, host, port}
// либо бросает — сверху (pairHathora) ловит ошибку и падает в pairLocal.
//
// Тестируется через HATHORA_API_BASE override — указываем на локальный
// mock-сервер вместо api.hathora.dev (см. tests/rooms-router.test.js).

const DEFAULT_API_BASE = "https://api.hathora.dev";
const POLL_INTERVAL_MS = Number(process.env.HATHORA_POLL_MS)    || 250;
const POLL_TIMEOUT_MS  = Number(process.env.HATHORA_POLL_TIMEOUT_MS) || 15000;
const FETCH_TIMEOUT_MS = Number(process.env.HATHORA_FETCH_TIMEOUT_MS) || 8000;

async function withTimeout(promise, ms, label){
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timer]); }
  finally { clearTimeout(t); }
}

async function createRoom(opts){
  const apiBase = (opts && opts.apiBase) || process.env.HATHORA_API_BASE || DEFAULT_API_BASE;
  const appId   = (opts && opts.appId)   || process.env.HATHORA_APP_ID;
  const token   = (opts && opts.token)   || process.env.HATHORA_TOKEN;
  // Регион прилетает per-call из geo-aware pairing в server.js. HATHORA_REGION
  // остаётся как fallback для интеграционных тестов и для случаев, когда
  // geo-lookup вернул null (приватный IP, отсутствие geoip-lite в dev-окружении).
  const region  = (opts && opts.region)  || process.env.HATHORA_REGION || "Frankfurt";
  const roomConfig = (opts && opts.roomConfig) || "";
  if (!appId) throw new Error("HATHORA_APP_ID required");
  if (!token) throw new Error("HATHORA_TOKEN required");

  const createUrl = `${apiBase}/rooms/v2/${encodeURIComponent(appId)}/create`;
  const createRes = await withTimeout(
    fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ region, roomConfig })
    }),
    FETCH_TIMEOUT_MS, "hathora create"
  );
  if (!createRes.ok){
    const text = await createRes.text().catch(() => "");
    throw new Error(`hathora create ${createRes.status}: ${text.slice(0, 200)}`);
  }
  const created = await createRes.json();
  const roomId = created && created.roomId;
  if (!roomId || typeof roomId !== "string"){
    throw new Error("hathora create: missing roomId");
  }

  const infoUrl = `${apiBase}/rooms/v2/${encodeURIComponent(appId)}/connectioninfo/${encodeURIComponent(roomId)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline){
    const infoRes = await withTimeout(
      fetch(infoUrl, { headers: { Authorization: `Bearer ${token}` } }),
      FETCH_TIMEOUT_MS, "hathora connectioninfo"
    );
    if (infoRes.ok){
      const info = await infoRes.json();
      if (info && info.status === "active" && info.exposedPort){
        const host = info.exposedPort.host;
        const port = Number(info.exposedPort.port);
        if (host && Number.isFinite(port)){
          return {
            roomId,
            host,
            port,
            transportType: info.exposedPort.transportType || "tcp"
          };
        }
      }
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`hathora connectioninfo timeout for room ${roomId}`);
}

module.exports = { createRoom };
