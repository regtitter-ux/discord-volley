"use strict";
// Multi-region Hathora routing: country-code → preferred edge и выбор
// «встречного» региона для пары игроков. Пара двух US-игроков уходит в
// Chicago, EU-EU в Frankfurt; гетерогенные пары (EU↔Asia, US↔Asia) получают
// компромиссный регион из FALLBACK_MATRIX, который даёт минимум max-RTT.
//
// Источник country-кода: сначала CDN-хедеры (CF-IPCountry, Fastly-Geo,
// CloudFront-Viewer-Country) — бесплатно и без локальных DB. Если их нет —
// geoip-lite lookup по X-Forwarded-For. Для приватных/loopback IP lookup
// возвращает null и мы падаем в FALLBACK_REGION.
//
// Hathora regions (на 2026-04): Seattle, Los_Angeles, Chicago, Washington_DC,
// Sao_Paulo, London, Frankfurt, Mumbai, Singapore, Tokyo, Sydney, Dubai,
// Johannesburg. Меняем по мере того, как Hathora добавляет регионы — в их
// dashboard сами ничего включать/выключать не надо, Cloud API принимает
// имя региона, деплой стартует в нужном edge.

const REGIONS = Object.freeze({
  SEATTLE:       "Seattle",
  LOS_ANGELES:   "Los_Angeles",
  CHICAGO:       "Chicago",
  WASHINGTON_DC: "Washington_DC",
  SAO_PAULO:     "Sao_Paulo",
  LONDON:        "London",
  FRANKFURT:     "Frankfurt",
  DUBAI:         "Dubai",
  MUMBAI:        "Mumbai",
  SINGAPORE:     "Singapore",
  TOKYO:         "Tokyo",
  SYDNEY:        "Sydney",
  JOHANNESBURG:  "Johannesburg"
});

