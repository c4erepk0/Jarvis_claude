// Панель заметки внутри голограммы: просмотр (markdown Obsidian), правка, новая заметка, переходы по [[ссылкам]].
// Сохранение — с версией, с которой начали править: если заметку тем временем изменили в Obsidian,
// сервер (или ядро на iPhone) вернёт 409 и панель предложит выбрать версию — ничего не затирается молча.
// Жестами (через голограмму): ✊ закрыть, ✌ править / диктовать строку, 👍 сохранить, взмах — назад/вперёд.
import { esc, renderMarkdown, toggleTask } from "./markdown.js?v=14";
import { Trail, insertDictation, noteAction, noteHint } from "./note-gestures.js?v=14";

const folderOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const titleOf = (path) => path.split("/").pop().replace(/\.[^.]+$/, "");

export class NotePanel {
  /**
   * root — #holo; api(path, opts) — запросы как в app.js; toast(text, level);
   * resolve(name) — путь заметки по названию из [[ссылки]] (или null); today() — ГГГГ-ММ-ДД;
   * onShow(path) / onClose() — голограмма подсвечивает узел и сдвигает вид; onCreated(path) — новая заметка;
   * dictate() — фраза с микрофона текстом (null — браузер не распознаёт речь).
   */
  constructor(root, { api, toast, resolve, today, onShow = () => {}, onClose = () => {}, onCreated = () => {}, dictate = null }) {
    Object.assign(this, { root, api, toast, resolve, today, onShow, onClose, onCreated, dictateFn: dictate });
    this.note = null;
    this.mode = "view";            // view | edit | conflict | create
    this.trail = new Trail();      // открытые заметки — взмахом ладони назад/вперёд
    this.armedUntil = 0;           // ✊ при несохранённых правках: до этого момента второй ✊ выбросит их
    this.listening = false;        // идёт диктовка
    this.el = document.createElement("aside");
    this.el.className = "np panel hidden";
    this.el.setAttribute("aria-label", "Заметка");
    root.append(this.el);
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (this.mode === "edit") this.save(); }
      if (e.key === "Escape") { e.stopPropagation(); if (this.mode === "edit") this.cancelEdit(); else if (this.mode !== "view") this.render("view"); }
    });
    window.addEventListener("beforeunload", (e) => { if (this.dirty) { e.preventDefault(); e.returnValue = ""; } });
  }

  get path() { return this.isOpen && this.note ? this.note.path : null; }
  get isOpen() { return !this.el.classList.contains("hidden"); }
  get editor() { return this.el.querySelector(".np-editor"); }
  get dirty() { return this.mode === "edit" && this.editor && this.editor.value !== this.note.content; }

  confirmLeave() { return !this.dirty || confirm("Есть несохранённые правки. Закрыть без сохранения?"); }

  /** nav — переход по истории (взмах): саму историю не меняет. */
  async open(path, { edit = false, nav = false } = {}) {
    if (this.note && this.note.path !== path && !this.confirmLeave()) return false;
    try {
      this.note = await this.api(`/api/note?path=${encodeURIComponent(path)}`);
    } catch (e) {
      this.toast(`Не открыть заметку: ${e.message}`, "error");
      if (nav) this.trail.drop(path);
      return false;
    }
    if (!nav) this.trail.visit(this.note.path);
    this.armedUntil = 0;
    this.el.classList.remove("hidden");
    this.root.classList.add("reading");
    this.render(edit && this.note.editable ? "edit" : "view");
    this.onShow(this.note.path);
    return true;
  }

  /** Новая заметка — с кнопки «＋» в голограмме или в панели. */
  startCreate() {
    if (!this.confirmLeave()) return;
    this.el.classList.remove("hidden");
    this.root.classList.add("reading");
    this.render("create");
    this.onShow(null);
  }

  close(force = false) {
    if (!this.isOpen) return true;
    if (!force && !this.confirmLeave()) return false;
    this.el.classList.add("hidden");
    this.root.classList.remove("reading");
    this.note = null;
    this.mode = "view";
    this.trail.clear();
    this.armedUntil = 0;
    this.onClose();
    return true;
  }

  /** Заметку изменили где-то ещё (Obsidian, другой дашборд, мозг) — обновить просмотр, правку не трогать. */
  async refresh() {
    if (!this.isOpen || !this.note || this.mode !== "view") return;
    try {
      const n = await this.api(`/api/note?path=${encodeURIComponent(this.note.path)}`);
      if (n.version !== this.note.version) { this.note = n; this.render("view"); }
    } catch { /* заметку удалили или нет связи — оставляем как есть */ }
  }

  // ---------- отрисовка ----------
  head(actions) {
    const n = this.note;
    const folder = n ? folderOf(n.path) : "";
    return `<div class="np-h">
      <div class="np-title">${folder ? `<small>${esc(folder)}</small>` : ""}<b>${esc(n ? n.title : "Новая заметка")}</b></div>
      <div class="np-actions">${actions}<button class="h-btn" data-act="close" title="Закрыть" aria-label="Закрыть">✕</button></div>
    </div>`;
  }

  render(mode = this.mode) {
    this.mode = mode;
    const n = this.note;
    if (mode === "create") {
      const base = n ? folderOf(n.path) : "";
      this.el.innerHTML = `${this.head("")}
        <form class="np-create" data-form="create">
          <label class="muted" for="np-new">Папка/Название</label>
          <input id="np-new" value="${esc(base ? `${base}/` : "")}" placeholder="Ideas/Новая идея" autocomplete="off" required>
          <div class="np-row"><button class="btn primary" type="submit">СОЗДАТЬ</button>
          <button class="btn ghost" type="button" data-act="back">ОТМЕНА</button></div>
        </form>`;
      const input = this.el.querySelector("#np-new");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      this.el.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); this.create(input.value); });
      return;
    }
    if (mode === "edit") {
      this.el.innerHTML = `${this.head('<button class="btn primary" data-act="save">СОХРАНИТЬ</button><button class="btn ghost" data-act="cancel">ОТМЕНА</button>')}
        <div class="np-tools">
          <button class="btn ghost" data-act="ins-task" title="Задача">☐ задача</button>
          <button class="btn ghost" data-act="ins-link" title="Ссылка на заметку">[[ ]]</button>
          <button class="btn ghost" data-act="ins-head" title="Заголовок">## </button>
          <span class="np-status muted">⌘S / Ctrl+S — сохранить</span>
        </div>
        <textarea class="np-editor" spellcheck="true" autocapitalize="sentences" aria-label="Текст заметки"></textarea>`;
      const ed = this.editor;
      ed.value = this.draft ?? n.content;
      this.draft = null;
      ed.addEventListener("input", () => {
        if (!this.listening) this.status(this.dirty ? "● есть несохранённые правки" : "⌘S / Ctrl+S — сохранить");
      });
      ed.focus({ preventScroll: true });
      return;
    }
    if (mode === "conflict") {
      const theirs = this.conflict;
      this.el.innerHTML = `${this.head("")}
        <div class="np-conflict">
          <p><b>Заметку изменили, пока вы её правили</b> — скорее всего, в Obsidian на телефоне.</p>
          <div class="np-row">
            <button class="btn primary" data-act="mine">СОХРАНИТЬ МОЮ</button>
            <button class="btn ghost" data-act="theirs">${theirs ? "ВЗЯТЬ ИЗ OBSIDIAN" : "ЗАКРЫТЬ"}</button>
            <button class="btn ghost" data-act="back-edit">К ПРАВКЕ</button>
          </div>
          <p class="muted">Ваши правки не потеряются: «Взять из Obsidian» скопирует их в буфер обмена.</p>
          ${theirs ? `<div class="np-sub muted">Версия в Obsidian:</div><div class="np-body md">${this.html(theirs.content)}</div>`
            : '<p class="muted">Заметку удалили или переместили.</p>'}
        </div>`;
      return;
    }
    const actions = (n.editable ? '<button class="btn ghost" data-act="edit">✎ ПРАВИТЬ</button>' : "")
      + '<button class="btn ghost" data-act="new" title="Новая заметка">＋</button>';
    this.el.innerHTML = `${this.head(actions)}
      <div class="np-body md">${this.html(n.content) || '<p class="muted">Пустая заметка.</p>'}</div>
      ${n.truncated ? '<p class="np-foot muted">Заметка очень большая — показано начало, править её лучше в Obsidian.</p>' : ""}`;
  }

  html(content) { return renderMarkdown(content, { resolve: this.resolve }).html; }

  // ---------- действия ----------
  onClick(e) {
    const link = e.target.closest("a.md-link");
    if (link) { e.preventDefault(); this.follow(link); return; }
    const task = e.target.closest("li.md-task");
    if (task && this.mode === "view" && this.note?.editable) { this.toggle(Number(task.dataset.line)); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    const ed = this.editor;
    switch (act) {
      case "close": this.close(); break;
      case "edit": this.render("edit"); break;
      case "cancel": this.cancelEdit(); break;
      case "save": this.save(); break;
      case "new": this.startCreate(); break;
      case "back": this.note ? this.render("view") : this.close(true); break;
      case "back-edit": this.draft = this.pending; this.render("edit"); break;   // правки — те, что не сохранились
      case "mine": this.save({ base: this.conflict ? this.conflict.version : null, overwrite: true }); break;
      case "theirs": this.takeTheirs(); break;
      case "ins-task": this.newLine(ed, "- [ ] "); break;
      case "ins-link": this.insert(ed, "[[", "]]"); break;
      case "ins-head": this.insert(ed, "## ", "", true); break;
      default: break;
    }
  }

  status(text) {
    const el = this.el.querySelector(".np-status");
    if (el) el.textContent = text;
  }

  // ---------- жесты (голограмма спрашивает, что сделает жест, и показывает это до срабатывания) ----------
  /** { label, run } для жеста, { label, hint: true } — жест сейчас ничего не делает (подсказка), или null —
   *  тогда жест обработает сама голограмма (поворот, сброс вида). */
  gestureAction(gesture) {
    if (!this.isOpen) return null;
    const s = {
      mode: this.mode, dirty: this.dirty, editable: Boolean(this.note?.editable), armed: Date.now() < this.armedUntil,
      back: Boolean(this.trail.back), forward: Boolean(this.trail.forward), dictation: Boolean(this.dictateFn),
    };
    const a = noteAction(gesture, s);
    if (a) return { label: a.label, run: () => this.runGesture(a.act) };
    const hint = noteHint(gesture, s);
    return hint && { label: hint, hint: true };
  }

  runGesture(act) {
    switch (act) {
      case "close": this.close(); break;
      case "edit": this.render("edit"); break;
      case "back": this.go(-1); break;
      case "forward": this.go(1); break;
      case "save": this.armedUntil = 0; this.save(); break;
      case "arm":
        this.armedUntil = Date.now() + 6000;
        this.status("● есть несохранённые правки: 👍 — сохранить, ✊ ещё раз — выбросить");
        this.toast("Есть несохранённые правки: 👍 — сохранить, ✊ ещё раз — выбросить", "warn");
        break;
      case "cancel": this.armedUntil = 0; this.render("view"); break;   // без confirm(): он бы остановил камеру
      case "dictate": this.dictate(); break;
      case "submit": this.el.querySelector("form[data-form=create]")?.requestSubmit(); break;
      case "dictate-name": this.dictateName(); break;
      case "leave": if (this.note) this.render("view"); else this.close(true); break;
      case "back-edit": this.draft = this.pending; this.render("edit"); break;
      default: break;
    }
  }

  /** Взмах ладонью: предыдущая (-1) или следующая (+1) из открытых заметок. */
  async go(step) {
    const path = step < 0 ? this.trail.back : this.trail.forward;
    if (path && await this.open(path, { nav: true })) this.trail.move(step);
  }

  /** ✌ в правке: продиктовать строку — она встанет после строки с курсором («задача …» → «- [ ] …»). */
  async dictate() {
    const ed = this.editor;
    if (!ed || this.listening || !this.dictateFn) return;
    this.listening = true;
    this.status("🎙 говорите — запишу строку («задача …», «пункт …», «заголовок …»)");
    try {
      const text = await this.dictateFn();
      if (!ed.isConnected) { this.toast(`Правка закрыта, не вставил: «${text}»`, "warn"); return; }
      const r = insertDictation(ed.value, ed.selectionEnd, text);
      if (!r) { this.status("не расслышал — ✌ ещё раз"); return; }
      ed.value = r.value;
      ed.setSelectionRange(r.cursor, r.cursor);
      ed.focus({ preventScroll: false });
      this.listening = false;
      ed.dispatchEvent(new Event("input"));
    } catch (e) {
      this.toast(`Диктовка не удалась: ${e.message}`, "error");
    } finally {
      this.listening = false;
    }
  }

  /** ✌ при создании: продиктовать название новой заметки (папка, если уже введена, сохраняется). */
  async dictateName() {
    const input = this.el.querySelector("#np-new");
    if (!input || this.listening || !this.dictateFn) return;
    this.listening = true;
    try {
      const text = String(await this.dictateFn()).trim().replace(/[.!?]+$/, "");
      if (text && input.isConnected) {
        const folder = input.value.includes("/") ? input.value.slice(0, input.value.lastIndexOf("/") + 1) : "";
        input.value = folder + text.charAt(0).toUpperCase() + text.slice(1);
      }
    } catch (e) {
      this.toast(`Диктовка не удалась: ${e.message}`, "error");
    } finally {
      this.listening = false;
    }
  }

  insert(ed, before, after, atLineStart = false) {
    if (!ed) return;
    const { selectionStart: a, selectionEnd: b, value } = ed;
    const pos = atLineStart ? value.lastIndexOf("\n", a - 1) + 1 : a;
    const sel = atLineStart ? "" : value.slice(a, b);
    ed.value = value.slice(0, pos) + before + (atLineStart ? value.slice(pos, a) : sel) + after + value.slice(atLineStart ? a : b);
    const cursor = atLineStart ? a + before.length : pos + before.length + sel.length;
    ed.setSelectionRange(cursor, cursor);
    ed.focus();
    ed.dispatchEvent(new Event("input"));
  }

  /** Новая строка с префиксом («- [ ] ») после текущей; пустая текущая строка — префикс прямо в неё. */
  newLine(ed, prefix) {
    if (!ed) return;
    const { selectionStart: a, value } = ed;
    const start = value.lastIndexOf("\n", a - 1) + 1;
    let end = value.indexOf("\n", a);
    if (end < 0) end = value.length;
    const empty = !value.slice(start, end).trim();
    const at = empty ? start : end;
    const add = empty ? prefix : `\n${prefix}`;
    ed.value = value.slice(0, at) + add + value.slice(empty ? end : at);
    const cursor = at + add.length;
    ed.setSelectionRange(cursor, cursor);
    ed.focus();
    ed.dispatchEvent(new Event("input"));
  }

  cancelEdit() {
    if (this.dirty && !confirm("Отменить правки?")) return;
    this.render("view");
  }

  async save({ base = this.note.version, overwrite = false } = {}) {
    const content = overwrite ? this.pending : this.editor.value;
    if (!overwrite && content === this.note.content) { this.render("view"); return; }
    const btn = this.el.querySelector('[data-act="save"], [data-act="mine"]');
    if (btn) btn.disabled = true;
    try {
      const r = await this.api("/api/note", { method: base ? "PUT" : "POST", body: { path: this.note.path, content, base } });
      this.note = { ...this.note, content, version: r.version };
      this.pending = null;
      this.render("view");
      this.toast("Заметка сохранена", "ok");
    } catch (e) {
      if (e.status === 409) {
        this.pending = content;
        this.conflict = e.data?.current || null;
        this.render("conflict");
      } else {
        this.toast(`Не сохранено: ${e.message}`, "error");
        if (btn) btn.disabled = false;
      }
    }
  }

  async takeTheirs() {
    try { if (this.pending) await navigator.clipboard.writeText(this.pending); } catch { /* буфер недоступен — не страшно */ }
    if (!this.conflict) { this.close(true); return; }
    this.note = { ...this.note, content: this.conflict.content, version: this.conflict.version };
    this.pending = null;
    this.render("view");
    this.toast("Взята версия из Obsidian. Ваши правки — в буфере обмена.", "info");
  }

  async toggle(line) {
    const text = toggleTask(this.note.content, line, this.today());
    if (text === null) return;
    try {
      const r = await this.api("/api/note", { method: "PUT", body: { path: this.note.path, content: text, base: this.note.version } });
      this.note = { ...this.note, content: text, version: r.version };
      this.render("view");
    } catch (e) {
      if (e.status === 409) { await this.refresh(); this.toast("Заметку только что изменили — обновил, отметьте ещё раз.", "warn"); }
      else this.toast(`Не отметить: ${e.message}`, "error");
    }
  }

  async follow(link) {
    if (this.dirty && !this.confirmLeave()) return;
    const path = link.dataset.path || this.resolve(link.dataset.note);
    if (path) { await this.open(path); return; }
    const name = link.dataset.note;
    if (!confirm(`Заметки «${name}» ещё нет. Создать?`)) return;
    const folder = this.note ? folderOf(this.note.path) : "";
    await this.create(folder ? `${folder}/${name}` : name);
  }

  async create(raw) {
    let path = String(raw || "").trim().replace(/^\/+/, "");
    if (!path || path.endsWith("/")) { this.toast("Введите название заметки", "warn"); return; }
    if (!/\.(md|txt)$/i.test(path)) path += ".md";
    try {
      const r = await this.api("/api/note", { method: "POST", body: { path, content: `# ${titleOf(path)}\n\n` } });
      await this.onCreated(r.path);
      this.note = null;
      await this.open(r.path, { edit: true });
    } catch (e) {
      this.toast(e.status === 409 ? `Заметка «${titleOf(path)}» уже есть — открываю.` : `Не создать: ${e.message}`,
        e.status === 409 ? "warn" : "error");
      if (e.status === 409) await this.open(path);
    }
  }
}
