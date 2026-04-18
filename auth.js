/* Real Discord OAuth2 client — тонкая обёртка над серверными ручками.
     Auth.current()  -> Promise<User|null>   (GET  /api/me)
     Auth.login()    -> redirect             (    /auth/discord)
     Auth.logout()   -> Promise              (POST /auth/logout)
   Контракт User: { id, username, global_name, avatar_url, color } */
(function(global){
  const DEFAULT_COLORS = ["#5865f2","#23a55a","#f0b232","#f23f42","#949ba4"];
  const NICK_PARTS_B = ["fox","panda","wolf","cat","hawk","otter","bear","tiger","duck","shark","raven","owl","koala","lynx"];

  function rand(arr){ return arr[(Math.random()*arr.length)|0]; }

  // Пропускаем только https-URL с доверенных CDN Discord. Всё остальное
  // (javascript:, data:, чужие хосты) → null, тогда рендерится круг с буквой.
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

  // Стабильный цвет по id — у одного юзера всегда один и тот же круг,
  // у разных — разные. Нужен на случай, когда avatar_url пустой.
  function colorFor(u){
    const seed = String((u && u.id) || "");
    let h = 0;
    for(let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return DEFAULT_COLORS[Math.abs(h) % DEFAULT_COLORS.length];
  }

  function normalize(u){
    if(!u || !u.id) return null;
    const out = {
      id:          u.id,
      username:    u.username,
      global_name: u.global_name || u.username,
      avatar_url:  u.avatar_url || null,
      color:       colorFor(u)
    };
    // Пропускаем coins / trophies, если сервер их вернул (только /api/me).
    // Для нормализации opponent-объектов этих полей нет — и это ок.
    if(typeof u.coins    === "number") out.coins    = u.coins | 0;
    if(typeof u.trophies === "number") out.trophies = u.trophies | 0;
    // decoration — объект с параметрами атласа (atlas, frames, cols, rows,
    // frameW, frameH, fps). Приходит с /api/me и с хеллоу в матче.
    if(u.decoration && typeof u.decoration === "object" && typeof u.decoration.atlas === "string"){
      out.decoration = {
        id:     String(u.decoration.id || ""),
        atlas:  u.decoration.atlas,
        frames: u.decoration.frames | 0,
        cols:   u.decoration.cols   | 0,
        rows:   u.decoration.rows   | 0,
        frameW: u.decoration.frameW | 0,
        frameH: u.decoration.frameH | 0,
        fps:    u.decoration.fps    | 0
      };
    }
    return out;
  }

  async function current(){
    try{
      const r = await fetch("/api/me", {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
      });
      if(r.status === 401) return null;
      if(!r.ok) return null;
      const data = await r.json();
      return normalize(data);
    }catch(_){
      return null;
    }
  }

  function login(){
    // Передаём управление серверу — он редиректнет на discord.com.
    location.href = "/auth/discord";
  }

  async function logout(){
    try{
      await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    }catch(_){ /* даже если упало, UI возвращает на login */ }
  }

  function makeBot(){
    const name = rand(NICK_PARTS_B);
    const u = {
      id: "bot-" + Math.random().toString(36).slice(2,8),
      username: name,
      global_name: name,
      avatar_url: null
    };
    return { ...u, color: colorFor(u) };
  }

  // Отрисовка аватара: если есть URL — img, иначе цветной круг с первой буквой.
  // Если у юзера задано decoration (объект { atlas, frameW, frameH, cols, rows,
  // frames, fps }), добавляем сверху .avatar-deco слой — общий rAF-цикл в
  // game.js (DecoAnim) листает кадры через background-position.
  function renderAvatarInto(el, user){
    el.innerHTML = "";
    el.style.background = "";
    el.classList.remove("has-deco");
    const safeUrl = sanitizeAvatarUrl(user && user.avatar_url);
    if(safeUrl){
      const img = new Image();
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.onerror = ()=>{
        const hadDeco = el.classList.contains("has-deco");
        el.innerHTML = "";
        el.style.background = (user && user.color) || "#5865f2";
        el.textContent = ((user && (user.global_name || user.username)) || "?").charAt(0).toUpperCase();
        if(hadDeco && user && user.decoration) attachDecoration(el, user.decoration);
      };
      img.src = safeUrl;
      el.appendChild(img);
    }else{
      el.style.background = (user && user.color) || "#5865f2";
      el.textContent = ((user && (user.global_name || user.username)) || "?").charAt(0).toUpperCase();
    }
    if(user && user.decoration) attachDecoration(el, user.decoration);
  }

  // Добавляет (или заменяет) .avatar-deco-слой внутри контейнера. Сам рендер
  // анимации — централизованный rAF-цикл в game.js; этот модуль только
  // выставляет CSS-переменные под атлас, ставит data-frames/fps и отдаёт
  // узел на учёт тиккеру.
  function attachDecoration(el, d){
    if(!el || !d || !d.atlas) return;
    el.classList.add("has-deco");
    let layer = el.querySelector(".avatar-deco");
    if(!layer){
      layer = document.createElement("div");
      layer.className = "avatar-deco";
      el.appendChild(layer);
    }
    layer.style.setProperty("--deco-atlas",   `url("${d.atlas}")`);
    layer.style.setProperty("--deco-bg-size", `${(d.cols|0)*100}% ${(d.rows|0)*100}%`);
    layer.dataset.frames = String(d.frames|0);
    layer.dataset.cols   = String(d.cols|0);
    layer.dataset.rows   = String(d.rows|0);
    layer.dataset.fps    = String(d.fps|0);
    if(typeof window.DecoAnim === "object" && typeof window.DecoAnim.attach === "function"){
      window.DecoAnim.attach(layer);
    }
  }

  global.Auth = {
    current,
    login,
    logout,
    makeBot,
    normalize,
    renderAvatarInto,
    attachDecoration,
    sanitizeAvatarUrl
  };
})(window);
