/* Decorations UI ----------------
   UI для покупки и выбора украшений аватара. Каталог и состояние
   (owned / selected / coins) берём из /api/decorations; покупка и выбор —
   POST-ручки с query-параметром id. Сервер — единственный авторитет:
   клиентская сумма монет никогда не передаётся, цену и валидность id
   сервер проверяет сам. */
(function(){
  "use strict";
  const $ = (id) => document.getElementById(id);

  let catalog = null;
  let owned = [];
  let selected = null;
  const modal = $("decorations-modal");
  const list  = $("decorations-list");

  async function open(){
    modal.classList.remove("hidden");
    await refresh();
  }
  function close(){ modal.classList.add("hidden"); }

  async function refresh(){
    try{
      const r = await fetch("/api/decorations", { credentials: "same-origin" });
      if(!r.ok){ renderError(); return; }
      const j = await r.json();
      catalog  = Array.isArray(j.catalog) ? j.catalog : [];
      owned    = Array.isArray(j.owned)   ? j.owned   : [];
      selected = j.selected || null;
      if(typeof j.coins === "number") Wallet.set(j.coins, 0);
      render();
    }catch(_){ renderError(); }
  }

  function renderError(){
    list.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.style.textAlign = "center";
    msg.style.padding = "16px";
    msg.textContent = "—";
    list.appendChild(msg);
  }

  function render(){
    list.innerHTML = "";
    list.appendChild(rowNone());
    for(const d of catalog) list.appendChild(rowDeco(d));
  }

  function rowNone(){
    const row = document.createElement("div");
    row.className = "deco-row";
    if(!selected) row.classList.add("is-selected");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;

    const thumb = document.createElement("div");
    thumb.className = "avatar deco-thumb";
    // Превью: сам аватар юзера без украшения.
    if(state.user) Auth.renderAvatarInto(thumb, { ...state.user, decoration: null });

    const info = document.createElement("div");
    info.className = "deco-info";
    const name = document.createElement("div");
    name.className = "deco-name";
    name.textContent = I18n.t("deco.none");
    info.appendChild(name);

    const radio = document.createElement("div");
    radio.className = "deco-radio";

    row.append(thumb, info, radio);
    const activate = ()=>{ if(selected !== null) select(null); };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (e)=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); } });
    return row;
  }

  function rowDeco(d){
    const row = document.createElement("div");
    row.className = "deco-row";
    const isOwned = owned.indexOf(d.id) >= 0;
    const isSel   = selected === d.id;
    if(isSel) row.classList.add("is-selected");
    row.setAttribute("role", "listitem");

    const thumb = document.createElement("div");
    thumb.className = "avatar deco-thumb";
    // Превью: аватар юзера + украшение сверху — видно, как профиль выглядит
    // даже до покупки.
    if(state.user){
      Auth.renderAvatarInto(thumb, { ...state.user, decoration: d });
    }else{
      Auth.attachDecoration(thumb, d);
    }

    const info = document.createElement("div");
    info.className = "deco-info";
    const name = document.createElement("div");
    name.className = "deco-name";
    // Кастомные (загруженные админом) украшения приходят со своим title —
    // его и показываем. Для встроенных deco1..deco4 title пуст, фоллбек
    // на i18n-ключ deco.name_<id>.
    name.textContent = (d.title && d.title.trim()) ? d.title : I18n.t("deco.name_" + d.id);
    info.appendChild(name);
    const sub = document.createElement("div");
    sub.className = "deco-sub";
    if(!isOwned){
      const coinImg = document.createElement("img");
      coinImg.className = "coin";
      coinImg.src = "assets/coin.gif";
      coinImg.alt = "";
      coinImg.setAttribute("aria-hidden", "true");
      coinImg.width = 14; coinImg.height = 14;
      const price = document.createElement("span");
      price.textContent = String(d.price | 0);
      sub.append(coinImg, price);
    }else{
      sub.textContent = I18n.t(isSel ? "deco.selected" : "deco.owned");
    }
    info.appendChild(sub);

    let action;
    if(!isOwned){
      action = document.createElement("button");
      action.className = "btn btn-primary";
      action.textContent = I18n.t("deco.buy");
      action.addEventListener("click", (e)=>{ e.stopPropagation(); buy(d, action); });
    }else if(isSel){
      action = document.createElement("div");
      action.className = "deco-radio";
    }else{
      action = document.createElement("button");
      action.className = "btn btn-ghost";
      action.textContent = I18n.t("deco.select");
      action.addEventListener("click", (e)=>{ e.stopPropagation(); select(d.id); });
    }

    row.append(thumb, info, action);
    // Клик по всей строке купленного украшения — тоже выбор.
    if(isOwned && !isSel){
      row.addEventListener("click", ()=> select(d.id));
    }
    return row;
  }

  async function buy(d, btnEl){
    const price = d.price | 0;
    if(btnEl) btnEl.disabled = true;
    try{
      const r = await fetch("/api/decorations/buy?id=" + encodeURIComponent(d.id), {
        method: "POST",
        credentials: "same-origin"
      });
      const j = await r.json().catch(()=>({}));
      if(r.status === 402){
        if(btnEl){
          btnEl.disabled = false;
          const orig = btnEl.textContent;
          btnEl.textContent = I18n.t("deco.insufficient");
          setTimeout(()=>{ btnEl.textContent = orig; }, 1500);
        }
        return;
      }
      if(!r.ok){ if(btnEl) btnEl.disabled = false; return; }
      if(typeof j.coins === "number") Wallet.set(j.coins, -price);
      owned = Array.isArray(j.owned) ? j.owned : owned;
      render();
    }catch(_){ if(btnEl) btnEl.disabled = false; }
  }

  async function select(id){
    try{
      const url = "/api/decorations/select" + (id == null ? "" : ("?id=" + encodeURIComponent(id)));
      const r = await fetch(url, { method: "POST", credentials: "same-origin" });
      if(!r.ok) return;
      const j = await r.json();
      selected = j.selected || null;
      // Синхронизируем state.user и перерисовываем все видимые аватары.
      if(state.user){
        state.user.decoration = j.decoration || null;
        Auth.renderAvatarInto($("user-avatar"), state.user);
        if(!screens.game.classList.contains("hidden")) refreshLocalizedDynamicUI();
      }
      render();
    }catch(_){}
  }

  window.Decorations = { open, close };

  $("btn-decorations").addEventListener("click", (e)=>{
    e.stopPropagation();
    closeUserPopup();
    open();
  });
  $("btn-decorations-close").addEventListener("click", close);
  $("decorations-modal").addEventListener("click", (e)=>{
    if(e.target.id === "decorations-modal") close();
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape" && !$("decorations-modal").classList.contains("hidden")) close();
  });
})();
