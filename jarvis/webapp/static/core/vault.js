// Хранилище Obsidian в браузере. Все заметки держим в памяти (хранилища у человека небольшие),
// а сохраняем через «склад» (store): GitHub-репозиторий, который Obsidian на iPhone синхронизирует
// плагином Obsidian Git, или локальный склад браузера (демо-режим без настройки).

const IGNORED = new Set([".obsidian", ".trash", ".git", ".github", ".stfolder", ".stversions", "node_modules"]);
export const TEXT_EXT = [".md", ".txt", ".canvas", ".csv", ".json"];
const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export class VaultError extends Error {}

// Заметку изменили (в Obsidian, синхронизацией) после того, как её открыли для правки.
export class VaultConflict extends VaultError {
  constructor(rel, current, message = "") {
    super(message || (current != null ? `заметку «${rel}» уже изменили — возможно, в Obsidian` : `заметки «${rel}» больше нет`));
    this.rel = rel;
    this.current = current ?? null;
    this.status = 409;
  }
}

// Версия содержимого: длина + FNV-1a (32 бита) от UTF-8 — так же, как content_version в jarvis/vault.py.
export function contentVersion(text) {
  const data = new TextEncoder().encode(String(text ?? ""));
  let h = 0x811c9dc5;
  for (const b of data) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `${data.length}-${h.toString(16).padStart(8, "0")}`;
}

export function checkPath(rel, { write = false } = {}) {
  rel = String(rel || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) throw new VaultError("пустой путь");
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === "" || p === ".") || IGNORED.has(parts[0])) {
    throw new VaultError(`недопустимый путь: ${rel}`);
  }
  if (write && !TEXT_EXT.some((e) => rel.toLowerCase().endsWith(e))) {
    throw new VaultError("писать можно только текстовые заметки (.md, .txt, .canvas, .csv, .json)");
  }
  return rel;
}

// ---------- frontmatter ----------
function scalar(raw) {
  const v = raw.trim();
  if (!v) return "";
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map(scalar) : [];
  }
  const low = v.toLowerCase();
  if (low === "true" || low === "yes") return true;
  if (low === "false" || low === "no") return false;
  if (low === "null" || low === "~") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return [{}, text];
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") return [{}, text];
  const meta = {};
  let key = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") return [meta, lines.slice(i + 1).join("\n")];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let m = /^\s+-\s*(.*)$/.exec(line);
    if (m && key !== null) {
      if (!Array.isArray(meta[key])) meta[key] = [];
      meta[key].push(scalar(m[1]));
      continue;
    }
    m = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (m) { key = m[1].trim(); meta[key] = m[2].trim() ? scalar(m[2]) : []; }
  }
  return [{}, text];
}

// ---------- поиск ----------
const RU_ENDINGS = /(иями|ями|ами|ого|его|ому|ему|ыми|ими|ов|ев|ей|ам|ям|ах|ях|ою|ею|ой|ий|ый|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|а|я|о|е|ы|и|у|ю|ь)$/;
export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, "е");
  if (w.length > 4 && /[а-я]/.test(w)) w = w.replace(RU_ENDINGS, "") || w;
  return w.length > 6 ? w.slice(0, 6) : w;
}
export function tokens(text) {
  return (text.toLowerCase().match(/[0-9a-zа-яё]+/g) || []).filter((w) => w.length > 1).map(stem);
}

export const title = (rel) => rel.split("/").pop().replace(/\.[^.]+$/, "");

export class Vault {
  constructor(store) {
    this.store = store;
    this.files = new Map();     // путь → текст
    this.version = 0;
    this.listeners = [];
    this.queue = Promise.resolve();
  }

  async load() {
    this.files = await this.store.loadAll();
    this.version++;
  }

  onChange(fn) { this.listeners.push(fn); }

  async poll() {
    const changed = await this.store.pull(this.files);
    if (changed.length) {
      this.version++;
      for (const fn of this.listeners) await fn(changed);
    }
    return changed;
  }

  exists(rel) { return this.files.has(rel); }

  read(rel, fallback) {
    rel = checkPath(rel);
    if (this.files.has(rel)) return this.files.get(rel);
    if (fallback !== undefined) return fallback;
    throw new VaultError(`заметка не найдена: ${rel}`);
  }

  list(folder = "", exts = [".md"]) {
    const pre = folder ? folder.replace(/\/+$/, "") + "/" : "";
    return [...this.files.keys()].filter((p) => p.startsWith(pre) && exts.some((e) => p.toLowerCase().endsWith(e))
      && !p.split("/").slice(0, -1).some((d) => d.startsWith("."))).sort();
  }