// Country (ISO 3166-1 alpha-2) → лучший Hathora-регион. Покрытие не
// исчерпывающее — не покрытая страна → null → падаем в fallback.
const COUNTRY_TO_REGION = {
  // North America — Central (умолчание для US, для west-coast отдельная
  // логика под штаты пока не реализована: geoip-lite отдаёт country, не state.
  // Можно добавить ipinfo или maxmind city-DB позже).
  US: REGIONS.CHICAGO, CA: REGIONS.CHICAGO,
  MX: REGIONS.LOS_ANGELES, GT: REGIONS.LOS_ANGELES, CR: REGIONS.LOS_ANGELES,
  PA: REGIONS.LOS_ANGELES, CU: REGIONS.LOS_ANGELES, DO: REGIONS.LOS_ANGELES,

  // South America
  BR: REGIONS.SAO_PAULO, AR: REGIONS.SAO_PAULO, CL: REGIONS.SAO_PAULO,
  CO: REGIONS.SAO_PAULO, PE: REGIONS.SAO_PAULO, VE: REGIONS.SAO_PAULO,
  UY: REGIONS.SAO_PAULO, BO: REGIONS.SAO_PAULO, PY: REGIONS.SAO_PAULO,
  EC: REGIONS.SAO_PAULO,

  // Europe — West (London)
  GB: REGIONS.LONDON, IE: REGIONS.LONDON, PT: REGIONS.LONDON,
  ES: REGIONS.LONDON, FR: REGIONS.LONDON, BE: REGIONS.LONDON,
  NL: REGIONS.LONDON, LU: REGIONS.LONDON, IS: REGIONS.LONDON,

  // Europe — Central/East (Frankfurt)
  DE: REGIONS.FRANKFURT, AT: REGIONS.FRANKFURT, CH: REGIONS.FRANKFURT,
  IT: REGIONS.FRANKFURT, PL: REGIONS.FRANKFURT, CZ: REGIONS.FRANKFURT,
  SK: REGIONS.FRANKFURT, SI: REGIONS.FRANKFURT, HR: REGIONS.FRANKFURT,
  HU: REGIONS.FRANKFURT, RO: REGIONS.FRANKFURT, BG: REGIONS.FRANKFURT,
  SE: REGIONS.FRANKFURT, NO: REGIONS.FRANKFURT, FI: REGIONS.FRANKFURT,
  DK: REGIONS.FRANKFURT, EE: REGIONS.FRANKFURT, LV: REGIONS.FRANKFURT,
  LT: REGIONS.FRANKFURT, RU: REGIONS.FRANKFURT, UA: REGIONS.FRANKFURT,
  BY: REGIONS.FRANKFURT, MD: REGIONS.FRANKFURT, GE: REGIONS.FRANKFURT,
  AM: REGIONS.FRANKFURT, AZ: REGIONS.FRANKFURT, TR: REGIONS.FRANKFURT,
  GR: REGIONS.FRANKFURT, CY: REGIONS.FRANKFURT, MT: REGIONS.FRANKFURT,
  RS: REGIONS.FRANKFURT, BA: REGIONS.FRANKFURT, MK: REGIONS.FRANKFURT,
  AL: REGIONS.FRANKFURT,

  // East Asia (Tokyo)
  JP: REGIONS.TOKYO, KR: REGIONS.TOKYO, TW: REGIONS.TOKYO,
  HK: REGIONS.TOKYO, CN: REGIONS.TOKYO, MN: REGIONS.TOKYO,
  MO: REGIONS.TOKYO,

  // South-East Asia (Singapore)
  SG: REGIONS.SINGAPORE, MY: REGIONS.SINGAPORE, TH: REGIONS.SINGAPORE,
  VN: REGIONS.SINGAPORE, PH: REGIONS.SINGAPORE, ID: REGIONS.SINGAPORE,
  KH: REGIONS.SINGAPORE, LA: REGIONS.SINGAPORE, MM: REGIONS.SINGAPORE,
  BN: REGIONS.SINGAPORE,

  // South Asia (Mumbai)
  IN: REGIONS.MUMBAI, PK: REGIONS.MUMBAI, BD: REGIONS.MUMBAI,
  LK: REGIONS.MUMBAI, NP: REGIONS.MUMBAI, BT: REGIONS.MUMBAI,
  MV: REGIONS.MUMBAI, AF: REGIONS.MUMBAI,

  // Middle East (Dubai)
  AE: REGIONS.DUBAI, SA: REGIONS.DUBAI, IR: REGIONS.DUBAI,
  IQ: REGIONS.DUBAI, IL: REGIONS.DUBAI, JO: REGIONS.DUBAI,
  LB: REGIONS.DUBAI, SY: REGIONS.DUBAI, YE: REGIONS.DUBAI,
  OM: REGIONS.DUBAI, QA: REGIONS.DUBAI, BH: REGIONS.DUBAI,
  KW: REGIONS.DUBAI, EG: REGIONS.DUBAI, KZ: REGIONS.DUBAI,
  UZ: REGIONS.DUBAI, TM: REGIONS.DUBAI, TJ: REGIONS.DUBAI,
  KG: REGIONS.DUBAI,

  // Africa (Johannesburg)
  ZA: REGIONS.JOHANNESBURG, NG: REGIONS.JOHANNESBURG, KE: REGIONS.JOHANNESBURG,
  ET: REGIONS.JOHANNESBURG, TZ: REGIONS.JOHANNESBURG, UG: REGIONS.JOHANNESBURG,
  GH: REGIONS.JOHANNESBURG, DZ: REGIONS.JOHANNESBURG, MA: REGIONS.JOHANNESBURG,
  TN: REGIONS.JOHANNESBURG, LY: REGIONS.JOHANNESBURG, SD: REGIONS.JOHANNESBURG,
  SN: REGIONS.JOHANNESBURG, CI: REGIONS.JOHANNESBURG, CM: REGIONS.JOHANNESBURG,
  ZM: REGIONS.JOHANNESBURG, ZW: REGIONS.JOHANNESBURG, MZ: REGIONS.JOHANNESBURG,
  AO: REGIONS.JOHANNESBURG, MG: REGIONS.JOHANNESBURG, RW: REGIONS.JOHANNESBURG,

  // Oceania (Sydney)
  AU: REGIONS.SYDNEY, NZ: REGIONS.SYDNEY, FJ: REGIONS.SYDNEY,
  PG: REGIONS.SYDNEY, NC: REGIONS.SYDNEY, SB: REGIONS.SYDNEY
};

