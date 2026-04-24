"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const R = require("../hathora-regions.js");

test("regionForCountry: базовое покрытие континентов", () => {
  assert.equal(R.regionForCountry("US"), R.REGIONS.CHICAGO);
  assert.equal(R.regionForCountry("DE"), R.REGIONS.FRANKFURT);
  assert.equal(R.regionForCountry("JP"), R.REGIONS.TOKYO);
  assert.equal(R.regionForCountry("AU"), R.REGIONS.SYDNEY);
  assert.equal(R.regionForCountry("BR"), R.REGIONS.SAO_PAULO);
  assert.equal(R.regionForCountry("IN"), R.REGIONS.MUMBAI);
  assert.equal(R.regionForCountry("AE"), R.REGIONS.DUBAI);
  assert.equal(R.regionForCountry("ZA"), R.REGIONS.JOHANNESBURG);
  assert.equal(R.regionForCountry("SG"), R.REGIONS.SINGAPORE);
  // Нижний регистр тоже принимаем — CDN-хедеры иногда отдают lowercase.
  assert.equal(R.regionForCountry("de"), R.REGIONS.FRANKFURT);
  // Не покрыто → null, caller падает в fallback.
  assert.equal(R.regionForCountry("ZZ"), null);
  assert.equal(R.regionForCountry(""),   null);
  assert.equal(R.regionForCountry(null), null);
});

test("meetingRegion: одинаковый регион → он же", () => {
  assert.equal(
    R.meetingRegion(R.REGIONS.FRANKFURT, R.REGIONS.FRANKFURT, R.REGIONS.LONDON),
    R.REGIONS.FRANKFURT
  );
});

test("meetingRegion: гетерогенные пары — компромисс", () => {
  // EU ↔ US → London (симметрично по TAT через атлантику).
  assert.equal(
    R.meetingRegion(R.REGIONS.CHICAGO, R.REGIONS.FRANKFURT, R.REGIONS.FRANKFURT),
    R.REGIONS.LONDON
  );
  // US-West ↔ Asia → Seattle/Tokyo (через Pacific).
  assert.equal(
    R.meetingRegion(R.REGIONS.SEATTLE, R.REGIONS.TOKYO, R.REGIONS.FRANKFURT),
    R.REGIONS.SEATTLE
  );
  // EU ↔ Asia → Mumbai (середина).
  assert.equal(
    R.meetingRegion(R.REGIONS.FRANKFURT, R.REGIONS.TOKYO, R.REGIONS.FRANKFURT),
    R.REGIONS.MUMBAI
  );
  // Oceania ↔ EU — без прямого канала в матрице? Проверим, что выбор
  // детерминирован и в один из включённых регионов (Singapore).
  assert.equal(
    R.meetingRegion(R.REGIONS.SYDNEY, R.REGIONS.FRANKFURT, R.REGIONS.FRANKFURT),
    R.REGIONS.SINGAPORE
  );
});

test("meetingRegion: null в аргументе → берём известный регион", () => {
  assert.equal(
    R.meetingRegion(null, R.REGIONS.TOKYO, R.REGIONS.FRANKFURT),
    R.REGIONS.TOKYO
  );
  assert.equal(
    R.meetingRegion(R.REGIONS.LONDON, null, R.REGIONS.FRANKFURT),
    R.REGIONS.LONDON
  );
});

test("meetingRegion: оба null → fallback", () => {
  assert.equal(
    R.meetingRegion(null, null, R.REGIONS.FRANKFURT),
    R.REGIONS.FRANKFURT
  );
});

test("meetingRegion: незнакомая пара регионов → fallback", () => {
  // Искусственная пара, которой нет в FALLBACK_MATRIX: Washington_DC + Dubai.
  assert.equal(
    R.meetingRegion(R.REGIONS.WASHINGTON_DC, R.REGIONS.DUBAI, R.REGIONS.LONDON),
    R.REGIONS.LONDON
  );
});

test("resolveClientIp: приоритет X-Forwarded-For, затем X-Real-IP, затем socket", () => {
  // Railway/Vercel/Fly кладут клиентский IP первым в X-Forwarded-For.
  const req1 = { headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.1" }, socket: { remoteAddress: "172.16.0.1" } };
  assert.equal(R.resolveClientIp(req1), "8.8.8.8");

  // Nginx без XFF — часто X-Real-IP.
  const req2 = { headers: { "x-real-ip": "1.2.3.4" }, socket: { remoteAddress: "172.16.0.1" } };
  assert.equal(R.resolveClientIp(req2), "1.2.3.4");

  // Прямой коннект — только socket.remoteAddress.
  const req3 = { headers: {}, socket: { remoteAddress: "4.3.2.1" } };
  assert.equal(R.resolveClientIp(req3), "4.3.2.1");

  // IPv4-mapped IPv6 → голый IPv4.
  const req4 = { headers: {}, socket: { remoteAddress: "::ffff:8.8.4.4" } };
  assert.equal(R.resolveClientIp(req4), "8.8.4.4");

  // Null-safe.
  assert.equal(R.resolveClientIp(null), null);
  assert.equal(R.resolveClientIp({ headers: {} }), null);
});

test("resolveCountry: CDN-хедеры имеют приоритет над geoip lookup", () => {
  // Cloudflare — уже посчитал страну, мы не тратим geoip-lite.
  const req = { headers: { "cf-ipcountry": "JP", "x-forwarded-for": "8.8.8.8" } };
  assert.equal(R.resolveCountry(req, "8.8.8.8"), "JP");

  // XX / T1 — «неизвестно» / Tor, игнорируем.
  const reqXX = { headers: { "cf-ipcountry": "XX" } };
  const ccXX  = R.resolveCountry(reqXX, null);
  assert.equal(ccXX, null);

  const reqT1 = { headers: { "cf-ipcountry": "T1" } };
  assert.equal(R.resolveCountry(reqT1, null), null);

  // CloudFront, Vercel, Fastly — те же семантики.
  assert.equal(R.resolveCountry({ headers: { "cloudfront-viewer-country": "BR" } }, null), "BR");
  assert.equal(R.resolveCountry({ headers: { "x-vercel-ip-country": "AU" } }, null),       "AU");
  assert.equal(R.resolveCountry({ headers: { "fastly-client-country-code": "de" } }, null), "DE");
});

test("pickRegionForPair: полный flow с двумя странами", () => {
  // US ↔ DE — гетерогенная пара, компромисс = London.
  const pick = R.pickRegionForPair({ hostCountry: "US", guestCountry: "DE", fallback: R.REGIONS.FRANKFURT });
  assert.equal(pick.region,       R.REGIONS.LONDON);
  assert.equal(pick.hostRegion,   R.REGIONS.CHICAGO);
  assert.equal(pick.guestRegion,  R.REGIONS.FRANKFURT);
  assert.equal(pick.hostCountry,  "US");
  assert.equal(pick.guestCountry, "DE");
});

test("pickRegionForPair: оба null → fallback", () => {
  const pick = R.pickRegionForPair({ hostCountry: null, guestCountry: null, fallback: R.REGIONS.FRANKFURT });
  assert.equal(pick.region, R.REGIONS.FRANKFURT);
  assert.equal(pick.hostRegion,  null);
  assert.equal(pick.guestRegion, null);
});

test("pickRegionForPair: одинаковые страны → региональный хоум", () => {
  const pick = R.pickRegionForPair({ hostCountry: "JP", guestCountry: "KR", fallback: R.REGIONS.FRANKFURT });
  // Оба мапаются в Tokyo.
  assert.equal(pick.region, R.REGIONS.TOKYO);
});
