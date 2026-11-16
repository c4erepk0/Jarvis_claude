// Хранилище — менеджер заметок и проектов: дерево папок, теги, недавние, поиск по названию и тексту,
// заметки (просмотр и правка — та же панель, что в голограмме), новые заметки по шаблонам, папки,
// переименование и перемещение (и перетаскиванием) с правкой [[ссылок]], корзина Obsidian; страница проекта —
// статус, прогресс, задачи, заметки проекта, журнал; синтез проектов — заметки проектов и «спрятанные» проекты
// подсвечиваются в дереве, кандидата можно оформить проектом. Всё через те же /api/…, поэтому работает и на iPhone без сервера.
import { esc } from "./markdown.js?v=17";
import { NotePanel } from "./note-panel.js?v=17";
import { buildTree, filterFiles, markSynthesis, moveTarget, nameOf, parentOf, pushRecent, renameTarget } from "./file-tree.js?v=17";

const STATUS = { idea: "ИДЕЯ", active: "В РАБОТЕ", paused: "НА ПАУЗЕ", done: "ЗАВЕРШЁН" };
const KIND = { note: "type: project", tag: "тег", folder: "папка", hub: "узел ссылок" };
const ICON = { ".md": "▤", ".txt": "▤", ".canvas": "◫", ".csv": "▦", ".json": "{}" };
const kb = (n) => (n < 1024 ? `${n} Б` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`);
const ago = (t) => {
  if (!t) return "";
  const s = Date.now() / 1000 - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} мин`;
  if (s < 86400) return `${Math.round(s / 3600)} ч`;
  return new Date(t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
};

export class FileManager {
  /**
   * root — пустой #fm; api, toast — как в app.js; store — localStorage-обёртка (недавние, раскрытые папки);
   * projects() — список проектов из состояния; openHolo(path) — показать заметку в голограмме;
   * delegate(name) — окно поручения Claude; dictate — диктовка для панели заметки; today() — ГГГГ-ММ-ДД.
   */
  constructor(root, { api, toast, store, projects, openHolo, delegate, dictate = null, today }) {
    Object.assign(this, { root, api, toast, store, projects, openHolo, delegate });
    this.index = { files: [], folders: [], templates: [], tags: [] };
    this.syn = { projects: [], candidates: [], highlight: {} };
    this.marks = new Map();
    this.side = store.get("fm.side", "tree");
    this.open = new Set(store.get("fm.open", ["Projects"]));
    this.recent = store.get("fm.recent", []);
    this.view = { kind: "folder", path: "" };
    this.dragging = null;
    root.innerHTML = `
      <div class="fm-top">
        <div class="fm-title">ХРАНИЛИЩЕ <span class="muted" data-el="stats"></span></div>
        <input class="fm-search" type="search" data-el="search" placeholder="Поиск: название, путь, текст, #тег…" autocomplete="off" enterkeyhint="search">
        <div class="fm-actions">
          <button class="btn ghost" data-fm="new-note" title="Новая заметка">＋<span class="lbl"> ЗАМЕТКА</span></button>
          <button class="btn ghost" data-fm="new-folder" title="Новая папка">＋<span class="lbl"> ПАПКА</span></button>
          <button class="btn ghost" data-fm="new-project" title="Новый проект">＋<span class="lbl"> ПРОЕКТ</span></button>
          <button class="btn ghost" data-fm="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
        </div>
      </div>
      <div class="fm-body">
        <nav class="fm-side">
          <div class="seg" data-el="seg">
            <button data-side="tree">ПАПКИ</button><button data-side="projects">ПРОЕКТЫ</button><button data-side="synthesis" title="Синтез проектов">СИНТЕЗ</button><button data-side="tags">ТЕГИ</button><button data-side="recent">НЕДАВНИЕ</button>
          </div>
          <div class="fm-side-list" data-el="side"></div>
        </nav>
        <section class="fm-main" data-el="main"></section>
      </div>
      <div class="fm-dialog hidden" data-el="dialog"></div>`;
    this.el = (name) => root.querySelector(`[data-el="${name}"]`);
    this.notes = new NotePanel(root.querySelector(".fm-body"), {
      api, toast, today, dictate,
      resolve: (name) => this.resolve(name),
      onShow: (path) => { if (path) this.visit(path); this.root.classList.add("reading"); this.markActive(); },
      onClose: () => { this.root.classList.remove("reading"); this.markActive(); },
      onCreated: () => this.reload(),
      templates: () => this.index.templates,
      onTag: (tag) => { this.notes.close(); this.show({ kind: "tag", tag }); },
      extraActions: (n) => `<button class="btn ghost" data-act="fm-rename" title="Переименовать">✎<span class="lbl"> ИМЯ</span></button>
        <button class="btn ghost" data-act="fm-move" title="Переместить в папку">⇄</button>
        <button class="btn ghost" data-act="fm-holo" title="Показать в голограмме">◈</button>
        <button class="btn ghost danger" data-act="fm-trash" title="В корзину">🗑</button>`,
      onAction: (act, n) => this.noteAction(act, n),
    });
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => this.onChange(e));
    this.el("search").addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.search(this.el("search").value), 220);
    });
    root.addEventListener("keydown", (e) => {
      if ((e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"))
        && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
        e.preventDefault(); this.el("search").focus();
      }
    });
    this.el("dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) this.closeDialog(); });
    this.setupDrag();
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  // ---------- открыть / закрыть ----------
  async show(view = null) {
    this.root.classList.remove("hidden");
    document.body.classList.add("fm-on");
    if (view) {
      this.view = view;
      if (view.kind !== "search") this.el("search").value = "";
    }
    if (!this.loaded) { await this.reload(); this.loaded = true; } else this.render();
  }

  async openNote(path, opts) { await this.show(); return this.notes.open(path, opts); }

  close() {
    if (!this.notes.close()) return false;     // несохранённые правки — владелец передумал
    this.closeDialog();
    this.root.classList.add("hidden");
    document.body.classList.remove("fm-on");
    return true;
  }

  /** Esc: диалог → заметка → само окно. */
  escape() {
    if (!this.el("dialog").classList.contains("hidden")) { this.closeDialog(); return; }
    if (this.notes.isOpen) { if (this.notes.mode === "view") this.notes.close(); return; }
    this.close();
  }

  async reload() {
    try {
      this.index = await this.api("/api/files");
    } catch (e) { this.toast(`Хранилище недоступно: ${e.message}`, "error"); return; }
    try {
      this.syn = await this.api("/api/synthesis");
    } catch { this.syn = { projects: [], candidates: [], highlight: {} }; }   // старый сервер — без подсветки
    this.marks = markSynthesis(this.syn.highlight);
    this.titles = new Map();
    for (const f of this.index.files) {
      this.titles.set(f.title.toLowerCase(), f.path);
      this.titles.set(f.path.replace(/\.[^./]+$/, "").toLowerCase(), f.path);
    }
    this.render();
  }

  /** Что-то изменилось (Obsidian, голос, другой дашборд) — перечитать, если окно открыто. */
  refresh() {
    if (!this.isOpen) { this.loaded = false; return; }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.reload(); this.notes.refresh(); }, 300);
  }

  resolve(name) {
    const key = String(name).toLowerCase();
    return this.titles?.get(key) || this.titles?.get(key.split("/").pop()) || null;
  }

  visit(path) {
    this.recent = pushRecent(this.recent, path, 30);
    this.store.set("fm.recent", this.recent);
  }

  // ---------- отрисовка ----------
  render() {
    const md = this.index.files.filter((f) => f.ext === ".md").length;
    this.el("stats").textContent = `${md} заметок · ${this.index.folders.length} папок`;
    this.renderSide();
    this.renderMain();
  }

  renderSide() {
    this.el("seg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.side === this.side));
    const el = this.el("side");
    if (this.side === "tree") {
      const tree = buildTree(this.index);
      const node = (n, depth) => {
        if (n.type === "file") {
          return `<div class="fm-node file${this.synClass(n.path)}" draggable="true" data-path="${esc(n.path)}" style="--d:${depth}"${this.synTitle(n.path)}>
            <span class="ic">${ICON[n.file.ext] || "·"}</span><span class="nm">${esc(n.name)}</span></div>`;
        }
        const open = this.open.has(n.path);
        return `<div class="fm-node dir ${open ? "open" : ""}${this.synClass(n.path)}" draggable="true" data-dir="${esc(n.path)}" style="--d:${depth}"${this.synTitle(n.path)}>
            <span class="ic">${open ? "▾" : "▸"}</span><span class="nm">${esc(n.name)}</span><small>${n.count || ""}</small></div>
          ${open ? n.children.map((c) => node(c, depth + 1)).join("") : ""}`;
      };
      el.innerHTML = `<div class="fm-node dir root" data-dir="" style="--d:0"><span class="ic">⌂</span><span class="nm">Хранилище</span>
        <small>${this.index.files.length}</small></div>${tree.children.map((c) => node(c, 1)).join("")}`;
    } else if (this.side === "projects") {
      const list = this.projects();
      const order = ["active", "idea", "paused", "done"];
      el.innerHTML = (list.length ? order.map((st) => {
        const ps = list.filter((p) => (p.status || "active") === st);
        return ps.length ? `<div class="fm-group">${STATUS[st]}</div>${ps.map((p) => `
          <div class="fm-node proj" data-project="${esc(p.name)}" style="--d:0"><span class="dot st-${esc(st)}"></span>
          <span class="nm">${esc(p.name)}</span></div>`).join("")}` : "";
      }).join("") : `<p class="empty">Проектов пока нет.</p>`)
        + `<button class="btn ghost fm-wide" data-fm="new-project">＋ НОВЫЙ ПРОЕКТ</button>`;
    } else if (this.side === "synthesis") {
      const { candidates, projects } = this.syn;
      el.innerHTML = `<button class="fm-node syn-candidate" data-syn="" style="--d:0"><span class="ic">✦</span><span class="nm">Обзор синтеза</span></button>
        <div class="fm-group">ПОХОЖЕ НА ПРОЕКТ · ${candidates.length}</div>
        ${candidates.map((c) => `<div class="fm-node syn-candidate" data-syn="${esc(c.name)}" style="--d:0" title="${esc(c.reasons.join("; "))}">
          <span class="ic">✦</span><span class="nm">${esc(c.name)}</span><small>${c.notes.length}</small></div>`).join("")
          || '<p class="empty">Новых проектов не видно.</p>'}
        <div class="fm-group">ПРОЕКТЫ</div>
        ${projects.map((p) => `<div class="fm-node proj syn-project" data-project="${esc(p.name)}" style="--d:0">
          <span class="ic">◆</span><span class="nm">${esc(p.name)}</span><small>${p.notes.length}</small></div>`).join("")}`;
    } else if (this.side === "tags") {
      el.innerHTML = this.index.tags.length ? `<div class="fm-tags">${this.index.tags.map((t) => `
        <button class="tag" data-tag="${esc(t.tag)}">#${esc(t.tag)} <small>${t.count}</small></button>`).join("")}</div>`
        : `<p class="empty">Тегов нет. Добавьте #тег в заметку или поле tags.</p>`;
    } else {
      const known = new Set(this.index.files.map((f) => f.path));
      const items = this.recent.filter((p) => known.has(p));
      el.innerHTML = items.length ? items.map((p) => `<div class="fm-node file" draggable="true" data-path="${esc(p)}" style="--d:0">
        <span class="ic">▤</span><span class="nm">${esc(nameOf(p).replace(/\.[^.]+$/, ""))}</span><small>${esc(parentOf(p))}</small></div>`).join("")
        : `<p class="empty">Здесь будут заметки, которые вы открывали.</p>`;
    }
    this.markActive();
  }

  markActive() {
    const path = this.notes?.path;
    this.el("side").querySelectorAll(".fm-node").forEach((n) => {
      n.classList.toggle("on", (path && n.dataset.path === path) || (this.view.kind === "folder" && n.dataset.dir === this.view.path)
        || (this.view.kind === "project" && n.dataset.project === this.view.name)
        || (this.view.kind === "tag" && n.dataset.tag === this.view.tag)
        || (this.view.kind === "synthesis" && n.dataset.syn === (this.view.name || "")));
    });
  }

  crumbs(path) {
    const parts = path ? path.split("/") : [];
    return `<nav class="fm-crumbs"><a href="#" data-dir="">⌂</a>${parts.map((p, i) =>
      ` / <a href="#" data-dir="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("")}</nav>`;
  }

  row(f, { snippet = "", showFolder = false } = {}) {
    return `<li class="fm-row${this.synClass(f.path)}" draggable="true" data-path="${esc(f.path)}"${this.synTitle(f.path)}>
      <span class="ic">${ICON[f.ext] || "·"}</span>
      <div class="fm-row-main"><b>${esc(f.title)}</b>${this.synBadge(f.path)}${showFolder && f.folder ? `<small class="muted"> · ${esc(f.folder)}</small>` : ""}
        ${snippet ? `<small class="fm-snip">${esc(snippet)}</small>` : ""}
        ${(f.tags || []).length ? `<span class="fm-row-tags">${f.tags.slice(0, 4).map((t) => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join("")}</span>` : ""}</div>
      <small class="muted fm-row-meta">${f.mtime ? ago(f.mtime) + " · " : ""}${kb(f.size || 0)}</small>
      <span class="fm-row-acts">
        <button class="h-btn" data-row="rename" title="Переименовать">✎</button>
        <button class="h-btn" data-row="move" title="Переместить">⇄</button>
        <button class="h-btn danger" data-row="trash" title="В корзину">🗑</button>
      </span></li>`;
  }

  renderMain() {
    const v = this.view, el = this.el("main");
    if (v.kind === "project") { this.renderProject(); return; }
    if (v.kind === "synthesis") { this.renderSynthesis(); return; }
    if (v.kind === "folder") {
      if (v.path && !this.index.folders.includes(v.path)) v.path = parentOf(v.path);    // папку переместили / удалили
      const subs = this.index.folders.filter((f) => parentOf(f) === v.path);
      const files = filterFiles(this.index.files, { folder: v.path });
      el.innerHTML = `<div class="fm-head">${this.crumbs(v.path)}
          <div class="fm-head-acts">
            <button class="btn ghost" data-fm="new-note">＋ ЗАМЕТКА</button><button class="btn ghost" data-fm="new-folder">＋ ПАПКА</button>
            ${v.path ? `<button class="btn ghost" data-fm="rename-dir">✎ ИМЯ</button><button class="btn ghost" data-fm="move-dir">⇄</button>
              <button class="btn ghost danger" data-fm="trash-dir">🗑</button>` : ""}
          </div></div>
        <ul class="fm-list" data-drop="${esc(v.path)}">
          ${subs.map((d) => `<li class="fm-row dir${this.synClass(d)}" draggable="true" data-dir="${esc(d)}"${this.synTitle(d)}><span class="ic">▸</span>
            <div class="fm-row-main"><b>${esc(nameOf(d))}</b></div>
            <small class="muted fm-row-meta">${this.index.files.filter((f) => f.path.startsWith(`${d}/`)).length} файлов</small></li>`).join("")}
          ${files.map((f) => this.row(f)).join("")}
          ${!subs.length && !files.length ? `<li class="empty">Пустая папка. Перетащите сюда заметки или создайте новую.</li>` : ""}
        </ul>`;
      return;
    }
    if (v.kind === "tag") {
      const files = filterFiles(this.index.files, { tag: v.tag });
      el.innerHTML = `<div class="fm-head"><nav class="fm-crumbs"><a href="#" data-dir="">⌂</a> / <b>#${esc(v.tag)}</b></nav></div>
        <ul class="fm-list">${files.map((f) => this.row(f, { showFolder: true })).join("") || '<li class="empty">Нет заметок с этим тегом.</li>'}</ul>`;
      return;
    }
    if (v.kind === "search") {
      const byName = filterFiles(this.index.files, { query: v.query }).slice(0, 40);
      const seen = new Set(byName.map((f) => f.path));
      const byText = (v.hits || []).filter((h) => !seen.has(h.path)).map((h) => ({ f: this.index.files.find((x) => x.path === h.path), h }))
        .filter((x) => x.f);
      el.innerHTML = `<div class="fm-head"><nav class="fm-crumbs"><a href="#" data-dir="">⌂</a> / поиск «${esc(v.query)}»</nav></div>
        ${byName.length ? `<div class="fm-group">ПО НАЗВАНИЮ · ${byName.length}</div><ul class="fm-list">${byName.map((f) => this.row(f, { showFolder: true })).join("")}</ul>` : ""}
        ${byText.length ? `<div class="fm-group">В ТЕКСТЕ · ${byText.length}</div><ul class="fm-list">${byText.map(({ f, h }) => this.row(f, { showFolder: true, snippet: h.snippet })).join("")}</ul>` : ""}
        ${!byName.length && !byText.length ? `<p class="empty">Ничего не нашлось. <button class="btn ghost" data-fm="new-note" data-name="${esc(v.query)}">＋ СОЗДАТЬ «${esc(v.query)}»</button></p>` : ""}`;
    }
  }

  async search(q) {
    q = q.trim();
    if (!q) { this.show({ kind: "folder", path: this.lastFolder || "" }); return; }
    if (q.startsWith("#") && q.length > 1) { this.show({ kind: "tag", tag: q.slice(1).toLowerCase() }); return; }
    this.view = { kind: "search", query: q, hits: [] };
    this.renderMain();
    try {
      const r = await this.api(`/api/memory?q=${encodeURIComponent(q)}`);
      if (this.view.kind === "search" && this.view.query === q) { this.view.hits = r.hits || []; this.renderMain(); }
    } catch { /* поиск по тексту недоступен — остаются совпадения по названию */ }
  }

  // ---------- синтез проектов ----------
  synClass(path) { const m = this.marks.get(path); return m ? ` syn-${m.kind}` : ""; }
  synTitle(path) {
    const m = this.marks.get(path);
    return m ? ` title="${esc(m.kind === "project" ? `Проект ${m.project}` : `Похоже на проект «${m.project}» — синтез`)}"` : "";
  }
  synBadge(path) {
    const m = this.marks.get(path);
    return m ? `<span class="syn-badge ${m.kind}">${m.kind === "project" ? "◆" : "✦"} ${esc(m.project)}</span>` : "";
  }

  renderSynthesis() {
    const el = this.el("main"), { candidates, projects } = this.syn;
    const only = this.view.name ? candidates.filter((c) => c.name === this.view.name) : candidates;
    const byPath = new Map(this.index.files.map((f) => [f.path, f]));
    const card = (c) => `<section class="syn-card" data-syn-card="${esc(c.name)}">
        <div class="syn-card-h"><span class="syn-mark">✦</span><b>${esc(c.name)}</b>
          <span class="tag">#${esc(c.tag)}</span>${c.kinds.map((k) => `<span class="syn-kind">${esc(KIND[k] || k)}</span>`).join("")}
          <button class="btn primary" data-syn-create="${esc(c.name)}">◆ ОФОРМИТЬ ПРОЕКТОМ</button></div>
        <p class="muted syn-why">${c.reasons.map(esc).join(" · ")}${c.open_tasks ? ` · открытых задач: ${c.open_tasks}` : ""}</p>
        <ul class="fm-list">${c.notes.map((p) => byPath.get(p)).filter(Boolean).map((f) => this.row(f, { showFolder: true })).join("")}</ul>
      </section>`;
    el.innerHTML = `<div class="fm-head"><nav class="fm-crumbs"><a href="#" data-syn="">СИНТЕЗ ПРОЕКТОВ</a>${this.view.name ? ` / <b>${esc(this.view.name)}</b>` : ""}</nav>
        <div class="fm-head-acts"><button class="btn ghost" data-fm="synthesis-refresh">↻ ПЕРЕСЧИТАТЬ</button></div></div>
      ${this.view.name ? "" : `<p class="fm-proj-desc">Atom просмотрел хранилище: теги, папки, ссылки и поле <code>type</code>.
        <span class="syn-legend"><span class="syn-badge project">◆ проект</span> — заметка уже относится к проекту,
        <span class="syn-badge candidate">✦ кандидат</span> — похоже на проект, который ещё не оформлен. Подсветка видна и в дереве папок.</span></p>`}
      ${only.map(card).join("") || '<p class="empty">Всё, что похоже на проекты, уже оформлено. Новые появятся, когда у темы наберутся заметки, теги или ссылки.</p>'}
      ${this.view.name ? "" : `<div class="fm-group">ПРОЕКТЫ И ИХ ЗАМЕТКИ</div>
        <ul class="fm-list">${projects.map((p) => `<li class="fm-row syn-project" data-project="${esc(p.name)}"><span class="ic">◆</span>
          <div class="fm-row-main"><b>${esc(p.name)}</b> <span class="tag">#${esc(p.tag)}</span></div>
          <small class="muted fm-row-meta">${p.notes.length} заметок${p.open_tasks ? ` · ${p.open_tasks} задач` : ""}</small></li>`).join("")}</ul>`}`;
  }

  async createFromSynthesis(name) {
    const c = this.syn.candidates.find((x) => x.name === name);
    if (!c) return;
    const d = await this.ask("ОФОРМИТЬ ПРОЕКТОМ", `<p>Будет создана заметка <b>Projects/${esc(c.name)}.md</b> с тегом #${esc(c.tag)}
      и ссылками на ${c.notes.length} ${c.notes.length === 1 ? "заметку" : "заметок"}. Сами заметки останутся на месте.</p>
      <label>Статус</label><select name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === "idea" ? "selected" : ""}>${l}</option>`).join("")}</select>`,
    { ok: "ОФОРМИТЬ" });
    if (!d) return;
    const p = await this.run(() => this.api("/api/synthesis", { method: "POST", body: { name: c.name, status: d.status } }), `Проект «${c.name}» оформлен`);
    if (p) { await this.reload(); this.notes.close(); this.show({ kind: "project", name: p.name }); }
  }

  // ---------- страница проекта ----------
  async renderProject() {
    const name = this.view.name, el = this.el("main");
    if (!this.view.data) el.innerHTML = `<p class="muted">Загружаю проект ${esc(name)}…</p>`;
    let p;
    try { p = await this.api(`/api/projects/${encodeURIComponent(name)}`); } catch (e) {
      el.innerHTML = `<p class="empty">Не открыть проект: ${esc(e.message)}</p>`; return;
    }
    if (this.view.kind !== "project" || this.view.name !== name) return;
    this.view.data = p;
    const task = (t, done = false) => `<li class="task ${done ? "done" : ""} prio-${t.priority}" data-id="${esc(t.id)}" data-path="${esc(t.path)}">
      <button class="check" aria-label="Выполнено" ${done ? "disabled" : ""}></button>
      <div class="t-text">${esc(t.text)}${t.due ? `<span class="tag">📅 ${esc(t.due.slice(5))}</span>` : ""}</div></li>`;
    el.innerHTML = `<div class="fm-proj">
      <div class="fm-head"><nav class="fm-crumbs"><a href="#" data-side-go="projects">ПРОЕКТЫ</a> / <b>${esc(p.name)}</b></nav>
        <div class="fm-head-acts">
          <select data-proj="status" aria-label="Статус">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === p.status ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button class="btn ghost" data-proj="note">▤ ЗАМЕТКА</button>
          <button class="btn ghost" data-proj="folder">▸ ПАПКА</button>
          ${p.repo ? `<button class="btn" data-proj="delegate">◆ ПОРУЧИТЬ CLAUDE</button>` : ""}
        </div></div>
      ${p.description ? `<p class="fm-proj-desc">${esc(p.description)}</p>` : ""}
      <div class="fm-proj-links">${p.repo ? `<a href="https://github.com/${esc(p.repo)}" target="_blank" rel="noopener">⎇ ${esc(p.repo)}</a>` : `<button class="btn ghost" data-proj="repo">+ РЕПОЗИТОРИЙ</button>`}
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">↗ ${esc(p.url.replace(/^https?:\/\//, ""))}</a>` : ""}
        <span class="tag">#${esc(p.tag)}</span></div>
      <div class="fm-progress" title="${p.progress.done} из ${p.progress.total}"><i style="width:${p.progress.percent}%"></i>
        <span>${p.progress.percent}% · ВЫПОЛНЕНО ${p.progress.done} ИЗ ${p.progress.total}</span></div>
      <div class="fm-proj-grid">
        <section><div class="fm-group">ЗАДАЧИ · ${p.tasks.length}</div>
          <ul class="tasks">${p.tasks.map((t) => task(t)).join("") || '<li class="empty">Открытых задач нет.</li>'}</ul>
          <form class="inline-add" data-form="proj-task"><input name="text" placeholder="Новая задача проекта… («завтра», «срочно»)" autocomplete="off" required><button class="btn">+</button></form>
          ${p.done.length ? `<div class="fm-group">ГОТОВО</div><ul class="tasks">${p.done.map((t) => task(t, true)).join("")}</ul>` : ""}
        </section>
        <section><div class="fm-group">ЗАМЕТКИ · ${p.notes.length}</div>
          <ul class="fm-list">${p.notes.map((n) => { const f = this.index.files.find((x) => x.path === n.path); return f ? this.row(f, { showFolder: !n.path.startsWith(`${p.folder}/`) }) : ""; }).join("")
            || '<li class="empty">Заметок проекта пока нет.</li>'}</ul>
          <button class="btn ghost fm-wide" data-proj="new-note">＋ ЗАМЕТКА ПРОЕКТА</button>
          <div class="fm-group">ЖУРНАЛ</div>
          <ul class="fm-journal">${p.journal.map((l) => `<li>${esc(l)}</li>`).join("") || '<li class="empty">Пусто.</li>'}</ul>
        </section>
      </div></div>`;
  }

  async projectAction(act, p) {
    if (act === "note") { this.notes.open(p.note); return; }
    if (act === "folder") { this.show({ kind: "folder", path: p.folder }); return; }
    if (act === "delegate") { this.delegate(p.name); return; }
    if (act === "new-note") { this.notes.startCreate({ folder: p.folder }); return; }
    if (act === "repo") {
      const d = await this.ask("РЕПОЗИТОРИЙ ПРОЕКТА", `<label>owner/repo на GitHub</label><input name="repo" placeholder="c4erepk0/${esc(p.name)}" required>`);
      if (d) await this.run(() => this.api(`/api/projects/${encodeURIComponent(p.name)}/update`, { method: "POST", body: { key: "repo", value: d.repo } }), "Репозиторий привязан");
    }
  }

  // ---------- события ----------
  onClick(e) {
    const t = e.target;
    if (t.closest(".np")) return;                         // клики по заметке обрабатывает её панель
    const fm = t.closest("[data-fm]");
    if (fm) { e.preventDefault(); this.command(fm.dataset.fm, fm); return; }
    const side = t.closest("[data-side]");
    if (side) { this.side = side.dataset.side; this.store.set("fm.side", this.side); this.renderSide(); return; }
    const sideGo = t.closest("[data-side-go]");
    if (sideGo) { e.preventDefault(); this.side = sideGo.dataset.sideGo; this.renderSide(); this.show({ kind: "folder", path: "" }); return; }
    const synCreate = t.closest("[data-syn-create]");
    if (synCreate) { this.createFromSynthesis(synCreate.dataset.synCreate); return; }
    const syn = t.closest("[data-syn]");
    if (syn) { e.preventDefault(); if (this.notes.close()) this.show({ kind: "synthesis", name: syn.dataset.syn || null }); return; }
    const rowAct = t.closest("[data-row]");
    if (rowAct) { e.stopPropagation(); this.fileAction(rowAct.dataset.row, rowAct.closest("[data-path]").dataset.path); return; }
    const tag = t.closest("[data-tag]");
    if (tag) { e.preventDefault(); this.show({ kind: "tag", tag: tag.dataset.tag }); return; }
    const check = t.closest(".fm-proj .check");
    if (check) { this.completeTask(check.closest(".task")); return; }
    const proj = t.closest("[data-proj]");
    if (proj && proj.tagName === "BUTTON") { this.projectAction(proj.dataset.proj, this.view.data); return; }
    const pnode = t.closest("[data-project]");
    if (pnode) { if (this.notes.close()) this.show({ kind: "project", name: pnode.dataset.project }); return; }
    const dir = t.closest("[data-dir]");
    if (dir) {
      e.preventDefault();
      const path = dir.dataset.dir;
      // в дереве: треугольник или повторное нажатие на открытую папку — свернуть / развернуть
      if (dir.classList.contains("fm-node") && path && (t.closest(".ic") || (this.view.kind === "folder" && this.view.path === path))) {
        this.toggleDir(path);
        this.renderSide();
        return;
      }
      for (let p = path; p; p = parentOf(p)) this.open.add(p);
      this.store.set("fm.open", [...this.open]);
      this.lastFolder = path;
      if (this.notes.close()) this.show({ kind: "folder", path });
      return;
    }
    const task = t.closest(".fm-proj .task .t-text");
    if (task) { this.notes.open(task.closest(".task").dataset.path); return; }
    const file = t.closest("[data-path]");
    if (file) this.notes.open(file.dataset.path);
  }

  toggleDir(path) {
    if (this.open.has(path)) this.open.delete(path); else this.open.add(path);
    this.store.set("fm.open", [...this.open]);
  }

  async onSubmit(e) {
    const form = e.target.closest("[data-form]");
    if (!form || form.closest(".np")) return;
    e.preventDefault();
    if (form.dataset.form === "proj-task") {
      const input = form.querySelector("input");
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      await this.run(() => this.api(`/api/projects/${encodeURIComponent(this.view.name)}/task`, { method: "POST", body: { text } }));
      input.disabled = false;
      input.value = "";
      input.focus();
      this.renderProject();
    }
  }

  async onChange(e) {
    const sel = e.target.closest("select[data-proj=status]");
    if (!sel) return;
    await this.run(() => this.api(`/api/projects/${encodeURIComponent(this.view.name)}/update`, { method: "POST", body: { key: "status", value: sel.value } }),
      `Статус: ${STATUS[sel.value].toLowerCase()}`);
    this.renderProject();
  }

  async completeTask(li) {
    li.classList.add("done");
    try {
      await this.api(`/api/tasks/${encodeURIComponent(li.dataset.id)}/status`, { method: "POST", body: { status: "done" } });
      this.renderProject();
    } catch (err) { li.classList.remove("done"); this.toast(err.message, "error"); }
  }

  folderHere() {
    if (this.view.kind === "folder") return this.view.path;
    if (this.view.kind === "project" && this.view.data) return this.view.data.folder;
    return this.notes.path ? parentOf(this.notes.path) : "";
  }

  async command(cmd, btn) {
    const here = this.folderHere();
    if (cmd === "close") { this.close(); return; }
    if (cmd === "new-note") {
      this.notes.startCreate({ folder: here });
      if (btn.dataset.name) { const input = this.root.querySelector("#np-new"); if (input) input.value = (here ? `${here}/` : "") + btn.dataset.name; }
      return;
    }
    if (cmd === "new-folder") {
      const d = await this.ask("НОВАЯ ПАПКА", `<label>Папка</label><input name="path" value="${esc(here ? `${here}/` : "")}" required>`);
      if (!d) return;
      const r = await this.run(() => this.api("/api/files/folder", { method: "POST", body: { path: d.path.replace(/\/+$/, "") } }), "Папка создана");
      if (r) { this.open.add(parentOf(r.path)); await this.reload(); this.show({ kind: "folder", path: r.path }); }
      return;
    }
    if (cmd === "new-project") { this.newProject(); return; }
    if (cmd === "synthesis-refresh") { await this.reload(); this.toast(`Синтез: кандидатов — ${this.syn.candidates.length}`, "ok"); return; }
    const path = this.view.path;
    if (cmd === "rename-dir") this.rename(path, true);
    if (cmd === "move-dir") this.move(path, true);
    if (cmd === "trash-dir") this.trash(path, true);
  }

  async newProject() {
    const d = await this.ask("НОВЫЙ ПРОЕКТ", `
      <label>Название</label><input name="name" required placeholder="Сайт студии">
      <label>О чём проект</label><textarea name="description" rows="2" placeholder="Одной-двумя фразами"></textarea>
      <label>Репозиторий GitHub (если есть)</label><input name="repo" placeholder="owner/repo">
      <label>Статус</label><select name="status">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === "active" ? "selected" : ""}>${l}</option>`).join("")}</select>`);
    if (!d) return;
    const p = await this.run(() => this.api("/api/projects", { method: "POST", body: d }), `Проект «${d.name}» создан`);
    if (p) { await this.reload(); this.side = "projects"; this.renderSide(); this.notes.close(); this.show({ kind: "project", name: p.name }); }
  }

  noteAction(act, n) {
    if (act === "fm-rename") this.rename(n.path);
    if (act === "fm-move") this.move(n.path);
    if (act === "fm-trash") this.trash(n.path);
    if (act === "fm-holo") this.openHolo(n.path);
  }

  fileAction(act, path) {
    if (act === "rename") this.rename(path);
    if (act === "move") this.move(path);
    if (act === "trash") this.trash(path);
  }

  // ---------- переименование, перемещение, корзина ----------
  async rename(path, dir = false) {
    const name = dir ? nameOf(path) : nameOf(path).replace(/\.[^.]+$/, "");
    const d = await this.ask(dir ? "ПЕРЕИМЕНОВАТЬ ПАПКУ" : "ПЕРЕИМЕНОВАТЬ ЗАМЕТКУ",
      `<label>Новое имя</label><input name="name" value="${esc(name)}" required>
       <p class="muted">Ссылки [[…]] на ${dir ? "заметки папки" : "заметку"} в других заметках поправлю сам.</p>`);
    if (!d) return;
    const to = renameTarget(path, d.name, { dir });
    if (!to) { this.toast("Имя без «/» — для переноса в другую папку есть ⇄", "warn"); return; }
    await this.moveTo(path, to);
  }

  async move(path, dir = false) {
    const options = ["", ...this.index.folders].filter((f) => moveTarget(path, f));
    const d = await this.ask(dir ? "ПЕРЕМЕСТИТЬ ПАПКУ" : "ПЕРЕМЕСТИТЬ ЗАМЕТКУ", `<label>В папку</label>
      <select name="folder">${options.map((f) => `<option value="${esc(f)}" ${f === parentOf(path) ? "selected" : ""}>${f ? esc(f) : "⌂ корень хранилища"}</option>`).join("")}</select>
      <p class="muted">Или перетащите ${dir ? "папку" : "заметку"} на папку в дереве.</p>`);
    if (!d) return;
    const to = moveTarget(path, d.folder);
    if (to) await this.moveTo(path, to);
  }

  async moveTo(path, to) {
    const r = await this.run(() => this.api("/api/files/move", { method: "POST", body: { from: path, to } }));
    if (!r) return;
    this.toast(`Готово: ${r.path}${r.updated.length ? ` · ссылки поправлены в ${r.updated.length} заметках` : ""}`, "ok");
    this.recent = this.recent.map((p) => (p === path ? r.path : p.startsWith(`${path}/`) ? r.path + p.slice(path.length) : p));
    this.store.set("fm.recent", this.recent);
    if (this.open.delete(path)) this.open.add(r.path);
    const opened = this.notes.path;
    await this.reload();
    if (this.view.kind === "folder" && (this.view.path === path || this.view.path.startsWith(`${path}/`))) {
      this.show({ kind: "folder", path: r.path + this.view.path.slice(path.length) });
    }
    if (opened && (opened === path || opened.startsWith(`${path}/`))) {
      this.notes.close(true);
      this.notes.open(r.path + opened.slice(path.length));
    }
  }

  async trash(path, dir = false) {
    const n = dir ? this.index.files.filter((f) => f.path.startsWith(`${path}/`)).length : 0;
    const d = await this.ask("В КОРЗИНУ", `<p>${dir ? `Папка <b>${esc(path)}</b>${n ? ` и ${n} файлов в ней` : ""}` : `Заметка <b>${esc(path)}</b>`} — в корзину Obsidian (.trash).</p>
      <p class="muted">Восстановить можно в Obsidian: «Корзина» или перенести файл обратно.</p>`, { ok: "В КОРЗИНУ", danger: true });
    if (!d) return;
    const r = await this.run(() => this.api("/api/files/trash", { method: "POST", body: { path } }), "Перемещено в корзину");
    if (!r) return;
    if (this.notes.path && (this.notes.path === path || this.notes.path.startsWith(`${path}/`))) this.notes.close(true);
    this.recent = this.recent.filter((p) => p !== path && !p.startsWith(`${path}/`));
    this.store.set("fm.recent", this.recent);
    await this.reload();
  }

  async run(fn, okText = "") {
    try {
      const r = await fn();
      if (okText) this.toast(okText, "ok");
      return r;
    } catch (e) { this.toast(e.message, "error"); return null; }
  }

  // ---------- перетаскивание: заметки и папки — на папку в дереве или в списке ----------
  setupDrag() {
    const target = (e) => e.target.closest?.("[data-dir], [data-drop]");
    const folderOfTarget = (el) => (el.dataset.dir !== undefined ? el.dataset.dir : el.dataset.drop);
    this.root.addEventListener("dragstart", (e) => {
      const el = e.target.closest?.("[draggable][data-path], [draggable][data-dir]");
      if (!el) return;
      const isDir = el.dataset.dir !== undefined;
      this.dragging = { path: isDir ? el.dataset.dir : el.dataset.path, dir: isDir };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", this.dragging.path);
    });
    this.root.addEventListener("dragover", (e) => {
      const el = this.dragging && target(e);
      if (!el || !moveTarget(this.dragging.path, folderOfTarget(el))) return;
      e.preventDefault();
      this.root.querySelectorAll(".drop").forEach((x) => x !== el && x.classList.remove("drop"));
      el.classList.add("drop");
    });
    this.root.addEventListener("dragleave", (e) => { const el = target(e); if (el && !el.contains(e.relatedTarget)) el.classList.remove("drop"); });
    this.root.addEventListener("drop", (e) => {
      const el = this.dragging && target(e);
      this.root.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
      if (!el) return;
      e.preventDefault();
      const to = moveTarget(this.dragging.path, folderOfTarget(el));
      if (to) this.moveTo(this.dragging.path, to);
      this.dragging = null;
    });
    this.root.addEventListener("dragend", () => { this.dragging = null; this.root.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop")); });
  }

  // ---------- диалог внутри окна (не confirm/prompt: они выглядят чужими и мешают камере голограммы) ----------
  ask(title, html, { ok = "ГОТОВО", danger = false } = {}) {
    const box = this.el("dialog");
    box.innerHTML = `<form class="panel fm-dialog-box"><div class="panel-h"><span class="idx">◈</span> ${esc(title)}</div>
      <div class="fm-fields">${html}</div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-cancel>ОТМЕНА</button>
      <button class="btn ${danger ? "warn" : "primary"}">${esc(ok)}</button></div></form>`;
    box.classList.remove("hidden");
    const form = box.querySelector("form");
    const first = form.querySelector("input, textarea, select");
    if (first) { first.focus(); if (first.select) first.select(); } else form.querySelector("button.btn:not([data-cancel])").focus();
    return new Promise((resolve) => {
      this.dialogDone = (v) => { box.classList.add("hidden"); box.innerHTML = ""; this.dialogDone = null; resolve(v); };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dialogDone(Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()])));
      });
      form.querySelector("[data-cancel]").addEventListener("click", () => this.dialogDone(null));
    });
  }

  closeDialog() { this.dialogDone?.(null); }
}
