// Менеджер заметок в ядре для iPhone — то же, что jarvis/notes.py: дерево, теги, обратные ссылки, шаблоны,
// переименование и перемещение с правкой [[ссылок]], корзина Obsidian (.trash/).
import { TEXT_EXT, VaultError, parseFrontmatter, title } from "./vault.js";

const LINK = /\[\[([^\]|#^]+)([#^][^\]|]*)?(\|[^\]]*)?\]\]/g;
const TAG = /(?<![\w/а-яё])#([\wа-яё][\wа-яё/-]*)/gi;
export const TEMPLATES = "Templates";
const NOTE_EXT = [".md", ".txt"];

const ext = (rel) => { const m = /\.[^./]+$/.exec(rel); return m ? m[0].toLowerCase() : ""; };
const noExt = (rel) => (ext(rel) ? rel.slice(0, -ext(rel).length) : rel);
const folderOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export function noteTags(text) {
  const [meta, body] = parseFrontmatter(text);
  const raw = meta.tags ?? meta.tag ?? [];
  const found = (Array.isArray(raw) ? raw : String(raw).replace(/,/g, " ").split(/\s+/)).map((t) => String(t).replace(/^#/, ""));
  let inCode = false;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) { inCode = !inCode; continue; }
    if (!inCode) for (const m of line.replace(/`[^`]*`/g, " ").matchAll(TAG)) found.push(m[1]);
  }
  const out = [];
  for (let t of found) {
    t = t.trim().toLowerCase();
    if (t && !/^\d+$/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

export const linkTargets = (text) => [...text.matchAll(LINK)].map((m) => m[1].trim());

/** [[Старое]] → [[Новое]], [[Папка/Старое|подпись]] → [[НоваяПапка/Новое|подпись]] — как rewrite_links в Python. */
export function rewriteLinks(text, oldRel, newRel) {
  const oldTitle = title(oldRel).toLowerCase(), oldPath = noExt(oldRel).toLowerCase();
  const newTitle = title(newRel), newPath = noExt(newRel);
  return text.replace(LINK, (whole, target, sect, alias) => {
    const t = target.trim();
    const low = TEXT_EXT.includes(ext(t)) ? noExt(t).toLowerCase() : t.toLowerCase();
    let repl;
    if (t.includes("/")) { if (low !== oldPath) return whole; repl = newPath; } else { if (low !== oldTitle) return whole; repl = newTitle; }
    return `[[${repl}${sect || ""}${alias || ""}]]`;
  });
}

const pad = (v) => String(v).padStart(2, "0");
export function fillTemplate(text, name, now) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return text.replaceAll("{{title}}", name).replaceAll("{{date}}", date).replaceAll("{{time}}", `${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

export class Notes {
  constructor(vault, { templates = TEMPLATES } = {}) {
    this.vault = vault;
    this.templates = templates.replace(/^\/+|\/+$/g, "");
    this.cache = null;
  }

  /** Всё хранилище одним ответом: файлы с тегами и типом, папки, шаблоны, теги со счётчиком. mtime на iPhone не известен. */
  index() {
    if (this.cache && this.cache.v === this.vault.version) return this.cache.res;
    const files = [], counts = new Map();
    for (const rel of this.vault.list("", TEXT_EXT)) {
      const text = this.vault.files.get(rel) ?? "";
      const isNote = NOTE_EXT.includes(ext(rel));
      const [meta] = isNote ? parseFrontmatter(text) : [{}];
      const tags = isNote ? noteTags(text) : [];
      for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
      files.push({ path: rel, title: title(rel), folder: folderOf(rel), ext: ext(rel),
        size: new TextEncoder().encode(text).length, mtime: null, tags, type: String(meta.type || ""),
        links: isNote ? linkTargets(text) : [] });
    }
    const res = { files, folders: this.vault.listDirs(),
      templates: files.filter((f) => f.path.startsWith(`${this.templates}/`) && f.ext === ".md").map((f) => f.path),
      tags: [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tag, count]) => ({ tag, count })) };
    this.cache = { v: this.vault.version, res };
    return res;
  }

  backlinks(rel) {
    const t = title(rel).toLowerCase(), p = noExt(rel).toLowerCase();
    const out = [];
    for (const other of this.vault.list()) {
      if (other === rel) continue;
      const hit = linkTargets(this.vault.files.get(other)).some((x) => {
        const low = x.toLowerCase().endsWith(".md") ? noExt(x).toLowerCase() : x.toLowerCase();
        return low === (x.includes("/") ? p : t);
      });
      if (hit) out.push({ path: other, title: title(other) });
    }
    return out;
  }

  /** Заметки, на которые ссылается эта, — как outlinks в Python. */
  outlinks(rel) {
    const titles = new Map();
    for (const f of this.index().files) {
      if (!titles.has(f.title.toLowerCase())) titles.set(f.title.toLowerCase(), f.path);
      if (!titles.has(noExt(f.path).toLowerCase())) titles.set(noExt(f.path).toLowerCase(), f.path);
    }
    const out = [];
    for (const t of linkTargets(this.vault.files.get(rel) ?? "")) {
      const low = TEXT_EXT.includes(ext(t)) ? noExt(t).toLowerCase() : t.toLowerCase();
      const dst = titles.get(low) || titles.get(low.split("/").pop());
      if (dst && dst !== rel && !out.some((o) => o.path === dst)) out.push({ path: dst, title: title(dst) });
    }
    return out;
  }

  async create(rel, { template = null, now, content = null } = {}) {
    rel = String(rel || "").trim().replace(/^\/+|\/+$/g, "");
    if (!rel) throw new VaultError("введите название заметки");
    if (!ext(rel)) rel += ".md";
    if (!NOTE_EXT.includes(ext(rel))) throw new VaultError("создавать можно заметки .md и .txt");
    if (this.vault.exists(rel)) throw new VaultError(`заметка «${rel}» уже есть`);
    const name = title(rel);
    if (content == null) content = template ? fillTemplate(this.vault.read(template), name, now) : `# ${name}\n\n`;
    const out = await this.vault.write(rel, content, `Atom: новая заметка ${rel}`);
    this.vault.dirs.delete(folderOf(out));
    return out;
  }

  mkdir(rel) { return this.vault.mkdir(rel); }

  async move(src, dst) {
    src = String(src || "").trim().replace(/^\/+|\/+$/g, "");
    dst = String(dst || "").trim().replace(/^\/+|\/+$/g, "");
    const isDir = !this.vault.exists(src) && this.vault.isDir(src);
    if (!isDir && ext(dst) !== ext(src)) dst += ext(src);
    if (src === dst) return { path: dst, moved: 0, updated: [] };
    const moved = await this.vault.move(src, dst);
    const renames = moved.filter(([a]) => a.endsWith(".md"));
    const updated = [];
    if (renames.length) {
      for (const rel of this.vault.list()) {
        const text = this.vault.files.get(rel);
        let next = text;
        for (const [a, b] of renames) next = rewriteLinks(next, a, b);
        if (next !== text) { await this.vault.write(rel, next, `Atom: ссылки на ${dst}`); updated.push(rel); }
      }
    }
    return { path: dst, moved: moved.length, updated };
  }

  async trash(rel) { return { path: rel, trash: await this.vault.trash(rel) }; }
}
