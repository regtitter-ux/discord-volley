/* Mock Discord auth (local).
   В продакшне этот модуль заменится вызовом OAuth через Discord-бота:
     GET /api/me  ->  { id, username, global_name, avatar_url }
   Контракт currentUser должен совпадать. */
(function(global){
  const KEY = "dv_user_v1";

  // Discord default avatar palette (те же цвета, что используются Discord)
  const DEFAULT_COLORS = ["#5865f2","#23a55a","#f0b232","#f23f42","#949ba4"];
  const NICK_PARTS_A = ["cool","fast","lucky","dark","neo","big","tiny","happy","mad","sly","brave","lazy","silent","wild","sunny"];
  const NICK_PARTS_B = ["fox","panda","wolf","cat","hawk","otter","bear","tiger","duck","shark","raven","owl","koala","lynx"];

  function rand(arr){ return arr[(Math.random()*arr.length)|0]; }
  function randInt(n){ return (Math.random()*n)|0; }

  // Пропускаем только https-URL с доверенных CDN Discord. Всё остальное
  // (javascript:, data:, чужие хосты) → null, тогда рендерится круг с буквой.
  // Важно: продовый ответ /api/me может прийти от скомпрометированного
  // прокси/бота, проверку нельзя перекладывать на клиентское доверие.
  const AVATAR_ALLOWED_HOSTS = /^(cdn|media)\.discordapp\.(net|com)$/i;
  function sanitizeAvatarUrl(url){
    if(!url || typeof url !== "string") return null;
    try{
      const u = new URL(url, location.href);
      if(u.protocol !== "https:") return null;
      if(!AVATAR_ALLOWED_HOSTS.test(u.hostname)) return null;
      return u.href;
    }catch(_){ return null; }
  }

  function makeMockUser(){
    const name = rand(NICK_PARTS_A) + rand(NICK_PARTS_B) + randInt(1000);
    return {
      id: "mock-" + Date.now(),
      username: name,
      global_name: name,
      avatar_url: null,
      color: rand(DEFAULT_COLORS)
    };
  }

  function makeBot(){
    // Имя без префикса "Bot" — префикс ("Бот"/"Bot") добавляется локализованно
    // при выводе в UI, см. I18n.t("bot.prefix") в game.js.
    const name = rand(NICK_PARTS_B);
    return {
      id: "bot",
      username: name,
      global_name: name,
      avatar_url: null,
      color: rand(DEFAULT_COLORS)
    };
  }

  function load(){
    try{ return JSON.parse(localStorage.getItem(KEY)) || null; }catch(_){ return null; }
  }
  function save(u){ try{ localStorage.setItem(KEY, JSON.stringify(u)); }catch(_){} }
  function clear(){ try{ localStorage.removeItem(KEY); }catch(_){} }

  // Отрисовка аватара: если есть URL — img, иначе цветной круг с первой буквой.
  function renderAvatarInto(el, user){
    el.innerHTML = "";
    const safeUrl = sanitizeAvatarUrl(user.avatar_url);
    if(safeUrl){
      const img = new Image();
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onerror = ()=>{
        // CDN отвалился / CORS / 403 — мягко откатываемся на круг с буквой.
        el.innerHTML = "";
        el.style.background = user.color || "#5865f2";
        el.textContent = (user.global_name || user.username || "?").charAt(0).toUpperCase();
      };
      img.src = safeUrl;
      el.appendChild(img);
    }else{
      el.style.background = user.color || "#5865f2";
      el.textContent = (user.global_name || user.username || "?").charAt(0).toUpperCase();
    }
  }

  global.Auth = {
    current: load,
    login: function(){
      // На проде: редирект на /oauth2/authorize и затем GET /api/me.
      const u = makeMockUser();
      save(u);
      return u;
    },
    logout: function(){ clear(); },
    makeBot: makeBot,
    renderAvatarInto: renderAvatarInto,
    sanitizeAvatarUrl: sanitizeAvatarUrl
  };
})(window);
