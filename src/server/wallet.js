"use strict";

/* Wallet (монеты) + Trophies/match-stakes (кубки).
   Server-authoritative. Размеры наград, рейт-лимиты и global-cooldowns
   живут тут, а не на клиенте — правка клиента ни на что не влияет.

   Принимает { DB, getBroker } как зависимости через фабрику.
   `getBroker` — lazy-getter: broker создаётся в server.js позже модуля,
   так что храним ссылку на callable, а не сам объект. */

const TROPHY_WIN_MIN  = 20, TROPHY_WIN_MAX  = 35;
const TROPHY_LOSS_MIN = 25, TROPHY_LOSS_MAX = 40;
const MATCH_STAKES_TTL_MS = 15 * 60 * 1000;

// Env-оверрайды оставлены для интеграционных тестов: поднимать per-match
// cap или 30с global cooldown на живом сервере на время теста дешевле и
// честнее, чем мокать awardCoins. В проде env не задан — работают дефолты.
const AWARDS = {
  "rally.hit":   { amount: 1,  minGapMs: 250,  maxPerMatch: Number(process.env.WALLET_RALLY_MAX) || 200 },
  "rally.combo": { amount: 0,  minGapMs: 400,  maxPerMatch: 40, fromContext: true },
  "round.win":   { amount: 5,  minGapMs: 500,  maxPerMatch: 100 },
  "match.win":   { amount: 50, minGapMs: 1000, maxPerMatch: 1,  globalGapMs: Number(process.env.WALLET_MATCHWIN_GLOBAL_MS) || 30000 }
};

function randInt(min, max){ return min + Math.floor(Math.random() * (max - min + 1)); }

module.exports = function createWallet({ DB, getBroker }){
  // userId → { kind → { lastAt, count, matchId } } + _lastMatchWinAt
  const userRates = new Map();

  // userRates растёт линейно по числу уникальных юзеров за время аптайма
  // и никогда не освобождается. Раз в 5 минут выкидываем записи, где
  // последняя активность старше часа — кулдауны за это время истекли.
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

  function rollStakes(){
    return {
      win:  randInt(TROPHY_WIN_MIN,  TROPHY_WIN_MAX),
      loss: randInt(TROPHY_LOSS_MIN, TROPHY_LOSS_MAX),
      winnerReportedBy: null,
      loserReportedBy:  null
    };
  }

  // Атомарный claim через broker: под Redis это Lua-скрипт, гарантирующий,
  // что даже два инстанса не смогут выплатить win/loss дважды. Под
  // LocalBroker — проверка поля на in-memory записи.
  async function applyMatchOutcome(userObj, matchId, outcome){
    const broker = getBroker();
    const r = await broker.claimOutcome(matchId, userObj.id, outcome);
    if (!r) return null;
    const total = DB.addTrophies(userObj, r.delta);
    console.log(`[lb] ${outcome} ${userObj.id} Δ${r.delta} → ${total}`);
    return { total, delta: r.delta };
  }

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

  return {
    AWARDS,
    MATCH_STAKES_TTL_MS,
    rollStakes,
    applyMatchOutcome,
    awardCoins,
    userCoins:    (id) => DB.getCoins(id),
    userTrophies: (id) => DB.getTrophies(id),
  };
};