// FALLBACK_MATRIX: ключ — два региона отсортированы alphabet'ом и склеены
// "|", значение — регион, в котором играем гетерогенную пару. Выбор из
// принципа: min(max(rtt_a, rtt_b)) по тройке player1↔server, player2↔server.
// Там, где выбор неоднозначен (например, US↔EU), предпочитаем хост, который
// ближе к «середине» трасс (Chicago / London).
const FALLBACK_MATRIX = {
  // US ↔ EU: London даёт ~40ms US-East + ~10ms EU ≈ симметричнее Chicago/Frankfurt.
  "Chicago|Frankfurt":       REGIONS.LONDON,
  "Chicago|London":          REGIONS.CHICAGO,
  "Frankfurt|Los_Angeles":   REGIONS.CHICAGO,
  "Frankfurt|Seattle":       REGIONS.CHICAGO,
  "London|Los_Angeles":      REGIONS.CHICAGO,
  "Frankfurt|London":        REGIONS.FRANKFURT,
  "Chicago|Seattle":         REGIONS.CHICAGO,
  "Chicago|Los_Angeles":     REGIONS.CHICAGO,

  // US ↔ Asia: Seattle — шлюз к Tokyo/Singapore.
  "Seattle|Tokyo":           REGIONS.SEATTLE,
  "Seattle|Singapore":       REGIONS.TOKYO,
  "Chicago|Tokyo":           REGIONS.SEATTLE,
  "Chicago|Singapore":       REGIONS.TOKYO,
  "Los_Angeles|Tokyo":       REGIONS.LOS_ANGELES,
  "Los_Angeles|Singapore":   REGIONS.TOKYO,

  // EU ↔ Asia: Mumbai — географическая середина.
  "Frankfurt|Tokyo":          REGIONS.MUMBAI,
  "Frankfurt|Singapore":      REGIONS.MUMBAI,
  "Frankfurt|Mumbai":         REGIONS.DUBAI,
  "London|Tokyo":             REGIONS.MUMBAI,
  "London|Singapore":         REGIONS.MUMBAI,
  "London|Mumbai":            REGIONS.DUBAI,

  // Asia внутри
  "Singapore|Tokyo":          REGIONS.TOKYO,
  "Mumbai|Singapore":         REGIONS.SINGAPORE,
  "Mumbai|Tokyo":             REGIONS.SINGAPORE,

  // Oceania
  "Sydney|Tokyo":             REGIONS.TOKYO,
  "Singapore|Sydney":         REGIONS.SINGAPORE,
  "Sydney|Los_Angeles":       REGIONS.SYDNEY,
  "Frankfurt|Sydney":         REGIONS.SINGAPORE,
  "Chicago|Sydney":           REGIONS.LOS_ANGELES,

  // South America
  "Chicago|Sao_Paulo":        REGIONS.CHICAGO,
  "Frankfurt|Sao_Paulo":      REGIONS.SAO_PAULO,
  "London|Sao_Paulo":         REGIONS.SAO_PAULO,
  "Los_Angeles|Sao_Paulo":    REGIONS.LOS_ANGELES,
  "Sao_Paulo|Seattle":        REGIONS.LOS_ANGELES,

  // Middle East / Africa
  "Dubai|Frankfurt":          REGIONS.FRANKFURT,
  "Dubai|London":             REGIONS.FRANKFURT,
  "Dubai|Mumbai":             REGIONS.MUMBAI,
  "Dubai|Singapore":          REGIONS.MUMBAI,
  "Dubai|Tokyo":              REGIONS.SINGAPORE,
  "Frankfurt|Johannesburg":   REGIONS.FRANKFURT,
  "Johannesburg|London":      REGIONS.FRANKFURT,
  "Dubai|Johannesburg":       REGIONS.DUBAI,
  "Johannesburg|Mumbai":      REGIONS.DUBAI,
  "Johannesburg|Sao_Paulo":   REGIONS.JOHANNESBURG
};

