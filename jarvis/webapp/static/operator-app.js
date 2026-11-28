// Кабинет оператора: поручения владельца и свой список задач, встречи, общие проекты (только те, что владелец
// открыл), приложения из каталога (к которым дан доступ), личные заметки (папка Команда/<Имя>/) и доверенные
// заметки владельца (читать или править), чат с владельцем, свои устройства (выйти на любом) и пароль.
// Сервер пускает оператора только в /api/op/… и /api/sessions (web.py), события WebSocket приходят только его.
import { esc, renderMarkdown } from "./markdown.js?v=33";
import { fmtDay } from "./util.js?v=33";
import { chatDays, seen } from "./team.js?v=33";

const STATUS = { idea: "идея", active: "в работе", paused: "на паузе", done: "завершён" };
const TABS = [["tasks", "Задачи"], ["meet", "Встречи"], ["proj", "Проекты"], ["apps", "Приложения"], ["exchange", "Обмен"], ["notes", "Заметки"], ["chat", "Чат"], ["me", "Устройства"]];
const KIND = { doc: "📄", sheet: "📊", slides: "🖼", text: "📝", file: "📎", folder: "📁" };
const LEVEL = { use: "открывать", manage: "управлять" };

export class OperatorApp {
  constructor(root, { api, toast }) {
    Object.assign(this, { root, api, toast });
    this.view = "all";
    this.tab = localStorage.getItem("atom.op.tab") || "tasks";
    this.note = null;            // открытая заметка { path, title, content, version, edit }
    document.body.classList.add("operator-mode");
    root.classList.remove("hidden");
    root.innerHTML = `
      <header class="op-top"><div class="brand"><span class="brand-mark">A.T.O.M.</span></div>
        <nav class="seg op-tabs" data-el="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}${k === "chat" ? ' <em class="tw-badge hidden" data-el="badge"></em>' : ""}</button>`).join("")}</nav>
        <div class="op-who" data-el="who"></div>
        <button class="btn ghost" data-act="logout">Выйти</button></header>
      <main class="op-main" data-el="main"></main>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => { if (e.target.matches("[data-view]")) { this.view = e.target.value; this.render(); } });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
    });
  }

  async start() {
    this.me = await this.api("/api/op/me");
    try { localStorage.setItem("atom.role", "operator"); } catch { /* приватный режим */ }
    const op = this.me.operator;
    this.el("who").innerHTML = `<span class="tw-av">${esc(op.name.slice(0, 1).toUpperCase())}</span><span><b>${esc(op.name)}</b><small>оператор</small></span>`;
    if (this.me.unread) this.badge(this.me.unread);
    await this.render();
    if (!this.ws) this.connect();
  }

  badge(n) { const b = this.el("badge"); b.textContent = n; b.classList.toggle("hidden", !n); }

  async render() {
    localStorage.setItem("atom.op.tab", this.tab);
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const main = this.el("main");
    try { main.innerHTML = await this[`tab_${this.tab}`](); } catch (e) { main.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    main.querySelector(".tw-chat-log")?.scrollTo(0, 1e9);
    if (this.tab === "chat") this.badge(0);
  }

  // ---------- задачи: поручено + мои ----------
  task(t) {
    const done = t.status === "done", today = this.me.today;
    return `<li class="task ${done ? "done" : ""} prio-${t.priority}" data-id="${esc(t.id)}">
      <button class="check" data-check="${done ? "todo" : "done"}" aria-label="${done ? "Вернуть" : "Выполнено"}"></button>
      <div class="t-text">${esc(t.text)}</div>${t.due ? `<div class="t-meta ${t.due < today && !done ? "over" : t.due === today ? "today" : ""}">${esc(fmtDay(t.due))}</div>` : ""}</li>`;
  }

  async tab_tasks() {
    const r = await this.api(`/api/op/tasks?view=${this.view}`);
    const doneMine = r.done_today.filter((t) => t.path.startsWith(this.me.operator.folder + "/"));
    const doneAssigned = r.done_today.filter((t) => !t.path.startsWith(this.me.operator.folder + "/"));
    return `<div class="op-bar"><select data-view aria-label="Показать">${[["all", "Все"], ["today", "Сегодня"], ["week", "Неделя"], ["overdue", "Просроченные"]]
      .map(([k, l]) => `<option value="${k}" ${k === this.view ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="op-grid2">
        <section class="panel"><div class="panel-h">Поручено <span class="h-meta">${r.assigned.length}</span></div>
          <ul class="tasks">${[...r.assigned, ...doneAssigned].map((t) => this.task(t)).join("") || `<li class="empty">Поручений нет — можно выдохнуть.</li>`}</ul></section>
        <section class="panel"><div class="panel-h">Мои задачи <span class="h-meta">${r.personal.length}</span></div>
          <ul class="tasks">${[...r.personal, ...doneMine].map((t) => this.task(t)).join("") || `<li class="empty">Свой список: дела, которые вы ведёте сами.</li>`}</ul>
          <form class="inline-add" data-form="task"><input name="text" required placeholder="Новая задача… (видна только вам)" autocomplete="off">
            <input name="due" type="date" aria-label="Срок"><button class="btn" aria-label="Добавить">＋</button></form></section>
      </div>`;
  }

  async tab_meet() {
    const m = await this.api("/api/op/meetings");
    const row = (x) => `<li class="task meet ${x.status === "done" ? "done" : ""}" data-id="${esc(x.id)}">
      <button class="check" data-check="${x.status === "done" ? "todo" : "done"}" aria-label="${x.status === "done" ? "Вернуть" : "Состоялась"}"></button>
      <div class="t-text"><b>${esc(x.title)}</b><small class="muted">${esc(fmtDay(x.due))}${x.time ? ` · ${esc(x.time)}` : ""}${x.place ? ` · 📍 ${esc(x.place)}` : ""}</small></div></li>`;
    return `<section class="panel op-narrow"><div class="panel-h">Встречи <span class="h-meta">${m.today ? `${m.today} сегодня` : ""}</span></div>
      <ul class="tasks">${m.upcoming.map(row).join("") || `<li class="empty">Встреч не назначено.</li>`}</ul>
      ${m.done.length ? `<div class="fm-group">Состоялись</div><ul class="tasks">${m.done.map(row).join("")}</ul>` : ""}</section>`;
  }

  async tab_proj() {
    const r = await this.api("/api/op/projects");
    if (!r.projects.length) return `<section class="panel op-narrow"><p class="empty">Общих проектов пока нет — владелец откроет их вам в «Команде».</p></section>`;
    return `<div class="op-grid2">${r.projects.map((p) => `<section class="panel"><div class="panel-h">${esc(p.name)} <span class="pill ${esc(p.status)}">${esc(STATUS[p.status] || p.status)}</span></div>
      ${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}
      <div class="fm-progress"><i style="width:${p.progress.percent}%"></i><span>${p.progress.percent}% · выполнено ${p.progress.done} из ${p.progress.total}</span></div>
      <ul class="tasks">${p.tasks.map((t) => this.task(t)).join("") || `<li class="empty">Открытых задач нет.</li>`}</ul>
      ${r.can_add ? `<form class="inline-add" data-form="task" data-project="${esc(p.name)}"><input name="text" required placeholder="Задача в проект…" autocomplete="off">
        <input name="due" type="date" aria-label="Срок"><button class="btn" aria-label="Добавить">＋</button></form>` : ""}</section>`).join("")}</div>`;
  }

  // ---------- приложения, к которым владелец дал доступ ----------
  async tab_apps() {
    const r = await this.api("/api/op/apps");
    this.apps = r.apps;
    if (!r.apps.length) return `<section class="panel op-narrow"><p class="empty">Приложений пока нет — владелец откроет их вам в «Команде → Доступ».</p></section>`;
    return `<div class="op-apps">${r.apps.map((a, i) => `<article class="app-tile" data-app-i="${i}">
      <div class="app-ic big" aria-hidden="true">${esc(a.icon || a.name.slice(0, 1).toUpperCase())}</div>
      <b>${esc(a.name)}</b><small>${esc(a.description || "")}</small>
      <div class="app-meta"><span class="pill">${esc(LEVEL[a.level] || a.level)}</span></div>
      <div class="app-acts">
        ${a.kind === "builtin" || a.url ? `<button class="btn primary" data-app-open="${i}">Открыть</button>` : ""}
        ${a.url ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener" title="В новой вкладке">↗</a>` : ""}
        ${a.note && a.level === "manage" ? `<button class="btn ghost" data-app-note="${esc(a.note)}">✎ Заметка</button>` : ""}
      </div></article>`).join("")}</div>`;
  }

  async openApp(a) {
    if (a.kind === "builtin" && a.id === "builtin:exchange") { await this.exchangeApp(); return; }
    if (a.kind === "builtin" && a.id === "builtin:map") {
      if (!this.map) {
        const { MapWindow } = await import("./map.js?v=33");
        const store = { get: (k, d) => { try { const v = localStorage.getItem(`atom.op.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
          set: (k, v) => { try { localStorage.setItem(`atom.op.${k}`, JSON.stringify(v)); } catch { /* приватный режим */ } } };
        this.map = new MapWindow(document.getElementById("mw"), { api: this.api, toast: this.toast, store, places: false,
          speak: (t) => { try { speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(t), { lang: "ru-RU" })); } catch { /* нет голоса */ } } });
      }
      await this.map.show({});
      return;
    }
    if (!this.viewer) {
      const { AppViewer } = await import("./app-viewer.js?v=33");
      this.viewer = new AppViewer(document.getElementById("av"), { api: this.api, toast: this.toast, storeApi: "/api/op/appdata" });
    }
    this.viewer.open(a);
  }

  // ---------- личные заметки ----------
  // ---------- «Обмен файлами»: только папки, которые открыл владелец ----------
  async tab_exchange() {
    const r = await this.api("/api/op/exchange");
    if (!r.files.length) {
      return `<div class="tw-work single"><section class="tw-card"><h3>Обмен файлами</h3>
        <p class="empty">Владелец пока не открыл вам папки для обмена файлами.</p></section></div>`;
    }
    return `<div class="tw-work single"><section class="tw-card"><h3>Обмен файлами · ${r.files.length}</h3>
      <p class="muted small">Только папки, которые открыл владелец. Грузить можно туда, где разрешено.</p>
      <ul class="tw-notes">${r.files.map((f) => `<li><span class="tw-note-path">${KIND[f.kind] || "📁"} ${esc(f.name)}
        <small class="muted">${esc(f.level_label || "")}</small></span>
        <button class="btn ghost" data-exchange-folder="${esc(f.path)}">Открыть папку</button></li>`).join("")}</ul>
      <div class="mw-acts"><button class="btn primary" data-act="exchange-app">Открыть приложение «Обмен»</button></div>
    </section></div>`;
  }

  /** Приложение «Обмен файлами»: выданные папки, скачивание и загрузка туда, где разрешено. */
  async exchangeApp(folder = "") {
    if (!this.exchange) {
      const { ExchangeWindow } = await import("./exchange.js?v=33");
      this.exchange = new ExchangeWindow(document.getElementById("xw"),
        { api: this.api, toast: this.toast, mode: "operator" });
    }
    document.body.classList.add("fw-on");
    await this.exchange.show({ folder });
  }

  async tab_notes() {
    const r = await this.api("/api/op/notes");
    const list = `<aside class="op-notes-list">
      <form class="inline-add" data-form="note-new"><input name="title" required placeholder="Новая заметка…" autocomplete="off" maxlength="80"><button class="btn" aria-label="Создать">＋</button></form>
      <ul>${r.notes.map((n) => `<li class="${this.note?.path === n.path ? "on" : ""}" data-note="${esc(n.path)}"><b>${n.tasks ? "☑ " : ""}${esc(n.title)}</b>
        <small>${esc(n.snippet || "пусто")}</small></li>`).join("") || `<li class="empty">Заметок пока нет. Они видны только вам и владельцу (папка <code>${esc(r.folder)}</code>).</li>`}</ul>
      ${(r.shared || []).length ? `<div class="fm-group">Доверенные владельцем</div>
      <ul>${r.shared.map((n) => `<li class="${this.note?.path === n.path ? "on" : ""}" data-note="${esc(n.path)}"><b>${n.edit ? "✎ " : "👁 "}${esc(n.title)}</b>
        <small>${esc(n.folder || "корень хранилища")} · ${n.edit ? "можно править" : "только чтение"}</small></li>`).join("")}</ul>` : ""}</aside>`;
    let view = `<div class="op-note-empty muted">Выберите заметку слева или создайте новую.</div>`;
    if (this.note) {
      const n = this.note;
      view = n.edit
        ? `<form class="op-note" data-form="note-save"><div class="op-note-h"><b>${esc(n.title)}</b>
            <button type="button" class="btn ghost" data-act="note-cancel">Отмена</button><button class="btn primary">Сохранить</button></div>
            <textarea name="content" class="np-editor">${esc(n.content)}</textarea></form>`
        : `<div class="op-note"><div class="op-note-h"><b>${esc(n.title)}</b>${n.own === false ? ` <small class="muted">${esc(n.path)}</small>` : ""}
            ${n.editable !== false ? `<button class="btn ghost" data-act="note-edit">✎ Править</button>` : `<span class="pill">только чтение</span>`}
            ${n.own !== false ? `<button class="btn ghost danger" data-act="note-trash" title="В корзину">🗑</button>` : ""}</div>
            <div class="md op-note-body">${renderMarkdown(n.content).html}</div></div>`;
    }
    return `<div class="op-notes">${list}<section class="panel">${view}</section></div>`;
  }

  async openNote(path, edit = false) {
    const r = await this.api(`/api/op/note?path=${encodeURIComponent(path)}`);
    this.note = { ...r, edit };
    await this.render();
  }

  // ---------- чат ----------
  async tab_chat() {
    const r = await this.api("/api/op/chat");
    return `<section class="panel op-chat op-narrow"><div class="panel-h">Чат с владельцем</div>
      <div class="tw-chat-log">${r.messages.length ? chatDays(r.messages, this.me.today).map((d) => `<div class="tw-day">${esc(d.label)}</div>
        ${d.items.map((m) => `<div class="tw-msg ${m.from === "operator" ? "mine" : ""}"><p>${esc(m.text).replace(/\n/g, "<br>")}</p><small>${esc(m.time)}</small></div>`).join("")}`).join("")
        : `<p class="empty">Напишите владельцу — вопрос, отчёт, что угодно.</p>`}</div>
      <form class="tw-send" data-form="chat"><textarea name="text" rows="1" placeholder="Сообщение… (Ctrl+Enter — отправить)" required></textarea>
        <button class="btn primary" aria-label="Отправить">➤</button></form></section>`;
  }

  // ---------- устройства и пароль ----------
  async tab_me() {
    const r = await this.api("/api/sessions");
    return `<div class="op-grid2">
      <section class="panel"><div class="panel-h">Мои устройства <span class="h-meta">${r.sessions.length}</span></div>
        ${devicesList(r.sessions)}
        ${r.sessions.length > 1 ? `<button class="btn ghost" data-act="others">Выйти на всех других устройствах</button>` : ""}</section>
      <form class="panel tw-card" data-form="password"><div class="panel-h">Пароль</div>
        <p class="muted small">Им вы входите с других устройств: «Я оператор» → имя и пароль.</p>
        <input type="password" name="old" placeholder="Текущий пароль" required autocomplete="current-password">
        <input type="password" name="new" placeholder="Новый пароль (от 6 символов)" minlength="6" required autocomplete="new-password">
        <button class="btn primary">Сменить пароль</button></form></div>`;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onmessage = (m) => {
      let e; try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === "chat") {
        if (this.tab === "chat") this.render();
        else if (e.data?.message?.from === "owner") { this.badge(Number(this.el("badge").textContent || 0) + 1); this.toast(`Владелец: ${e.data.message.text.slice(0, 120)}`, "info"); }
      }
      if (e.type === "refresh" && ["tasks", "meet", "proj"].includes(this.tab)) { clearTimeout(this.rt); this.rt = setTimeout(() => this.render(), 300); }
      if (e.type === "operators") this.start().catch(() => location.reload());
      if (e.type === "appdata") this.viewer?.onAppData(e.data);
    };
    this.ws.onclose = () => setTimeout(() => this.api("/api/op/me").then(() => this.connect()).catch(() => location.reload()), 3000);
  }

  async onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; this.render(); return; }
    const check = t.closest("[data-check]");
    if (check) {
      const li = check.closest("[data-id]");
      li.classList.toggle("done", check.dataset.check === "done");
      try { await this.api(`/api/op/tasks/${encodeURIComponent(li.dataset.id)}/status`, { method: "POST", body: { status: check.dataset.check } }); await this.render(); }
      catch (err) { li.classList.toggle("done"); this.toast(err.message, "error"); }
      return;
    }
    const note = t.closest("[data-note]");
    if (note) { this.openNote(note.dataset.note).catch((err) => this.toast(err.message, "error")); return; }
    const appOpen = t.closest("[data-app-open]");
    if (appOpen) { this.openApp(this.apps[+appOpen.dataset.appOpen]).catch((err) => this.toast(err.message, "error")); return; }
    const appNote = t.closest("[data-app-note]");
    if (appNote) { this.tab = "notes"; this.openNote(appNote.dataset.appNote, true).catch((err) => this.toast(err.message, "error")); return; }
    const exchangeFolder = t.closest("[data-exchange-folder]");
    if (exchangeFolder) {
      this.exchangeApp(exchangeFolder.dataset.exchangeFolder).catch((err) => this.toast(err.message, "error"));
      return;
    }
    if (t.closest('[data-act="exchange-app"]')) { this.exchangeApp().catch((err) => this.toast(err.message, "error")); return; }
    const rev = t.closest("[data-revoke]");
    if (rev) { await this.call(() => this.api("/api/sessions", { method: "POST", body: { action: "revoke", sid: rev.dataset.revoke } }), "Устройство отключено"); return; }
    const b = t.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "logout") { await this.api("/api/logout", { method: "POST", body: {} }).catch(() => {}); location.href = "./"; }
    if (act === "others") await this.call(() => this.api("/api/sessions", { method: "POST", body: { action: "others" } }), "Вы вышли на всех других устройствах");
    if (act === "note-edit") { this.note.edit = true; this.render(); }
    if (act === "note-cancel") { this.note.edit = false; this.render(); }
    if (act === "note-trash") {
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Точно?"; return; }
      await this.call(() => this.api("/api/op/note", { method: "POST", body: { action: "trash", path: this.note.path } }), "Заметка — в корзине");
      this.note = null; this.render();
    }
  }

  async call(fn, ok) {
    try { await fn(); if (ok) this.toast(ok, "ok"); await this.render(); } catch (err) { this.toast(err.message, "error"); }
  }

  async onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.form === "chat") await this.api("/api/op/chat", { method: "POST", body: { text: v.text } });
      else if (f.dataset.form === "task") await this.api("/api/op/tasks", { method: "POST", body: { text: v.text, due: v.due || null, project: f.dataset.project || null } });
      else if (f.dataset.form === "note-new") {
        const r = await this.api("/api/op/note", { method: "POST", body: { title: v.title } });
        await this.openNote(r.path, true);
        return;
      } else if (f.dataset.form === "note-save") {
        const r = await this.api("/api/op/note", { method: "PUT", body: { path: this.note.path, content: v.content, base: this.note.version } });
        this.toast("Сохранено", "ok");
        await this.openNote(r.path);
        return;
      } else if (f.dataset.form === "password") {
        await this.api("/api/op/me", { method: "POST", body: { old: v.old, new: v.new } });
        this.toast("Пароль изменён", "ok");
      }
      await this.render();
    } catch (err) {
      if (err.status === 409 && err.data?.content !== undefined) {
        this.toast("Заметку изменили на другом устройстве — показываю свежую версию, ваш текст скопирован в буфер", "warn");
        try { await navigator.clipboard.writeText(v.content); } catch { /* нет доступа к буферу */ }
        await this.openNote(this.note.path, true);
        return;
      }
      this.toast(err.message, "error");
    }
  }
}

/** Список устройств — и в кабинете оператора, и у владельца («Команда»). */
export function devicesList(list, { revoke = true } = {}) {
  if (!list.length) return `<p class="empty">Активных устройств нет.</p>`;
  return `<ul class="op-devices">${list.map((s) => `<li class="${s.current ? "current" : ""}">
    <span class="dv-ic">${/iPhone|Android/.test(s.device) ? "📱" : /iPad/.test(s.device) ? "📟" : /Скрипт/.test(s.device) ? "⚙" : "💻"}</span>
    <span><b>${esc(s.device)}</b><small>${s.current ? "это устройство · " : ""}${s.last_seen ? esc(seen(s.last_seen)).replace("был(а) ", "") : ""}${s.ip ? ` · ${esc(s.ip)}` : ""}${s.created ? ` · вход ${esc(new Date(s.created * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }))}` : ""}</small></span>
    ${revoke && !s.current ? `<button class="btn ghost" data-revoke="${esc(s.sid)}">Выйти</button>` : ""}</li>`).join("")}</ul>`;
}
