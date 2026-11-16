// Умный синтез проектов — порт jarvis/synthesis.py (те же правила и тот же ответ, тест — tests/js/synthesis.test.mjs):
// какие заметки относятся к проектам (заметка, папка, тег, ссылка [[Проект]], задачи с тегом) и что в хранилище
// похоже на ещё не оформленный проект (type: project вне Projects/, тег, папка, узел ссылок). highlight — подсветка.

const SYSTEM_DIRS = new Set(["jarvis", "atom", "journal", "finance", "tasks", "templates", ".trash", ".obsidian",
  "attachments", "daily", "archive", "архив"]);
const GENERIC_DIRS = new Set(["notes", "заметки", "ideas", "идеи", "inbox", "входящие", "misc", "разное", "resources",
  "ресурсы", "people", "люди", "projects", "проекты", "areas", "сферы", "references", "files", "файлы"]);
const STOP_TAGS = new Set(["todo", "inbox", "idea", "ideas", "идея", "идеи", "daily", "journal", "важно", "important",
  "встреча", "meeting", "заметка", "note", "draft", "черновик", "project", "проект", "task", "задача"]);
const MIN_TAG_NOTES = 2, MIN_TAG_WEIGHT = 3, MIN_FOLDER_NOTES = 3, MIN_HUB_LINKS = 3, LIMIT = 12;

/** Как slug в Python (re \w — буквы, цифры, _): «Сайт студии» → «сайт-студии». */
export const slug = (name) => String(name).trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-")
  .replace(/^[-_]+|[-_]+$/g, "") || "project";
const key = (name) => slug(name).replace(/ё/g, "е").replace(/_/g, "-");
export function tagTitle(tag) {
  const words = tag.replace(/[-_/]+/g, " ").trim();
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}
const ext = (rel) => { const m = /\.[^./]+$/.exec(rel); return m ? m[0].toLowerCase() : ""; };
const noExt = (rel) => (ext(rel) ? rel.slice(0, -ext(rel).length) : rel);
const stem = (rel) => noExt(rel.split("/").pop());
const isSystem = (rel) => { const top = rel.split("/")[0].toLowerCase(); return SYSTEM_DIRS.has(top) || top.startsWith("."); };
const isDigits = (s) => /^\d+$/.test(s);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (it) => [...it].sort(cmp);
const getSet = (map, k) => { if (!map.has(k)) map.set(k, new Set()); return map.get(k); };

