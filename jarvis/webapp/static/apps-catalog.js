// Каталог приложений — логика без DOM (тест — tests/js/apps-catalog.test.mjs).
// Встроенные приложения Atom и свои — из каталога (/api/apps: проекты с catalog: true и заметки type: app).
// Приложения сгруппированы по делу, а не по истории появления: «Дела», «Люди», «Анализ», «Система» —
// так на вопрос «где это?» отвечает сама плитка, а не память. Окно — apps-window.js.

/** Порядок групп в каталоге. Первая — то, чем пользуются каждый день. */
export const GROUPS = [
  ["deals", "Дела"],
  ["people", "Люди"],
  ["analysis", "Анализ"],
  ["system", "Система"],
];

/** Встроенные приложения. server — только с сервером Atom (на iPhone без сервера их нет).
 *  description начинается с действия: что здесь делают, а не из чего сделано. */
export const BUILTIN = [
  { id: "files", name: "Хранилище", icon: "▤", group: "deals",
    description: "Заметки и проекты: найти и поправить" },
  { id: "finance", name: "Финансы", icon: "₽", group: "deals",
    description: "Траты, бюджеты, активы и долги" },
  { id: "map", name: "Карта", icon: "🗺", group: "deals",
    description: "Места, маршруты и навигация" },
  { id: "team", name: "Команда", icon: "👥", group: "people", server: true,
    description: "Операторы, права, чат, поручения" },
  { id: "exchange", name: "Обмен файлами", icon: "⇅", group: "people", server: true,
    description: "Файлы для операторов и от них" },
  { id: "globe", name: "Глобус", icon: "🌐", group: "analysis", server: true,
    description: "Новости мира и рынков, прогнозы" },
  { id: "graph", name: "Граф памяти", icon: "◈", group: "analysis",
    description: "Связи заметок в 3D" },
  { id: "system", name: "Настройки и диагностика", icon: "⚙", group: "system",
    description: "Сервер, ключи и обновления" },
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

/** Встроенные по группам — для заголовков каталога; пустые группы не показываем. */
export function groupedBuiltin(items = []) {
  return GROUPS
    .map(([id, title]) => ({ id, title, items: items.filter((a) => (a.group || "system") === id) }))
    .filter((g) => g.items.length);
}

/** Иконка плитки: эмодзи из поля icon или первая буква названия. */
export const appIcon = (a) => String(a.icon || "").trim() || String(a.name || "?").trim().slice(0, 1).toUpperCase();
