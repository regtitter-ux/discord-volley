/* Tiny i18n layer. Strings live here so markup stays clean.
   Usage: data-i18n="key" → textContent, data-i18n-title="key" → title,
   data-i18n-aria="key" → aria-label. Dynamic strings: I18n.t(key). */
(function(global){
  const KEY = "dv_lang_v1";

  const DICT = {
    ru: {
      "app.title": "Volleyball Online",

      "login.subtitle": "Войдите, чтобы играть под своим аватаром",
      "login.button":   "Войти через Discord",

      "menu.status":    "В сети",
      "menu.decorations":"Украшения",
      "menu.admin":     "Админ-режим",
      "menu.logout":    "Выйти",

      "admin.title":    "Изменить баланс",
      "admin.target":   "ID или username игрока",
      "admin.amount":   "Сумма (с + или −)",
      "admin.apply":    "Применить",
      "admin.close":    "Закрыть",
      "admin.open":     "Изменить баланс",
      "admin.ok":       "Готово: баланс игрока теперь {coins}",
      "admin.err_notfound": "Игрок не найден",
      "admin.err_amount":   "Сумма: +число или −число",
      "admin.err_generic":  "Не удалось применить",

      "admin.shop_open":       "Магазин украшений",
      "admin.shop_title":      "Магазин украшений",
      "admin.shop_new":        "+ Новое украшение",
      "admin.shop_new_title":  "Новое украшение",
      "admin.shop_edit_title": "Редактирование «{id}»",
      "admin.shop_id":         "ID",
      "admin.shop_id_hint":    "латиница, цифры, _ и −, длина 2–32",
      "admin.shop_title_lbl":  "Название",
      "admin.shop_price":      "Цена",
      "admin.shop_sort":       "Порядок",
      "admin.shop_frames":     "Кадров",
      "admin.shop_fps":        "FPS",
      "admin.shop_framew":     "Ширина кадра",
      "admin.shop_frameh":     "Высота кадра",
      "admin.shop_cols":       "Колонок",
      "admin.shop_rows":       "Строк",
      "admin.shop_advanced":   "Параметры атласа (60 кадров 96×96, 6×10, 12 FPS)",
      "admin.shop_atlas":      "Атлас (PNG или WebP)",
      "admin.shop_atlas_hint": "для нового украшения — обязателен; при правке — оставь пустым, чтобы не менять. WebP весит меньше",
      "admin.shop_save":       "Сохранить",
      "admin.shop_cancel":     "Отмена",
      "admin.shop_edit":       "Изменить",
      "admin.shop_delete":     "Удалить",
      "admin.shop_builtin":    "встроенное",
      "admin.shop_confirm_del":"Удалить украшение «{id}»?",
      "admin.shop_saved":      "Сохранено",
      "admin.shop_deleted":    "Удалено",
      "admin.shop_err_generic":"Не удалось сохранить",
      "admin.shop_err_id":     "Некорректный ID",
      "admin.shop_err_field":  "Заполни числовые поля",
      "admin.shop_err_format": "Файл должен быть PNG или WebP",
      "admin.shop_err_big":    "Атлас слишком большой",
      "admin.shop_err_grid":   "Кадров больше, чем колонок×строк",
      "admin.shop_err_atlas_req":"Нужен файл атласа",

      "deco.title":      "Украшения",
      "deco.close":      "Закрыть",
      "deco.none":       "Без украшения",
      "deco.name_deco1": "Сумеречный аметист",
      "deco.name_deco2": "Тёмные розы",
      "deco.name_deco3": "Жуткие кошачьи ушки",
      "deco.name_deco4": "Одинокий волк",
      "deco.buy":        "Купить",
      "deco.select":     "Выбрать",
      "deco.selected":   "Выбрано",
      "deco.owned":      "Куплено",
      "deco.insufficient":"Не хватает монет",
      "menu.heading":   "Онлайн Волейбол",
      "menu.hint":      "Стрелками / WAD двигайтесь и прыгайте. Не давайте мячу коснуться земли на вашей стороне.",
      "menu.points":    "До скольки очков",
      "menu.play":      "ИГРАТЬ",
      "menu.online_label": "Сейчас онлайн",

      "lb.title":       "Топ по кубкам",
      "lb.empty":       "Пока ни у кого нет кубков — будь первым!",
      "lb.me_rank":     "Вы: #{rank} · {trophies} 🏆",
      "lb.me_empty":    "Выиграй первый матч, чтобы попасть в топ",
      "lb.wins_suffix": "кубков",
      "lb.page_info":   "Стр. {page} / {pages}",
      "lb.prev":        "Предыдущая страница",
      "lb.next":        "Следующая страница",
      "lb.jump_me":     "К моему месту",

      "trophies.label": "Кубки",
      "game.stakes":    "Ставка: +{win} / −{loss}",

      "hud.online":     "ОНЛАЙН",
      "hud.bot":        "БОТ",

      "game.home":      "В меню",
      "game.pause":     "Пауза",
      "game.resume":    "Продолжить",
      "game.replay":    "Играть снова",
      "game.quit":      "В меню",
      "game.victory":   "Победа!",
      "game.defeat":    "Поражение",
      "game.serve_you": "ПОДАЧА",
      "game.serve_opp": "ПОДАЧА СОПЕРНИКА",
      "game.point":     "ОЧКО!",
      "game.miss":      "ПРОПУСК",
      "game.foul":      "ФОЛ",
      "game.opponent_left": "Соперник сдался",

      "lobby.searching":      "Поиск соперника…",
      "lobby.fallback_hint":  "Если никого не найдём за 5 секунд — играем с ботом.",
      "lobby.preparing":      "Соперник найден, готовим матч…",
      "lobby.preparing_hint": "Запускаем игровую комнату рядом с вами.",
      "lobby.cancel":         "Отмена",
      "lobby.disconnected":   "Соединение разорвано",

      "wallet.label":   "Монеты",

      "rotate.title":   "Поверните телефон",
      "rotate.sub":     "Игра удобнее в горизонтальной ориентации",

      "bot.prefix":     "Бот"
    },
    en: {
      "app.title": "Volleyball Online",

      "login.subtitle": "Sign in to play under your avatar",
      "login.button":   "Sign in with Discord",

      "menu.status":    "Online",
      "menu.decorations":"Decorations",
      "menu.logout":    "Log out",

      "deco.title":      "Decorations",
      "deco.close":      "Close",
      "deco.none":       "No decoration",
      "deco.name_deco1": "Twilight Amethyst",
      "deco.name_deco2": "Dark Roses",
      "deco.name_deco3": "Creepy Cat Ears",
      "deco.name_deco4": "Lone Wolf",
      "deco.buy":        "Buy",
      "deco.select":     "Select",
      "deco.selected":   "Selected",
      "deco.owned":      "Owned",
      "deco.insufficient":"Not enough coins",
      "menu.heading":   "Volleyball Online",
      "menu.hint":      "Use arrows / WAD to move and jump. Don't let the ball touch the ground on your side.",
      "menu.points":    "Points to win",
      "menu.play":      "PLAY",
      "menu.online_label": "Players online",

      "lb.title":       "Top by trophies",
      "lb.empty":       "Nobody has trophies yet — be the first!",
      "lb.me_rank":     "You: #{rank} · {trophies} 🏆",
      "lb.me_empty":    "Win your first match to join the ranks",
      "lb.wins_suffix": "trophies",
      "lb.page_info":   "Page {page} / {pages}",
      "lb.prev":        "Previous page",
      "lb.next":        "Next page",
      "lb.jump_me":     "Jump to me",

      "trophies.label": "Trophies",
      "game.stakes":    "Stakes: +{win} / −{loss}",

      "hud.online":     "ONLINE",
      "hud.bot":        "BOT",

      "game.home":      "Back to menu",
      "game.pause":     "Pause",
      "game.resume":    "Resume",
      "game.replay":    "Play again",
      "game.quit":      "Menu",
      "game.victory":   "Victory!",
      "game.defeat":    "Defeat",
      "game.serve_you": "YOUR SERVE",
      "game.serve_opp": "OPPONENT SERVE",
      "game.point":     "POINT!",
      "game.miss":      "MISS",
      "game.foul":      "FOUL",
      "game.opponent_left": "Opponent forfeited",

      "lobby.searching":      "Looking for opponent…",
      "lobby.fallback_hint":  "If nobody shows up in 5 seconds — we play a bot match.",
      "lobby.preparing":      "Opponent found, preparing match…",
      "lobby.preparing_hint": "Spinning up a game room near you.",
      "lobby.cancel":         "Cancel",
      "lobby.disconnected":   "Disconnected",

      "wallet.label":   "Coins",

      "rotate.title":   "Rotate your phone",
      "rotate.sub":     "The game is easier in landscape orientation",

      "bot.prefix":     "Bot"
    }
  };

  function detect(){
    try{
      const saved = localStorage.getItem(KEY);
      if(saved === "ru" || saved === "en") return saved;
    }catch(_){}
    // Для новых пользователей — английский по умолчанию, независимо от
    // локали браузера. Русский выбирается только явным кликом по RU в UI.
    return "en";
  }

  let lang = detect();
  const listeners = [];
  // Держим html[lang] в синхроне с выбранным языком до первого apply(),
  // чтобы login-экран не объявлялся скринридерами чужим языком.
  try{ document.documentElement.lang = lang; }catch(_){}

  // Чтобы не спамить лог одним и тем же ключом, помним уже сообщённые промахи.
  const _missWarned = new Set();
  function t(key){
    const cur = DICT[lang] && DICT[lang][key];
    if(cur != null) return cur;
    if(!_missWarned.has(lang + ":" + key)){
      _missWarned.add(lang + ":" + key);
      // Возвращаем сам ключ (не чужой язык), чтобы промахи были видимы.
      // console.warn без throw — сборка не рушится на отсутствующих строках.
      if(typeof console !== "undefined") console.warn("[i18n] missing key:", lang, key);
    }
    // На этапе разработки всё-таки полезнее увидеть RU, чем голый ключ;
    // но и о промахе знаем из warn. Если RU тоже пусто — отдаём ключ.
    return (DICT.ru && DICT.ru[key]) || key;
  }

  function apply(root){
    const r = root || document;
    // Один проход вместо трёх querySelectorAll: элемент может иметь любую
    // комбинацию data-i18n / data-i18n-title / data-i18n-aria одновременно.
    const sel = "[data-i18n],[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]";
    r.querySelectorAll(sel).forEach(el => {
      const ds = el.dataset;
      if(ds.i18n)            el.textContent = t(ds.i18n);
      if(ds.i18nTitle)       el.title = t(ds.i18nTitle);
      if(ds.i18nAria)        el.setAttribute("aria-label", t(ds.i18nAria));
      if(ds.i18nPlaceholder) el.placeholder = t(ds.i18nPlaceholder);
    });
    document.documentElement.lang = lang;
  }

  function setLang(next){
    if(next !== "ru" && next !== "en") return;
    if(next === lang) return;
    lang = next;
    try{ localStorage.setItem(KEY, lang); }catch(_){}
    apply();
    for(const fn of listeners) { try{ fn(lang); }catch(_){} }
  }

  function getLang(){ return lang; }
  function onChange(fn){ if(typeof fn === "function") listeners.push(fn); }

  global.I18n = { t, apply, setLang, getLang, onChange };
})(window);
