// Дерево хранилища для менеджера заметок — без DOM (тест — tests/js/files.test.mjs).
// Индекс приходит с /api/files: { files: [{ path, title, folder, tags, … }], folders: [...] }.

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
const byName = (a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base", numeric: true });
const extOf = (p) => { const m = /\.[^./]+$/.exec(p); return m ? m[0] : ""; };
export const nameOf = (p) => p.split("/").pop();
export const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Узлы: { type: "dir", name, path, children, count } и { type: "file", name, path, file }. Папки — первыми. */
export function buildTree(index) {
  const root = { type: "dir", name: "", path: "", children: [], count: 0 };
  const dirs = new Map([["", root]]);
  const dir = (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const node = { type: "dir", name: nameOf(path), path, children: [], count: 0 };
    dirs.set(path, node);
    dir(parentOf(path)).children.push(node);
    return node;
  };
  for (const f of index.folders || []) dir(f);
  for (const f of index.files || []) {
    dir(f.folder).children.push({ type: "file", name: f.title, path: f.path, file: f });
    for (let p = f.folder; ; p = parentOf(p)) { dirs.get(p).count++; if (!p) break; }
  }
  for (const node of dirs.values()) {
    node.children.sort((a, b) => (a.type === b.type ? byName(a, b) : a.type === "dir" ? -1 : 1));
  }
  return root;
}

/** Файлы по запросу (название или путь), тегу или папке (только её собственные файлы). */
export function filterFiles(files, { query = "", tag = "", folder = null } = {}) {
  const q = norm(query).trim();
  return files.filter((f) => (!q || norm(f.title).includes(q) || norm(f.path).includes(q))
    && (!tag || (f.tags || []).includes(tag)) && (folder === null || f.folder === folder))
    .sort((a, b) => a.title.localeCompare(b.title, "ru", { numeric: true }));
}

/** Недавно открытые: новая — первой, без повторов, не больше limit. */
export function pushRecent(list, path, limit = 20) {
  return [path, ...list.filter((p) => p !== path)].slice(0, limit);
}

/** Куда попадёт файл или папка path, если перенести их в папку folder ("" — корень); null — нельзя или некуда. */
export function moveTarget(path, folder) {
  if (folder === path || folder.startsWith(`${path}/`)) return null;
  const dst = folder ? `${folder}/${nameOf(path)}` : nameOf(path);
  return dst === path ? null : dst;
}

/** Новый путь при переименовании: та же папка, прежнее расширение; null — пустое имя или в имени «/». */
export function renameTarget(path, name, { dir = false } = {}) {
  name = String(name || "").trim();
  if (!name || /[/\\]/.test(name)) return null;
  const ext = dir ? "" : extOf(path);
  const full = ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name;
  const parent = parentOf(path);
  return parent ? `${parent}/${full}` : full;
}

/**
 * Подсветка синтеза проектов (/api/synthesis → highlight: путь → { kind, project }) для дерева: заметки и папки,
 * в которых они лежат. В папке с заметками проекта и кандидата — проект (он важнее).
 */
export function markSynthesis(highlight = {}) {
  const marks = new Map();
  for (const [path, mark] of Object.entries(highlight)) {
    marks.set(path, mark);
    for (let p = parentOf(path); p; p = parentOf(p)) {
      const cur = marks.get(p);
      if (!cur || (cur.kind === "candidate" && mark.kind === "project")) marks.set(p, { kind: mark.kind, project: mark.project });
    }
  }
  return marks;
}

// ---------- сортировка, избранное, обзор хранилища ----------
export const SORTS = { name: "по имени", mtime: "по изменению", size: "по размеру" };

/** Файлы в нужном порядке: имя — по алфавиту, изменение и размер — сначала новые/большие. */
export function sortFiles(files, by = "name") {
  const name = (a, b) => a.title.localeCompare(b.title, "ru", { numeric: true });
  const cmp = by === "mtime" ? (a, b) => (b.mtime || 0) - (a.mtime || 0) || name(a, b)
    : by === "size" ? (a, b) => (b.size || 0) - (a.size || 0) || name(a, b) : name;
  return [...files].sort(cmp);
}

/** Добавить или убрать из избранного (новые — сверху). */
export function toggleFav(list, path) {
  return list.includes(path) ? list.filter((p) => p !== path) : [path, ...list];
}

/** Избранное после переноса или переименования (папки — вместе с содержимым). */
export function renamePaths(list, from, to) {
  return list.map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
}

const stem = (p) => p.replace(/\.[^./]+$/, "").toLowerCase();

/**
 * Обзор хранилища по индексу /api/files: сколько чего, недавно изменённые, заметки-хабы (на них чаще ссылаются),
 * «сироты» (ни ссылок туда, ни оттуда), несозданные заметки — [[ссылки]] в никуда (кто на них ссылается).
 * skip — служебные папки (шаблоны, разговоры Atom), их заметки не считаются сиротами.
 */
export function vaultStats(index, { skip = ["Templates/", "Jarvis/", ".trash/"], limit = 8 } = {}) {
  const files = (index.files || []).filter((f) => f.ext === ".md");
  const byTitle = new Map(), byPath = new Map();
  for (const f of files) { byTitle.set(f.title.toLowerCase(), f.path); byPath.set(stem(f.path), f.path); }
  const resolve = (link) => {
    const t = String(link).split("|")[0].split("#")[0].trim().toLowerCase().replace(/\.md$/, "");
    if (!t) return null;
    return t.includes("/") ? byPath.get(t) || byTitle.get(t.split("/").pop()) || null : byTitle.get(t) || null;
  };
  const incoming = new Map(files.map((f) => [f.path, 0]));
  const outgoing = new Map(files.map((f) => [f.path, 0]));
  const missing = new Map();
  for (const f of files) {
    const seen = new Set();          // [[Atom]] и [[Projects/Atom|алиас]] из одной заметки — одна связь
    for (const link of new Set(f.links || [])) {
      const to = resolve(link);
      if (to && to !== f.path && !seen.has(to)) {
        seen.add(to);
        incoming.set(to, incoming.get(to) + 1); outgoing.set(f.path, outgoing.get(f.path) + 1);
      } else if (!to) {
        const name = String(link).split("|")[0].split("#")[0].trim();
        if (!name) continue;
        if (!missing.has(name)) missing.set(name, []);
        missing.get(name).push(f.path);
      }
    }
  }
  const service = (p) => skip.some((s) => p.startsWith(s));
  const words = (f) => Math.round((f.size || 0) / 7);   // грубо: ~7 байт на слово в UTF-8 по-русски
  return {
    notes: files.length,
    folders: (index.folders || []).length,
    tags: (index.tags || []).length,
    words: files.reduce((s, f) => s + words(f), 0),
    recent: sortFiles(files.filter((f) => !service(f.path)), "mtime").slice(0, limit),
    hubs: files.filter((f) => incoming.get(f.path) > 0).sort((a, b) => incoming.get(b.path) - incoming.get(a.path)
      || a.title.localeCompare(b.title, "ru")).slice(0, limit).map((f) => ({ ...f, incoming: incoming.get(f.path) })),
    orphans: files.filter((f) => !service(f.path) && !incoming.get(f.path) && !outgoing.get(f.path))
      .sort((a, b) => a.title.localeCompare(b.title, "ru")),
    missing: [...missing].map(([name, from]) => ({ name, from })).sort((a, b) => b.from.length - a.from.length
      || a.name.localeCompare(b.name, "ru")),
  };
}
