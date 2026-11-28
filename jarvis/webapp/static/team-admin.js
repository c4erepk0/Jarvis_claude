// Окно «Команда» — раздел владельца (корня): операторы (пригласить по ссылке, права, отключить, удалить),
// чат с каждым, поручения (задачи и встречи с тегом #оператор/<имя>) и все встречи — отметить «выполнено/состоялась».
// Данные — /api/admin/…, /api/meetings, /api/tasks (сервер; на iPhone без сервера операторов нет).
import { esc } from "./markdown.js?v=32";
import { STATUS, chatDays, inviteLink, seen } from "./team.js?v=32";
import { devicesList } from "./operator-app.js?v=32";

const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }) : "без даты");

export class TeamWindow {
  constructor(root, { api, toast, store, today, standalone = false }) {
    Object.assign(this, { root, api, toast, store, today, standalone });
    this.tab = store.get("team.tab", "ops");
    this.sel = store.get("team.sel", null);
    this.sub = store.get("team.sub", "chat");
    this.data = { operators: [], perms: {}, can_invite: false };
    root.innerHTML = `
      <div class="fw-top">
        <div class="fw-title">Команда <span class="muted" data-el="meta"></span></div>
        <div class="seg fw-tabs tw-tabs"><button data-tab="ops">Операторы</button><button data-tab="meet">Встречи</button><button data-tab="dev">Мои устройства</button></div>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="tw-body" data-el="body"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
      if (e.key === "Enter" && e.target.matches('[data-el="note-add"]')) { e.preventDefault(); root.querySelector('[data-act="note-add"]')?.click(); }
    });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show(opts = {}) {
    if (opts.tab) this.tab = opts.tab;
    if (opts.operator) { this.tab = "ops"; this.sel = opts.operator; this.sub = "chat"; }
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    await this.reload();
  }

  close() { this.root.classList.add("hidden"); document.body.classList.remove("fw-on"); }

  async reload() {
    if (this.standalone) {
      this.data = { operators: [], perms: {}, can_invite: false, standalone: true };
    } else {
      try { this.data = await this.api("/api/admin/operators"); } catch (e) { this.toast(e.message, "error"); return; }
    }
    if (this.sel && !this.data.operators.some((o) => o.id === this.sel)) this.sel = null;
    if (!this.sel && this.data.operators.length) this.sel = this.data.operators[0].id;
    await this.render();
  }

  unread() { return this.data.operators.reduce((s, o) => s + (o.unread || 0), 0); }

  async render() {
    this.store.set("team.tab", this.tab); this.store.set("team.sel", this.sel); this.store.set("team.sub", this.sub);
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const n = this.data.operators.length;
    this.el("meta").textContent = n ? `${n} ${n === 1 ? "оператор" : n < 5 ? "оператора" : "операторов"}` : "";
    const body = this.el("body");
    body.innerHTML = this.tab === "meet" ? await this.renderMeetings() : this.tab === "dev" ? await this.renderDevices() : await this.renderOps();
    body.querySelector(".tw-chat-log")?.scrollTo(0, 1e9);
  }

  // ---------- операторы ----------
  async renderOps() {
    const ops = this.data.operators;
    const op = ops.find((o) => o.id === this.sel);
    const lock = this.data.standalone
      ? `<div class="tw-note">Операторы работают с сервером Atom: на iPhone без сервера нет общего места для учёток нескольких людей.</div>`
      : !this.data.can_invite ? `<form class="tw-note" data-form="password"><b>Сначала пароль владельца</b>
        <p class="muted">Сейчас Atom открыт без пароля — тогда любой, кто откроет ссылку, станет владельцем. Задайте пароль, и можно приглашать.</p>
        <input name="password" type="password" minlength="6" placeholder="Пароль владельца (от 6 символов)" required autocomplete="new-password">
        <button class="btn primary">Задать пароль</button></form>` : "";
    let main;
    if (this.creating) main = await this.newForm();
    else if (!op) main = null;
    else main = await this.opPage(op);
    const list = `<aside class="tw-list">
      ${ops.map((o) => `<button class="tw-op ${o.id === this.sel ? "on" : ""}" data-op="${esc(o.id)}">
        <span class="tw-av">${esc(o.name.slice(0, 1).toUpperCase())}</span>
        <span><b>${esc(o.name)}</b><small class="st-${o.status}">${STATUS[o.status]} · ${esc(seen(o.last_seen))}</small></span>
        ${o.unread ? `<em class="tw-badge">${o.unread}</em>` : ""}</button>`).join("")}
      ${this.data.can_invite ? `<button class="btn ghost fm-wide" data-act="new">＋ Пригласить оператора</button>` : ""}
    </aside>`;
    if (main === null) main = `<div class="tw-empty"><h3>Операторы — люди, которые помогают вести дела</h3>
      <p class="muted">Пригласите человека по ссылке: он войдёт в свой кабинет, увидит порученные задачи и встречи, отметит
      выполненное и сможет написать вам. Финансы, память и остальное ему не видны — откройте только нужное: общие проекты,
      приложения из каталога и доверенные заметки.</p>
      ${this.data.can_invite ? `<button class="btn primary" data-act="new">＋ Пригласить первого</button>` : ""}</div>`;
    return `${lock}<div class="tw-grid">${list}<section class="tw-main">${main}</section></div>`;
  }

  async newForm() {
    return `<form class="tw-card" data-form="new"><h3>Новый оператор</h3>
      <label>Имя<input name="name" required maxlength="60" placeholder="Анна" autocomplete="off"></label>
      <label>Заметка для себя<input name="note" maxlength="300" placeholder="например: ассистент, бухгалтерия" autocomplete="off"></label>
      <fieldset class="tw-perms"><legend>Права</legend>${this.permBoxes([])}</fieldset>
      <fieldset class="tw-perms"><legend>Общие проекты</legend>${this.projectBoxes([])}</fieldset>
      <fieldset class="tw-perms"><legend>Приложения</legend>${this.appRows([])}</fieldset>
      <fieldset class="tw-perms"><legend>Обмен файлами</legend>
        <p class="muted small">Папки выдаются в приложении «Обмен файлами» (каталог → Обмен). Создайте оператора,
          затем откройте папку и нажмите «Доступ».</p></fieldset>
      <div class="fw-form-acts"><button class="btn primary">Создать и получить ссылку</button>
      <button type="button" class="btn ghost" data-act="cancel-new">Отмена</button></div></form>`;
  }

  permBoxes(on) {
    return Object.entries(this.data.perms).map(([k, l]) => `<label class="tw-check"><input type="checkbox" name="perm" value="${k}" ${on.includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")
      + `<p class="muted small">Всегда доступно: порученные задачи и встречи, свой список задач и заметки (папка в хранилище), чат с вами.</p>`;
  }

  projectBoxes(on) {
    const list = this.data.projects || [];
    if (!list.length) return `<p class="muted small">Проектов пока нет.</p>`;
    const low = on.map((x) => x.toLowerCase());
    return list.map((p) => `<label class="tw-check"><input type="checkbox" name="project" value="${esc(p.name)}" ${low.includes(p.name.toLowerCase()) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")
      + `<p class="muted small">Оператор увидит только отмеченные проекты: описание, прогресс и задачи (их можно отмечать). Остальные — скрыты.</p>`;
  }

  // доступ к приложениям каталога: нет / открывать / управлять (управлять — править заметку приложения,
  // у приложения-проекта — видеть и отмечать его задачи)
  appRows(on) {
    const list = this.data.apps || [];
    if (!list.length) return `<p class="muted small">Каталог приложений пуст.</p>`;
    const level = Object.fromEntries((on || []).map((a) => [a.id, a.level]));
    const levels = this.data.app_levels || { use: "Открывать", manage: "Управлять" };
    return `<div class="tw-apps">${list.map((a) => `<label class="tw-app-row"><span class="tw-app-ic">${esc(a.icon || a.name.slice(0, 1))}</span>
      <span class="tw-app-name">${esc(a.name)}${a.kind === "builtin" ? ` <small class="muted">встроенное</small>` : ""}</span>
      <select name="app" data-app-id="${esc(a.id)}"><option value="">Нет доступа</option>
        ${Object.entries(levels).filter(([k]) => a.kind !== "builtin" || k === "use").map(([k, l]) => `<option value="${k}" ${level[a.id] === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`).join("")}</div>
      <p class="muted small">«Открывать» — приложение появится в кабинете оператора. «Управлять» — ещё и правка его заметки, а у приложения-проекта — задачи проекта.</p>`;
  }

  noteRow(n) {
    return `<li data-note-row="${esc(n.path)}"><span class="tw-note-path">${/\.md$/i.test(n.path) ? "📄" : "📁"} ${esc(n.path)}</span>
      <label class="tw-check"><input type="checkbox" name="note-edit" value="${esc(n.path)}" ${n.edit ? "checked" : ""}> править</label>
      <button type="button" class="h-btn" data-act="note-del" aria-label="Убрать">✕</button></li>`;
  }

  async notesBox(on) {
    if (!this.vaultPaths) {
      try {
        const idx = await this.api("/api/files");
        this.vaultPaths = [...idx.folders, ...idx.files.filter((f) => f.ext === ".md").map((f) => f.path)].slice(0, 3000);
      } catch { this.vaultPaths = []; }
    }
    return `<ul class="tw-notes" data-el="trusted">${(on || []).map((n) => this.noteRow(n)).join("")}</ul>
      <div class="inline-add"><input data-el="note-add" list="tw-vault-paths" placeholder="Заметка или папка: Wiki/Регламент.md" autocomplete="off">
        <button type="button" class="btn" data-act="note-add">＋</button></div>
      <datalist id="tw-vault-paths">${this.vaultPaths.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
      <p class="muted small">Доверенные заметки оператор видит в кабинете («Заметки → Доверенные»). Папка — все заметки в ней. Без галочки — только чтение. Не забудьте «Сохранить».</p>`;
  }

  collectAccess(f) {
    const apps = [...f.querySelectorAll("select[name=app]")].filter((x) => x.value).map((x) => ({ id: x.dataset.appId, level: x.value }));
    const edit = new Set([...f.querySelectorAll("input[name=note-edit]:checked")].map((x) => x.value));
    const notes = [...f.querySelectorAll("[data-note-row]")].map((li) => ({ path: li.dataset.noteRow, edit: edit.has(li.dataset.noteRow) }));
    // «Обмен файлами»: путь и имя папки — чтобы панель знала, что выдано
    const files = [...f.querySelectorAll("select[name=file-level]")]
      .map((x) => ({ path: x.dataset.filePath, name: x.dataset.fileName, level: x.value }));
    return { apps, notes, files };
  }

  // «Обмен файлами»: что уже открыто оператору. Выдаётся в приложении — там видно папки.
  filesBox(on) {
    const levels = (this.data.exchange && this.data.exchange.levels)
      || { view: "Просмотр", upload: "Просмотр и загрузка" };
    const rows = (on || []).map((g) => `<li data-file-row="${esc(g.path)}">
      <span class="tw-note-path">📁 ${esc(g.name || g.path)} <small class="muted">${esc(g.path)}</small></span>
      <select name="file-level" data-file-path="${esc(g.path)}" data-file-name="${esc(g.name || g.path)}">
        ${Object.entries(levels).map(([k, l]) => `<option value="${k}" ${g.level === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      <button type="button" class="h-btn" data-act="file-del" aria-label="Убрать">✕</button></li>`).join("");
    return `<ul class="tw-notes" data-el="files">${rows || `<li class="muted small">Пока ничего не открыто.</li>`}</ul>
      <p class="muted small">Выдаются папки — в приложении «Обмен файлами»: откройте папку и нажмите «Доступ».
        Здесь видно, что открыто; уровень можно поменять, «✕» — закрыть доступ.</p>`;
  }

  linkBox(token) {
    const url = inviteLink(location.origin, token);
    return `<div class="tw-link"><b>Ссылка-приглашение</b> <small class="muted">· одноразовая, 7 дней</small>
      <input readonly value="${esc(url)}" data-select>
      <div class="mw-acts"><button class="btn primary" data-copy="${esc(url)}">Скопировать</button>
      ${navigator.share ? `<button class="btn ghost" data-share="${esc(url)}">Отправить…</button>` : ""}</div>
      <p class="muted small">Оператор откроет ссылку — или при первом запуске выберет «Я оператор» и вставит её.</p></div>`;
  }

  async opPage(op) {
    const content = this.sub === "work" ? await this.workTab(op) : this.sub === "access" ? await this.accessTab(op) : await this.chatTab(op);
    const head = `<header class="tw-head"><span class="tw-av big">${esc(op.name.slice(0, 1).toUpperCase())}</span>
      <div><h3>${esc(op.name)}</h3><small class="st-${op.status}">${STATUS[op.status]} · ${esc(seen(op.last_seen))}${op.note ? ` · ${esc(op.note)}` : ""}</small></div>
      <div class="seg tw-sub">${[["chat", `Чат${op.unread ? ` · ${op.unread}` : ""}`], ["work", "Поручения"], ["access", "Доступ"]]
        .map(([k, l]) => `<button data-sub="${k}" class="${this.sub === k ? "on" : ""}">${l}</button>`).join("")}</div></header>`;
    const link = this.token && this.token.op === op.id && op.status === "invited" ? this.linkBox(this.token.value) : "";   // принятая ссылка уже не нужна
    return head + link + content;
  }

  async chatTab(op) {
    let msgs = [];
    try { msgs = (await this.api(`/api/admin/chat/${op.id}`)).messages; } catch (e) { return `<p class="empty">${esc(e.message)}</p>`; }
    op.unread = 0;
    return `<div class="tw-chat"><div class="tw-chat-log">${msgs.length ? chatDays(msgs, this.today()).map((d) => `<div class="tw-day">${esc(d.label)}</div>
      ${d.items.map((m) => `<div class="tw-msg ${m.from === "owner" ? "mine" : ""}"><p>${esc(m.text).replace(/\n/g, "<br>")}</p><small>${esc(m.time)}</small></div>`).join("")}`).join("")
      : `<p class="empty">Переписки пока нет. Сообщения хранятся в заметке <code>Jarvis/Chat/${esc(op.name)}.md</code>.</p>`}</div>
      <form class="tw-send" data-form="chat"><textarea name="text" rows="1" placeholder="Сообщение для ${esc(op.name)}… (Ctrl+Enter — отправить)" required></textarea>
      <button class="btn primary" aria-label="Отправить">➤</button></form></div>`;
  }

  async workTab(op) {
    let tasks = [], meet = { upcoming: [], done: [] };
    try {
      [tasks, meet] = await Promise.all([this.api(`/api/tasks?view=all&project=${encodeURIComponent(op.tag)}`), this.api(`/api/meetings?operator=${op.id}`)]);
    } catch (e) { return `<p class="empty">${esc(e.message)}</p>`; }
    tasks = tasks.filter((t) => !t.tags.includes("встреча"));
    return `<div class="tw-work">
      <section class="tw-card"><h3>Задачи · ${tasks.length}</h3>
        <ul class="tasks tw-tasks">${tasks.map((t) => this.taskRow(t)).join("") || `<li class="empty">Открытых поручений нет.</li>`}</ul>
        <form class="inline-add" data-form="task"><input name="text" required placeholder="Поручить задачу…" autocomplete="off">
          <input name="due" type="date" aria-label="Срок"><button class="btn">＋</button></form></section>
      <section class="tw-card"><h3>Встречи · ${meet.upcoming.length}</h3>
        <ul class="tasks tw-tasks">${meet.upcoming.map((m) => this.meetRow(m)).join("") || `<li class="empty">Встреч не назначено.</li>`}</ul>
        ${this.meetForm(false)}</section>
    </div>`;
  }

  taskRow(t) {
    const done = t.status === "done";
    return `<li class="task ${done ? "done" : ""}" data-id="${esc(t.id)}"><button class="check" data-check="${done ? "todo" : "done"}" aria-label="${done ? "Вернуть" : "Выполнено"}"></button>
      <div class="t-text">${esc(t.text)}</div>${t.due ? `<div class="t-meta ${t.due < this.today() && !done ? "over" : ""}">${esc(fmtDate(t.due))}</div>` : ""}</li>`;
  }

  meetRow(m, withWho = false) {
    const done = m.status === "done";
    const who = withWho && m.assignees.length ? ` · 👤 ${m.assignees.map((a) => this.data.operators.find((o) => o.slug === a)?.name || a).join(", ")}` : "";
    return `<li class="task meet ${done ? "done" : ""}" data-id="${esc(m.id)}"><button class="check" data-check="${done ? "todo" : "done"}" aria-label="${done ? "Вернуть" : "Состоялась"}"></button>
      <div class="t-text"><b>${esc(m.title)}</b><small class="muted">${esc(fmtDate(m.due))}${m.time ? ` · ${esc(m.time)}` : ""}${m.place ? ` · 📍 ${esc(m.place)}` : ""}${esc(who)}</small></div>
      <div class="t-meta ${m.due && m.due < this.today() && !done ? "over" : m.due === this.today() ? "today" : ""}">${m.due === this.today() ? "сегодня" : ""}</div></li>`;
  }

  meetForm(withOperator) {
    return `<details class="fw-form"><summary>＋ Назначить встречу</summary><form class="tw-meet-form" data-form="meeting">
      <label>Что<input name="title" required placeholder="Встреча с юристом" autocomplete="off"></label>
      <label>Когда<input name="due" type="date" required value="${this.today()}"></label>
      <label>Во сколько<input name="time" type="time"></label>
      <label>Где<input name="place" placeholder="Офис, Zoom…" autocomplete="off"></label>
      ${withOperator ? `<label>С кем из команды<select name="operator"><option value="">— только я —</option>${this.data.operators.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</select></label>` : ""}
      <div class="fw-form-acts"><button class="btn primary">Назначить</button></div></form></details>`;
  }

  async accessTab(op) {
    let devices = [];
    try { devices = (await this.api(`/api/admin/operators/${op.id}`, { method: "POST", body: { action: "sessions" } })).sessions; } catch { /* старый сервер */ }
    return `<form class="tw-card" data-form="edit"><h3>Доступ и данные</h3>
      <label>Имя<input name="name" value="${esc(op.name)}" required maxlength="60"></label>
      <label>Заметка для себя<input name="note" value="${esc(op.note)}" maxlength="300"></label>
      <fieldset class="tw-perms"><legend>Права</legend>${this.permBoxes(op.perms)}</fieldset>
      <fieldset class="tw-perms"><legend>Общие проекты</legend>${this.projectBoxes(op.projects || [])}</fieldset>
      <fieldset class="tw-perms"><legend>Приложения</legend>${this.appRows(op.apps || [])}</fieldset>
      <fieldset class="tw-perms"><legend>Доверенные заметки</legend>${await this.notesBox(op.notes || [])}</fieldset>
      <fieldset class="tw-perms"><legend>Обмен файлами</legend>${this.filesBox(op.files || [])}</fieldset>
      <p class="muted small">Тег поручений: <code>#${esc(op.tag)}</code> — им можно отмечать задачи прямо в Obsidian. Личная папка: <code>${esc(op.folder || "")}</code>.</p>
      <div class="fw-form-acts"><button class="btn primary">Сохранить</button></div></form>
      <section class="tw-card"><h3>Устройства · ${devices.length}</h3>
        ${devicesList(devices)}
        <p class="muted small">${op.has_password ? "Оператор входит по имени и паролю с любого устройства." : "Пароль ещё не задан — он задаётся при принятии приглашения."}</p></section>
      <section class="tw-card"><h3>Вход</h3>
        <div class="mw-acts">
          <button class="btn ghost" data-act="invite" title="Если оператор забыл пароль или ещё не принял приглашение">↻ Новая ссылка-приглашение</button>
          <button class="btn ghost" data-act="logout">Выйти на всех устройствах</button>
          <button class="btn ${op.active ? "warn" : "ghost"}" data-act="toggle">${op.active ? "Отключить" : "Включить"}</button>
          <button class="btn danger" data-act="delete">Удалить</button></div>
        <p class="muted small">Отключённый оператор не может войти, все его устройства отключаются сразу. Удаление не трогает переписку, задачи и заметки в хранилище.</p></section>`;
  }

  // ---------- мои устройства (владелец) ----------
  async renderDevices() {
    let r;
    try { r = await this.api("/api/sessions"); } catch (e) { return `<p class="empty">${esc(e.message)}</p>`; }
    return `<div class="tw-work single"><section class="tw-card"><h3>Мои устройства · ${r.sessions.length}</h3>
      ${devicesList(r.sessions)}
      ${r.sessions.length > 1 ? `<div class="mw-acts"><button class="btn ghost" data-act="my-others">Выйти на всех других устройствах</button></div>` : ""}
      <p class="muted small">${r.auth ? "Где вы вошли как владелец. Завершённое устройство сразу попросит войти заново." : "Atom открыт без пароля — устройства не различаются. Задайте пароль во вкладке «Операторы»."}</p></section></div>`;
  }

  // ---------- все встречи ----------
  async renderMeetings() {
    let m;
    try { m = await this.api("/api/meetings"); } catch (e) { return `<p class="empty">${esc(e.message)}</p>`; }
    return `<div class="tw-work single">
      <section class="tw-card"><h3>Предстоящие · ${m.upcoming.length}${m.overdue ? ` <small class="over">· ${m.overdue} просрочено</small>` : ""}</h3>
        <ul class="tasks tw-tasks">${m.upcoming.map((x) => this.meetRow(x, true)).join("") || `<li class="empty">Встреч нет.</li>`}</ul>
        ${this.meetForm(this.data.operators.length > 0)}</section>
      ${m.done.length ? `<section class="tw-card"><h3>Состоялись · за неделю</h3><ul class="tasks tw-tasks">${m.done.map((x) => this.meetRow(x, true)).join("")}</ul></section>` : ""}
      <p class="muted small">Встречи — задачи Obsidian Tasks с тегом <code>#встреча</code>: «- [ ] Созвон 🕒 15:00 📍 Zoom #встреча 📅 2026-11-20». Голосом: «какие встречи», «встречи на завтра».</p>
    </div>`;
  }

  // ---------- события ----------
  async onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; this.creating = false; this.render(); return; }
    const opb = t.closest("[data-op]");
    if (opb) { this.sel = opb.dataset.op; this.creating = false; this.render(); return; }
    const sub = t.closest("[data-sub]");
    if (sub) { this.sub = sub.dataset.sub; this.render(); return; }
    const copy = t.closest("[data-copy]");
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); this.toast("Ссылка скопирована", "ok"); } catch { this.root.querySelector("[data-select]")?.select(); } return; }
    const share = t.closest("[data-share]");
    if (share) { try { await navigator.share({ title: "Приглашение в Atom", url: share.dataset.share }); } catch { /* отменили */ } return; }
    if (t.matches("[data-select]")) { t.select(); return; }
    const check = t.closest("[data-check]");
    if (check) {
      const li = check.closest("[data-id]");
      li.classList.toggle("done", check.dataset.check === "done");
      try { await this.api(`/api/tasks/${encodeURIComponent(li.dataset.id)}/status`, { method: "POST", body: { status: check.dataset.check } }); this.render(); }
      catch (err) { li.classList.toggle("done"); this.toast(err.message, "error"); }
      return;
    }
    const rev = t.closest("[data-revoke]");
    if (rev) {
      try {
        if (this.tab === "dev") await this.api("/api/sessions", { method: "POST", body: { action: "revoke", sid: rev.dataset.revoke } });
        else await this.api(`/api/admin/operators/${this.sel}`, { method: "POST", body: { action: "revoke", sid: rev.dataset.revoke } });
        this.toast("Устройство отключено", "ok");
        await this.render();
      } catch (err) { this.toast(err.message, "error"); }
      return;
    }
    const b = t.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, id = this.sel;
    if (act === "note-del") { b.closest("[data-note-row]").remove(); return; }
    if (act === "file-del") {
      const row = b.closest("[data-file-row]");
      const sel = row.querySelector("select");
      sel.value = "";                       // пустой уровень = убрать доступ при сохранении
      row.remove();
      return;
    }
    if (act === "note-add") {
      const inp = this.el("note-add"), path = inp.value.trim().replace(/^\/+|\/+$/g, "");
      if (!path) return;
      const box = this.el("trusted");
      if (![...box.children].some((li) => li.dataset.noteRow === path)) box.insertAdjacentHTML("beforeend", this.noteRow({ path, edit: false }));
      inp.value = ""; inp.focus();
      return;
    }
    if (act === "my-others") {
      try { await this.api("/api/sessions", { method: "POST", body: { action: "others" } }); this.toast("Вы вышли на всех других устройствах", "ok"); await this.render(); }
      catch (err) { this.toast(err.message, "error"); }
      return;
    }
    if (act === "close") { this.close(); return; }
    if (act === "new") { this.creating = true; this.render(); return; }
    if (act === "cancel-new") { this.creating = false; this.render(); return; }
    if (act === "delete" && !b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Точно удалить?"; return; }
    const map = { invite: "invite", logout: "logout", delete: "delete" };
    try {
      if (act === "toggle") {
        const op = this.data.operators.find((o) => o.id === id);
        this.data = await this.api(`/api/admin/operators/${id}`, { method: "POST", body: { action: "update", active: !op.active } });
      } else if (map[act]) {
        const r = await this.api(`/api/admin/operators/${id}`, { method: "POST", body: { action: map[act] } });
        this.data = r;
        if (r.token) this.token = { op: id, value: r.token };
        this.toast({ invite: "Новая ссылка готова — старая больше не работает", logout: "Оператор вышел на всех устройствах", delete: "Оператор удалён" }[act], "ok");
        if (act === "delete") this.sel = null;
      }
      await this.reload();
    } catch (err) { this.toast(err.message, "error"); }
  }

  async onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const fd = new FormData(f), v = Object.fromEntries(fd);
    const id = this.sel;
    try {
      if (f.dataset.form === "password") {
        await this.api("/api/admin/password", { method: "POST", body: { password: v.password } });
        this.toast("Пароль владельца задан — теперь вход только по нему", "ok");
      } else if (f.dataset.form === "new") {
        const r = await this.api("/api/admin/operators", { method: "POST", body: { name: v.name, note: v.note, perms: fd.getAll("perm"), projects: fd.getAll("project"), ...this.collectAccess(f) } });
        this.creating = false; this.sel = r.created.id; this.sub = "access";
        this.token = { op: r.created.id, value: r.token };
        this.toast(`Оператор «${r.created.name}» создан — отправьте ему ссылку`, "ok");
      } else if (f.dataset.form === "edit") {
        await this.api(`/api/admin/operators/${id}`, { method: "POST", body: { action: "update", name: v.name, note: v.note, perms: fd.getAll("perm"), projects: fd.getAll("project"), ...this.collectAccess(f) } });
        this.toast("Сохранено", "ok");
      } else if (f.dataset.form === "chat") {
        f.querySelector("button").disabled = true;
        await this.api(`/api/admin/chat/${id}`, { method: "POST", body: { text: v.text } });
      } else if (f.dataset.form === "task") {
        await this.api("/api/admin/assign", { method: "POST", body: { kind: "task", text: v.text, due: v.due || null, operator: id } });
        this.toast("Задача поручена", "ok");
      } else if (f.dataset.form === "meeting") {
        const op = this.tab === "meet" ? v.operator || null : id;
        await this.api("/api/admin/assign", { method: "POST", body: { kind: "meeting", title: v.title, due: v.due, time: v.time, place: v.place, operator: op } });
        this.toast("Встреча назначена", "ok");
      }
      await this.reload();
    } catch (err) { this.toast(err.message, "error"); f.querySelector("button[disabled]")?.removeAttribute("disabled"); }
  }

  /** Событие с сервера: новое сообщение или изменился оператор. */
  async onEvent(type, d) {
    if (!this.isOpen) return;
    if (type === "chat" && d.op === this.sel && this.sub === "chat" && this.tab === "ops") { await this.reload(); return; }
    await this.reload();
  }
}