// Резольвер geoip: грузим geoip-lite лениво. Если пакет не установлен
// (dev-setup без npm install), просто возвращаем null — fallback-регион
// всё равно сработает.
let _geoip = null;
let _geoipChecked = false;
function _loadGeoip(){
  if (_geoipChecked) return _geoip;
  _geoipChecked = true;
  try { _geoip = require("geoip-lite"); }
  catch { _geoip = null; }
  return _geoip;
}

// resolveClientIp(req): извлекаем «реальный» IP клиента из upgrade-запроса.
// Railway, Cloudflare и прочие reverse-proxy кладут IP клиента первым в
// X-Forwarded-For. При прямом коннекте падаем в socket.remoteAddress.
function resolveClientIp(req){
  if (!req) return null;
  const h = req.headers || {};
  const xff = h["x-forwarded-for"] || h["X-Forwarded-For"];
  if (xff){
    const first = String(xff).split(",")[0].trim();
    if (first) return _normalizeIp(first);
  }
  const real = h["x-real-ip"];
  if (real) return _normalizeIp(String(real).trim());
  const sock = req.socket && req.socket.remoteAddress;
  return sock ? _normalizeIp(String(sock)) : null;
}
function _normalizeIp(ip){
  // IPv4-mapped IPv6 → голый IPv4 (geoip-lite понимает только клеан).
  if (ip && ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

// resolveCountry(req, ip): сначала пробуем CDN-хедеры (O(1), no DB), затем
// geoip-lite. Для localhost/private IP возвращаем null — сервер уйдёт в
// fallback-регион.
function resolveCountry(req, ip){
  if (req && req.headers){
    const h = req.headers;
    const cdn = h["cf-ipcountry"]
             || h["cloudfront-viewer-country"]
             || h["x-vercel-ip-country"]
             || h["fastly-client-country-code"];
    if (cdn && typeof cdn === "string" && /^[A-Z]{2}$/i.test(cdn.trim())){
      const cc = cdn.trim().toUpperCase();
      // XX и T1 (Tor exit) — нечитаемый geo, пропускаем.
      if (cc !== "XX" && cc !== "T1") return cc;
    }
  }
  if (!ip) return null;
  const geo = _loadGeoip();
  if (!geo) return null;
  try {
    const rec = geo.lookup(ip);
    return rec && rec.country ? rec.country : null;
  } catch { return null; }
}

function regionForCountry(cc){
  if (!cc || typeof cc !== "string") return null;
  return COUNTRY_TO_REGION[cc.toUpperCase()] || null;
}

// meetingRegion(rA, rB, fallback): если оба в одном регионе — он и есть
// оптимум. Иначе ищем в FALLBACK_MATRIX, ключ — отсортированный «a|b».
// Если пары нет в матрице (две незнакомых страны) — fallback, но лог-варнинг
// пусть сверху делает caller, чтобы матрицу можно было дозаполнять.
function meetingRegion(rA, rB, fallback){
  if (!rA && !rB) return fallback;
  if (!rA) return rB;
  if (!rB) return rA;
  if (rA === rB) return rA;
  const key = [rA, rB].sort().join("|");
  return FALLBACK_MATRIX[key] || fallback;
}

// pickRegionForPair({hostReq, hostIp, hostCountry, guestReq, guestIp,
// guestCountry, fallback}) — удобная обёртка, которая разом делает
// lookup + выбор. Нужна, чтобы в server.js/pairHathora был один вызов.
function pickRegionForPair(opts){
  const fallback = (opts && opts.fallback) || REGIONS.FRANKFURT;
  const ccA = opts && (opts.hostCountry
    || resolveCountry(opts.hostReq, opts.hostIp));
  const ccB = opts && (opts.guestCountry
    || resolveCountry(opts.guestReq, opts.guestIp));
  const rA = regionForCountry(ccA);
  const rB = regionForCountry(ccB);
  const region = meetingRegion(rA, rB, fallback);
  return { region, hostCountry: ccA || null, guestCountry: ccB || null,
           hostRegion: rA || null, guestRegion: rB || null };
}

module.exports = {
  REGIONS,
  COUNTRY_TO_REGION,
  FALLBACK_MATRIX,
  resolveClientIp,
  resolveCountry,
  regionForCountry,
  meetingRegion,
  pickRegionForPair
};
