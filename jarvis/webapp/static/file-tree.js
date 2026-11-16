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