  // Изменение = функция «старый текст → новый». При конфликте со свежей правкой с телефона
  // склад перечитывает файл и применяет функцию заново — ничего не теряется.
  update(rel, fn, message) {
    rel = checkPath(rel, { write: true });
    const job = this.queue.then(async () => {
      const text = await this.store.update(rel, fn, message || `Jarvis: ${rel}`, this.files.get(rel));
      this.files.set(rel, text);
      this.version++;
      return rel;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  write(rel, text, message) { return this.update(rel, () => text, message); }

  // Правка из голограммы: base — версия, с которой начали править (null — новая заметка). Проверка идёт
  // внутри update, поэтому и при повторе после свежей правки с телефона чужие изменения не затираются.
  save(rel, text, base) {
    return this.update(rel, (cur) => {
      if (base == null) {
        if (cur !== undefined) throw new VaultConflict(rel, cur, `заметка «${rel}» уже есть`);
      } else if (cur === undefined || contentVersion(cur) !== base) {
        throw new VaultConflict(rel, cur);
      }
      return text;
    }, `Jarvis: правка ${rel}`);
  }

  // Заметка по пути, названию или словам — как find_note в jarvis/vault.py.
  findNote(query) {
    const q = String(query || "").trim().replace(/^[«»"']+|[«»"']+$/g, "").trim();
    if (!q) return null;
    for (const cand of [q, `${q}.md`]) {
      try { const rel = checkPath(cand); if (this.files.has(rel)) return rel; } catch { /* не путь — ищем дальше */ }
    }
    const norm = (s) => s.toLowerCase().replace(/ё/g, "е");
    const low = norm(q);
    const files = this.list();
    const exact = files.find((f) => norm(title(f)) === low);
    if (exact) return exact;
    const partial = files.filter((f) => norm(title(f)).includes(low)).sort((a, b) => a.length - b.length);
    if (partial.length) return partial[0];
    const hits = this.search(q, 1);
    return hits.length ? hits[0].path : null;
  }

  append(rel, text, { header = "" } = {}) {
    return this.update(rel, (cur) => {
      let base = cur ?? header;
      if (base && !base.endsWith("\n")) base += "\n";
      return base + text.replace(/\n+$/, "") + "\n";
    });
  }

  appendToSection(rel, section, line, { header = "" } = {}) {
    return this.update(rel, (cur) => {
      const lines = (cur ?? header).split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const head = `## ${section}`;
      const start = lines.findIndex((l) => l.trim().toLowerCase() === head.toLowerCase());
      if (start < 0) {
        if (lines.length && lines[lines.length - 1].trim()) lines.push("");
        lines.push(head, line);
        return lines.join("\n") + "\n";
      }
      let end = start + 1;
      while (end < lines.length && !/^#{1,2} /.test(lines[end])) end++;
      let ins = end;
      while (ins > start + 1 && !lines[ins - 1].trim()) ins--;
      lines.splice(ins, 0, line);
      return lines.join("\n") + "\n";
    });
  }

  search(query, limit = 8) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const hits = [];
    for (const rel of this.list()) {
      const text = this.files.get(rel);
      const t = title(rel);
      const tt = tokens(t), bt = tokens(text);
      let score = 0, matched = 0;
      for (const term of q) {
        const inTitle = tt.filter((x) => x === term).length, inBody = bt.filter((x) => x === term).length;
        if (inTitle || inBody) matched++;
        score += 3 * inTitle + Math.min(inBody, 10) / (1 + bt.length / 400);
      }
      if (!matched) continue;
      hits.push({ path: rel, title: t, score: Math.round(score * (matched / q.length) * 100) / 100,
        snippet: snippet(text, q) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  graph(limit = 600) {
    const files = this.list().slice(0, limit);
    const byTitle = new Map(files.map((f) => [title(f).toLowerCase(), f]));
    const nodes = [], links = [];
    for (const rel of files) {
      const text = this.files.get(rel);
      const [meta] = parseFrontmatter(text);
      nodes.push({ id: rel, title: title(rel), group: rel.includes("/") ? rel.split("/")[0] : "root",
        type: String(meta.type || ""), size: text.length });
      for (const m of text.matchAll(WIKILINK)) {
        const dst = byTitle.get(title(m[1].trim()).toLowerCase());
        if (dst && dst !== rel) links.push({ source: rel, target: dst });
      }
    }
    return { nodes, links };
  }
}

function snippet(text, q, width = 180) {
  const [, body] = parseFrontmatter(text);
  const flat = body.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase().replace(/ё/g, "е");
  const positions = q.map((t) => low.indexOf(t)).filter((p) => p >= 0);
  const pos = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, pos - Math.floor(width / 3));
  return (start ? "…" : "") + flat.slice(start, start + width) + (start + width < flat.length ? "…" : "");
}

// ---------- склады ----------

// Демо-склад: заметки живут в браузере (IndexedDB или память). Подходит, чтобы попробовать без настройки.
export class LocalStore {
  constructor(name = "jarvis-vault", seed = {}) {
    this.name = name;
    this.seed = seed;
    this.mem = null;
    this.kind = "local";
  }

  async db() {
    if (typeof indexedDB === "undefined") return null;
    if (!this._db) {
      this._db = await new Promise((resolve) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("files");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
    }
    return this._db;
  }

  async loadAll() {
    const db = await this.db();
    if (!db) {
      this.mem = this.mem || new Map(Object.entries(this.seed));
      return new Map(this.mem);
    }
    const all = await new Promise((resolve) => {
      const out = new Map();
      const req = db.transaction("files").objectStore("files").openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
      req.onerror = () => resolve(out);
    });
    if (!all.size) {
      for (const [k, v] of Object.entries(this.seed)) { await this.put(k, v); all.set(k, v); }
    }
    return all;
  }

  async put(rel, text) {
    const db = await this.db();
    if (!db) { this.mem.set(rel, text); return; }
    await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(text, rel);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async update(rel, fn, _message, current) {
    const text = fn(current);
    await this.put(rel, text);
    return text;
  }

  async pull() { return []; }
}

// Основной склад: приватный GitHub-репозиторий с хранилищем Obsidian.
// Читаем дерево (путь → sha блоба), качаем только изменившиеся блобы, пишем через Contents API.
export class GitHubStore {
  constructor(gh, repo, branch = "main", cache = null) {
    this.gh = gh;
    this.repo = repo;
    this.branch = branch;
    this.cache = cache;          // { get(sha), set(sha, text) } — кэш блобов по sha (IndexedDB)
    this.shas = new Map();       // путь → sha блоба
    this.head = null;
    this.kind = "github";
  }

  async tree() {
    let ref;
    try {
      ref = await this.gh.request("GET", `/repos/${this.repo}/commits/${encodeURIComponent(this.branch)}`, { etag: true });
    } catch (e) {
      if (e.status === 409 || e.status === 404) return new Map();   // пустой репозиторий — заметок ещё нет
      throw e;
    }
    if (ref === null) return null;    // 304 — ничего не изменилось
    const t = await this.gh.request("GET", `/repos/${this.repo}/git/trees/${ref.commit.tree.sha}?recursive=1`);
    const out = new Map();
    for (const item of t.tree || []) {
      if (item.type !== "blob") continue;
      const parts = item.path.split("/");
      if (IGNORED.has(parts[0]) || !TEXT_EXT.some((e) => item.path.toLowerCase().endsWith(e))) continue;
      if (item.size > 2_000_000) continue;
      out.set(item.path, item.sha);
    }
    this.head = ref.sha;
    return out;
  }

  async blob(sha) {
    const hit = this.cache && await this.cache.get(sha);
    if (typeof hit === "string") return hit;
    const b = await this.gh.request("GET", `/repos/${this.repo}/git/blobs/${sha}`);
    const text = decodeBase64(b.content);
    if (this.cache) await this.cache.set(sha, text);
    return text;
  }

  async loadAll() {
    const shas = await this.tree() || new Map();
    this.shas = shas;
    const files = new Map();
    const entries = [...shas.entries()];
    for (let i = 0; i < entries.length; i += 8) {
      const part = entries.slice(i, i + 8);
      const texts = await Promise.all(part.map(([, sha]) => this.blob(sha)));
      part.forEach(([p], k) => files.set(p, texts[k]));
    }
    return files;
  }

  // Подтягивает правки, сделанные в Obsidian (через Obsidian Git), прямо в files. Возвращает изменённые пути.
  async pull(files) {
    const shas = await this.tree();
    if (!shas) return [];
    const changed = [];
    for (const [p, sha] of shas) {
      if (this.shas.get(p) !== sha) { files.set(p, await this.blob(sha)); changed.push(p); }
    }
    for (const p of this.shas.keys()) if (!shas.has(p)) { files.delete(p); changed.push(p); }
    this.shas = shas;
    return changed;
  }

  async update(rel, fn, message, current) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = this.shas.get(rel);
      const base = attempt === 0 ? current : (sha ? await this.blob(sha) : undefined);
      const text = fn(base);
      try {
        const res = await this.gh.request("PUT", `/repos/${this.repo}/contents/${encodePath(rel)}`, {
          body: { message, content: encodeBase64(text), branch: this.branch, ...(sha ? { sha } : {}) },
        });
        this.shas.set(rel, res.content.sha);
        if (this.cache) await this.cache.set(res.content.sha, text);
        return text;
      } catch (e) {
        if (!(e.status === 409 || e.status === 422) || attempt === 2) throw e;
        // кто-то (Obsidian на телефоне) успел изменить файл — перечитываем и применяем правку заново
        const fresh = await this.gh.request("GET", `/repos/${this.repo}/contents/${encodePath(rel)}`,
          { query: { ref: this.branch } }).catch(() => null);
        if (fresh && fresh.sha) this.shas.set(rel, fresh.sha); else this.shas.delete(rel);
      }
    }
    throw new VaultError("не удалось сохранить заметку");
  }
}

export function encodePath(rel) { return rel.split("/").map(encodeURIComponent).join("/"); }

export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
