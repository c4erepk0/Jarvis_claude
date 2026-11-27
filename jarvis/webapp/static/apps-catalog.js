// Каталог приложений — логика без DOM (тест — tests/js/apps-catalog.test.mjs).
// Встроенные приложения Atom (карта, финансы, хранилище, граф, команда, настройки) и свои — из каталога
// (/api/apps: проекты с catalog: true и заметки type: app, например «Ценники»). Окно — apps-window.js.

/** Встроенные приложения. server — только с сервером Atom (на iPhone без сервера их нет). */
export const BUILTIN = [
  { id: "globe", name: "Глобус", icon: "🌐", description: "Новости мира на глобусе в прямом эфире, прогнозы по рынкам и тактика", server: true },
  { id: "map", name: "Карта", icon: "🗺", description: "Места, маршруты и навигация от того места, где вы" },
  { id: "exchange", name: "Обмен файлами", icon: "⇅", description: "Папки на сервере Atom: файлы для операторов и от них", server: true },
  { id: "finance", name: "Финансы", icon: "₽", description: "Доходы и расходы, аналитика, активы и долги" },
  { id: "files", name: "Хранилище", icon: "▤", description: "Заметки и проекты Obsidian: папки, теги, корзина" },
  { id: "graph", name: "Граф памяти", icon: "◈", description: "Связи заметок в 3D, жесты и взгляд" },
  { id: "team", name: "Команда", icon: "👥", description: "Операторы, права, чат, поручения и встречи", server: true },
  { id: "system", name: "Настройки и диагностика", icon: "⚙", description: "Сервер, ключи и токены, SSH, обновления" },
];

/** Ссылку можно открыть внутри Atom (во встроенном окне), а не только в новой вкладке. */
export function embeddable(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch { return false; }
}

/** Плитки окна «Приложения»: встроенные + свои; поиск по названию и описанию. */
export function launcherItems({ apps = [], standalone = false, query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase().replace(/ё/g, "е");
  const match = (a) => !q || `${a.name} ${a.description || ""}`.toLowerCase().replace(/ё/g, "е").includes(q);
  const builtin = BUILTIN.filter((b) => !(b.server && standalone)).map((b) => ({ ...b, kind: "builtin" })).filter(match);
  const own = apps.map((a, i) => ({ ...a, i, id: a.note || a.name, embeddable: embeddable(a.url) })).filter(match);
  return { builtin, own };
}

/** Иконка плитки: эмодзи из поля icon или первая буква названия. */
export const appIcon = (a) => String(a.icon || "").trim() || String(a.name || "?").trim().slice(0, 1).toUpperCase();
