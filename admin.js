/* Admin + AdminShop (клиентский UI). -----------------------------------
   Admin — тумблер админ-режима (что показывать в шапке): решение принимает
   сервер (user.is_admin в /api/me). Ручки /api/admin/* проверяют право
   отдельно — клиентское «включение» в localStorage ничего не даёт.
   AdminShop — CRUD каталога украшений через /api/admin/decorations
   (multipart-upload атласа, DELETE по id). Валидация полей/PNG-сигнатуры
   живёт на сервере; клиент тут — только удобный UI. */
(function(){
  "use strict";
  const $ = (id) => document.getElementById(id);

  /* ---------------- Admin ---------------- */
  const Admin = (function(){
    const KEY = "dv_admin_mode_v1";
    const toggleBtn = $("btn-admin-toggle");
    const addBtn    = $("btn-admin-add");
    const shopBtn   = $("btn-admin-shop");
    const modal     = $("admin-modal");
    const form      = $("admin-form");
    const targetIn  = $("admin-target");
    const amountIn  = $("admin-amount");
    const msgEl     = $("admin-msg");

    function isAllowed(){ return !!(state.user && state.user.is_admin); }
    function isOn(){
      if(!isAllowed()) return false;
      try{ return localStorage.getItem(KEY) === "1"; }catch(_){ return false; }
    }
    function setOn(v){
      try{ localStorage.setItem(KEY, v ? "1" : "0"); }catch(_){}
      applyUi();
    }
    function applyUi(){
      const allowed = isAllowed();
      toggleBtn.classList.toggle("hidden", !allowed);
      const on = allowed && isOn();
      toggleBtn.classList.toggle("is-on", on);
      toggleBtn.setAttribute("aria-checked", on ? "true" : "false");
      addBtn.classList.toggle("hidden", !on);
      if(shopBtn) shopBtn.classList.toggle("hidden", !on);
    }

    toggleBtn.addEventListener("click", (e)=>{
      e.stopPropagation();
      if(!isAllowed()){ closeUserPopup(); return; }
      setOn(!isOn());
      closeUserPopup();
    });
    addBtn.addEventListener("click", ()=>{
      if(!isOn()) return;
      openModal();
    });
    if(shopBtn) shopBtn.addEventListener("click", ()=>{
      if(!isOn()) return;
      AdminShop.open();
    });

    function openModal(){
      setMsg("", "");
      targetIn.value = "";
      amountIn.value = "";
      modal.classList.remove("hidden");
      setTimeout(()=> targetIn.focus(), 30);
    }
    function closeModal(){ modal.classList.add("hidden"); }
    function setMsg(text, kind){
      msgEl.textContent = text || "";
      msgEl.classList.remove("is-err", "is-ok");
      if(kind === "err") msgEl.classList.add("is-err");
      if(kind === "ok")  msgEl.classList.add("is-ok");
    }

    $("btn-admin-close").addEventListener("click", closeModal);
    modal.addEventListener("click", (e)=>{ if(e.target.id === "admin-modal") closeModal(); });
    document.addEventListener("keydown", (e)=>{
      if(e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });

    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const q = targetIn.value.trim();
      // +N / −N / -N (NBSP минус U+2212 тоже принимаем — системная клавиатура).
      // Знак обязателен, иначе команда двусмысленная.
      const raw = amountIn.value.trim().replace(/−/g, "-");
      const m = /^([+-])(\d+)$/.exec(raw);
      if(!q){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
      if(!m){ setMsg(I18n.t("admin.err_amount"), "err"); return; }
      const delta = (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10);
      if(!Number.isFinite(delta) || delta === 0){ setMsg(I18n.t("admin.err_amount"), "err"); return; }
      try{
        // Резолвим id: числовой snowflake Discord / dev-id → сразу, иначе
        // lookup по username/global_name.
        let id = q;
        if(!/^\d{5,}$/.test(q)){
          const r = await fetch("/api/admin/lookup?q=" + encodeURIComponent(q), { credentials: "same-origin" });
          if(r.status === 404){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
          if(!r.ok){ setMsg(I18n.t("admin.err_generic"), "err"); return; }
          const j = await r.json();
          id = j.id;
        }
        const r2 = await fetch("/api/admin/coins?id=" + encodeURIComponent(id) + "&delta=" + delta, {
          method: "POST", credentials: "same-origin"
        });
        if(r2.status === 404){ setMsg(I18n.t("admin.err_notfound"), "err"); return; }
        if(!r2.ok){ setMsg(I18n.t("admin.err_generic"), "err"); return; }
        const j2 = await r2.json();
        setMsg(fmtI18n("admin.ok", { coins: j2.coins }), "ok");
      }catch(_){ setMsg(I18n.t("admin.err_generic"), "err"); }
    });

    return { applyUi };
  })();

  /* ---------------- Admin shop ---------------- */
  const AdminShop = (function(){
    const modal   = $("admin-shop-modal");
    const list    = $("admin-shop-list");
    const form    = $("admin-shop-form");
    const newBtn  = $("btn-admin-shop-new");
    const closeBtn= $("btn-admin-shop-close");
    const cancelBtn = $("btn-admin-shop-cancel");
    const formHead = $("admin-shop-form-head");
    const idIn     = $("admin-shop-id");
    const titleIn  = $("admin-shop-title-in");
    const priceIn  = $("admin-shop-price");
    const sortIn   = $("admin-shop-sort");
    const framesIn = $("admin-shop-frames");
    const fpsIn    = $("admin-shop-fps");
    const frameWIn = $("admin-shop-framew");
    const frameHIn = $("admin-shop-frameh");
    const colsIn   = $("admin-shop-cols");
    const rowsIn   = $("admin-shop-rows");
    const atlasIn  = $("admin-shop-atlas");
    const atlasHint= $("admin-shop-atlas-hint");
    const msgEl    = $("admin-shop-msg");

    let catalog = [];
    let editingId = null; // null = новое украшение, иначе id редактируемого

    function open(){
      modal.classList.remove("hidden");
      hideForm();
      refresh();
    }
    function close(){ modal.classList.add("hidden"); hideForm(); }

    function setMsg(text, kind){
      msgEl.textContent = text || "";
      msgEl.classList.remove("is-err", "is-ok");
      if(kind === "err") msgEl.classList.add("is-err");
      if(kind === "ok")  msgEl.classList.add("is-ok");
    }

    async function refresh(){
      try{
        const r = await fetch("/api/admin/decorations", { credentials: "same-origin" });
        if(!r.ok){ renderError(); return; }
        const j = await r.json();
        catalog = Array.isArray(j.catalog) ? j.catalog : [];
        render();
      }catch(_){ renderError(); }
    }

    function renderError(){
      list.innerHTML = "";
      const msg = document.createElement("div");
      msg.className = "muted";
      msg.style.padding = "12px";
      msg.style.textAlign = "center";
      msg.textContent = "—";
      list.appendChild(msg);
    }

    function render(){
      list.innerHTML = "";
      if(!catalog.length){
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.style.padding = "12px";
        empty.style.textAlign = "center";
        empty.textContent = "—";
        list.appendChild(empty);
        return;
      }
      for(const d of catalog) list.appendChild(rowOf(d));
    }

    function rowOf(d){
      const row = document.createElement("div");
      row.className = "admin-shop-row";
      if(d.builtin) row.classList.add("is-builtin");

      const thumb = document.createElement("div");
      thumb.className = "admin-shop-thumb";
      if(d.atlas){
        // Для превью берём кадр 0 (левый-верхний угол атласа) через
        // background-size / background-position, не страдая от тяжёлого
        // анимационного рендера в списке.
        // updatedAt = epoch ms: Number(...) без побитовых трюков, иначе v=
        // превратится в отрицательное число и cache-buster станет мусором.
        const ver = Number(d.updatedAt) || 0;
        thumb.style.backgroundImage = `url("${d.atlas}${d.atlas.includes("?") ? "&" : "?"}v=${ver}")`;
        thumb.style.backgroundSize = `${(d.cols|0)*100}% ${(d.rows|0)*100}%`;
        thumb.style.backgroundPosition = "0 0";
      }

      const meta = document.createElement("div");
      meta.className = "admin-shop-meta";
      const title = document.createElement("div");
      title.className = "admin-shop-meta-title";
      title.textContent = (d.title && d.title.trim()) || d.id;
      const sub = document.createElement("div");
      sub.className = "admin-shop-meta-sub";
      const idTag = document.createElement("span");
      idTag.className = "tag";
      idTag.textContent = d.id;
      sub.appendChild(idTag);
      if(d.builtin){
        const bi = document.createElement("span");
        bi.className = "tag";
        bi.textContent = I18n.t("admin.shop_builtin");
        sub.appendChild(bi);
      }
      const price = document.createElement("span");
      price.textContent = (d.price|0) + " ◦ " + (d.frames|0) + "×" + (d.cols|0) + "×" + (d.rows|0) + " @" + (d.fps|0);
      sub.appendChild(price);
      meta.append(title, sub);

      const actions = document.createElement("div");
      actions.className = "admin-shop-actions-row";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-ghost";
      editBtn.textContent = I18n.t("admin.shop_edit");
      editBtn.addEventListener("click", ()=> openEdit(d));
      actions.appendChild(editBtn);
      if(!d.builtin){
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-ghost";
        delBtn.textContent = I18n.t("admin.shop_delete");
        delBtn.addEventListener("click", ()=> del(d.id));
        actions.appendChild(delBtn);
      }

      row.append(thumb, meta, actions);
      return row;
    }

    function showForm(){ form.classList.remove("hidden"); }
    function hideForm(){
      form.classList.add("hidden");
      form.reset();
      editingId = null;
      idIn.disabled = false;
      setMsg("", "");
    }

    // Авто-подсказка ID/sortOrder на основе последней записи в каталоге.
    // serverный list отсортирован по sort_order ASC, так что catalog[last] —
    // «самое недавнее». Если id кончается числом (deco4 → deco5) — инкрементим.
    function suggestNextDefaults(){
      const items = Array.isArray(catalog) ? catalog : [];
      if (!items.length) return { id: "deco1", sortOrder: 1 };
      const last = items[items.length - 1];
      const m = /^(.*?)(\d+)$/.exec(last.id || "");
      const nextId = m ? (m[1] + (parseInt(m[2], 10) + 1)) : "";
      const maxSort = items.reduce((a, d) => Math.max(a, d.sortOrder | 0), 0);
      return { id: nextId, sortOrder: maxSort + 1 };
    }

    function openNew(){
      hideForm();
      editingId = null;
      formHead.textContent = I18n.t("admin.shop_new_title");
      idIn.disabled = false;
      const next = suggestNextDefaults();
      idIn.value = next.id;
      sortIn.value = String(next.sortOrder);
      titleIn.value = "";
      // Типичная цена украшения — 10k; если иначе, админ перебьёт руками.
      priceIn.value = "10000";
      // Дефолты под стандартный Discord-атлас (60 кадров 6×10, 96×96, 12 FPS).
      framesIn.value = "60";
      fpsIn.value    = "12";
      frameWIn.value = "96";
      frameHIn.value = "96";
      colsIn.value   = "6";
      rowsIn.value   = "10";
      atlasIn.value = "";
      const advanced = document.getElementById("admin-shop-advanced");
      if (advanced) advanced.open = false;
      showForm();
      // Фокус на title: id и price заполнены, админу остаётся только название
      // и файл атласа.
      setTimeout(()=> titleIn.focus(), 30);
    }

    function openEdit(d){
      hideForm();
      editingId = d.id;
      formHead.textContent = fmtI18n("admin.shop_edit_title", { id: d.id });
      idIn.value = d.id;
      idIn.disabled = true;
      titleIn.value = d.title || "";
      priceIn.value = String(d.price | 0);
      sortIn.value  = String(d.sortOrder | 0);
      framesIn.value = String(d.frames | 0);
      fpsIn.value    = String(d.fps | 0);
      frameWIn.value = String(d.frameW | 0);
      frameHIn.value = String(d.frameH | 0);
      colsIn.value   = String(d.cols | 0);
      rowsIn.value   = String(d.rows | 0);
      atlasIn.value = "";
      // Раскрываем «расширенные параметры» только если запись отличается от
      // стандартного 60-кадрового 6×10 96×96 @12fps.
      const advanced = document.getElementById("admin-shop-advanced");
      if (advanced){
        const nonDefault = (d.frames|0) !== 60 || (d.fps|0) !== 12
          || (d.frameW|0) !== 96 || (d.frameH|0) !== 96
          || (d.cols|0) !== 6 || (d.rows|0) !== 10;
        advanced.open = nonDefault;
      }
      showForm();
      setTimeout(()=> titleIn.focus(), 30);
    }

    async function del(id){
      const msg = fmtI18n("admin.shop_confirm_del", { id });
      if(!window.confirm(msg)) return;
      try{
        const r = await fetch("/api/admin/decorations/" + encodeURIComponent(id), {
          method: "DELETE", credentials: "same-origin"
        });
        if(!r.ok){ setMsg(I18n.t("admin.shop_err_generic"), "err"); return; }
        setMsg(I18n.t("admin.shop_deleted"), "ok");
        refresh();
      }catch(_){ setMsg(I18n.t("admin.shop_err_generic"), "err"); }
    }

    function serverErrorToI18n(err){
      switch(err){
        case "bad_id":            return "admin.shop_err_id";
        case "missing_field":
        case "bad_field":         return "admin.shop_err_field";
        case "atlas_bad_format":  return "admin.shop_err_format";
        case "atlas_too_large":   return "admin.shop_err_big";
        case "frames_exceed_grid":return "admin.shop_err_grid";
        case "atlas_required":    return "admin.shop_err_atlas_req";
        default:                  return "admin.shop_err_generic";
      }
    }

    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const fd = new FormData();
      fd.set("id",        idIn.value.trim());
      fd.set("title",     titleIn.value.trim());
      fd.set("price",     String(parseInt(priceIn.value, 10) || 0));
      fd.set("sortOrder", String(parseInt(sortIn.value, 10) || 0));
      fd.set("frames",    String(parseInt(framesIn.value, 10) || 0));
      fd.set("fps",       String(parseInt(fpsIn.value, 10) || 0));
      fd.set("frameW",    String(parseInt(frameWIn.value, 10) || 0));
      fd.set("frameH",    String(parseInt(frameHIn.value, 10) || 0));
      fd.set("cols",      String(parseInt(colsIn.value, 10) || 0));
      fd.set("rows",      String(parseInt(rowsIn.value, 10) || 0));
      const file = atlasIn.files && atlasIn.files[0];
      if(file) fd.set("atlas", file);
      try{
        const r = await fetch("/api/admin/decorations", {
          method: "POST", credentials: "same-origin", body: fd
        });
        const j = await r.json().catch(()=>({}));
        if(!r.ok){
          setMsg(I18n.t(serverErrorToI18n(j && j.error)), "err");
          return;
        }
        setMsg(I18n.t("admin.shop_saved"), "ok");
        hideForm();
        refresh();
      }catch(_){ setMsg(I18n.t("admin.shop_err_generic"), "err"); }
    });

    newBtn.addEventListener("click", openNew);
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", hideForm);
    modal.addEventListener("click", (e)=>{ if(e.target.id === "admin-shop-modal") close(); });
    document.addEventListener("keydown", (e)=>{
      if(e.key === "Escape" && !modal.classList.contains("hidden")){
        if(!form.classList.contains("hidden")) hideForm(); else close();
      }
    });

    return { open, close };
  })();

  window.Admin = Admin;
  window.AdminShop = AdminShop;
})();