/** files — index().files; projects — { name, note, tag, status }; tasks — { path, tags, open }. */
export function synthesize(files, projects, tasks, { projectsDir = "Projects", limit = LIMIT } = {}) {
  projectsDir = projectsDir.replace(/^\/+|\/+$/g, "");
  const notes = files.filter((f) => [".md", ".txt"].includes(f.ext ?? ext(f.path)));
  const byPath = new Map(notes.map((f) => [f.path, f]));
  const byTitle = new Map();
  for (const f of notes) {
    if (!byTitle.has(f.title.toLowerCase())) byTitle.set(f.title.toLowerCase(), f.path);
    if (!byTitle.has(noExt(f.path).toLowerCase())) byTitle.set(noExt(f.path).toLowerCase(), f.path);
  }
  const resolve = (target) => {
    const t = /\.(md|txt)$/i.test(target) ? noExt(target.trim()).toLowerCase() : target.trim().toLowerCase();
    return byTitle.get(t) || byTitle.get(t.split("/").pop()) || null;
  };

  const linkedBy = new Map();
  for (const f of notes) {
    for (const target of f.links || []) {
      const dst = resolve(target);
      if (dst && dst !== f.path) getSet(linkedBy, dst).add(f.path);
    }
  }
  const taskTags = new Map(), openByTag = new Map();
  for (const t of tasks) {
    for (const tag of t.tags || []) {
      getSet(taskTags, t.path).add(tag);
      if (t.open) openByTag.set(tag, (openByTag.get(tag) || 0) + 1);
    }
  }

  // ---------- 1. заметки существующих проектов ----------
  // оглавление (Home.md со ссылками на все проекты) — не заметка какого-то одного проекта
  const projectNotes = new Set(projects.map((p) => p.note));
  const hubs = new Set(notes.filter((f) => new Set((f.links || []).map(resolve).filter((d) => projectNotes.has(d))).size > 1)
    .map((f) => f.path));
  const outProjects = [], highlight = {};
  const taken = new Set(), projectKeys = new Set();
  for (const p of projects) {
    const note = p.note, tag = (p.tag || slug(p.name)).toLowerCase();
    const folder = `${noExt(note)}/`;
    projectKeys.add(key(p.name)); projectKeys.add(key(tag));
    let members = new Set([note]);
    for (const f of notes) {
      if (f.path.startsWith(folder) || (f.tags || []).includes(tag) || taskTags.get(f.path)?.has(tag)) members.add(f.path);
    }
    for (const x of linkedBy.get(note) || []) if (!hubs.has(x)) members.add(x);
    for (const t of byPath.get(note)?.links || []) { const dst = resolve(t); if (dst) members.add(dst); }   // «Материалы»
    members = new Set([...members].filter((m) => byPath.has(m)));
    const ordered = [note, ...sorted([...members].filter((m) => m !== note))];
    outProjects.push({ name: p.name, note, tag, status: p.status || "active", notes: ordered, open_tasks: openByTag.get(tag) || 0 });
    for (const rel of ordered) if (!(rel in highlight)) highlight[rel] = { kind: "project", project: p.name };
    for (const m of members) taken.add(m);
  }

  // ---------- 2. кандидаты ----------
  const cands = new Map();
  const add = (name, kind, reason, members, { tag = "", weight = 0 } = {}) => {
    const k = key(tag || name);
    if (!k || projectKeys.has(k)) return;
    if (!cands.has(k)) cands.set(k, { name, tag: tag || slug(name), kinds: [], reasons: [], notes: new Set(), bonus: 0 });
    const c = cands.get(k);
    if (!c.kinds.includes(kind)) c.kinds.push(kind);
    c.reasons.push(reason);
    for (const m of members) c.notes.add(m);
    c.bonus += weight;
    if (kind === "note" || kind === "folder") c.name = name;
  };
  const free = (rel) => !taken.has(rel) && !isSystem(rel);
  const inProjects = projectsDir ? `${projectsDir}/` : "";

  for (const f of notes) {
    if (f.type === "project" && !f.path.startsWith(inProjects) && free(f.path)) {
      add(f.title, "note", "заметка помечена как проект (type: project)",
        [f.path, ...[...(linkedBy.get(f.path) || [])].filter(free)], { weight: 5 });
    }
  }

  const tagNotes = new Map();
  for (const f of notes) {
    if (!free(f.path)) continue;
    for (const tag of new Set([...(f.tags || []), ...(taskTags.get(f.path) || [])])) getSet(tagNotes, tag).add(f.path);
  }
  for (const [tag, members] of tagNotes) {
    if (STOP_TAGS.has(tag) || isDigits(tag) || tag.length < 3) continue;
    const opened = openByTag.get(tag) || 0;
    if (members.size >= MIN_TAG_NOTES && members.size + opened >= MIN_TAG_WEIGHT) {
      add(tagTitle(tag), "tag", `тег #${tag}: заметок — ${members.size}, открытых задач — ${opened}`, members, { tag, weight: opened });
    }
  }

  const folders = new Map();
  for (const f of notes) {
    if (free(f.path) && f.folder && !f.path.startsWith(inProjects)) {
      const parts = f.folder.split("/");
      for (let i = 1; i <= parts.length; i++) getSet(folders, parts.slice(0, i).join("/")).add(f.path);
    }
  }
  for (const [folder, members] of folders) {
    const name = folder.split("/").pop();
    if (members.size < MIN_FOLDER_NOTES || SYSTEM_DIRS.has(name.toLowerCase()) || GENERIC_DIRS.has(name.toLowerCase()) || name.startsWith(".")) continue;
    const children = [...folders.keys()].filter((d) => d.startsWith(`${folder}/`));
    if (children.some((d) => folders.get(d).size === members.size)) continue;
    if (!folder.includes("/") && children.length >= 2) continue;
    add(name, "folder", `папка ${folder}/: заметок — ${members.size}`, members, { weight: 1 });
  }

  for (const [rel, sources] of linkedBy) {
    const src = [...sources].filter(free);
    if (free(rel) && src.length >= MIN_HUB_LINKS) {
      add(byPath.get(rel).title, "hub", `на заметку ссылаются ${src.length} других`, [rel, ...src], { weight: 1 });
    }
  }

  let candidates = [];
  for (const c of cands.values()) {
    const members = sorted([...c.notes].filter((m) => byPath.has(m) && !taken.has(m)));
    if (!members.length) continue;
    candidates.push({ name: c.name, tag: c.tag, kinds: c.kinds, reasons: c.reasons, notes: members,
      open_tasks: openByTag.get(c.tag) || 0, score: members.length + c.bonus + 2 * (c.kinds.length - 1) });
  }
  candidates.sort((a, b) => b.score - a.score || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
  candidates = candidates.slice(0, limit);
  for (const c of candidates) for (const rel of c.notes) if (!(rel in highlight)) highlight[rel] = { kind: "candidate", project: c.name };
  return { projects: outProjects, candidates, highlight };
}

/** Текст новой заметки проекта из кандидата — как description() в Python. */
export function description(c) {
  const links = c.notes.slice(0, 30).map((rel) => `- [[${noExt(rel)}|${stem(rel)}]]`).join("\n");
  return `Собран синтезом проектов: ${c.reasons.join("; ")}.\n\n## Материалы\n${links}`;
}
