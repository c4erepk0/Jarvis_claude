// Кабинет оператора: то, что поручил владелец, — задачи и встречи (отметить «выполнено» / «состоялась»),
// чат с владельцем, проекты (если разрешено). Финансы, память, голос и прочее оператору не видны: сервер пускает
// его только в /api/op/… (web.py), а события WebSocket приходят только его.
import { esc } from "./markdown.js?v=21";
import { chatDays } from "./team.js?v=21";

const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }) : "");

export class OperatorApp {
  constructor(root, { api, toast }) {
    Object.assign(this, { root, api, toast });
    this.view = "all";
    this.tab = "tasks";
    document.body.classList.add("operator-mode");
    root.classList.remove("hidden");
    root.innerHTML = `
      <header class="op-top"><div class="brand"><span class="brand-mark">A.T.O.M.</span></div>
        <div class="op-who" data-el="who"></div>
        <button class="btn ghost" data-act="logout">Выйти</button></header>
      <nav class="seg op-tabs" data-el="tabs"><button data-tab="tasks">Задачи</button><button data-tab="meet">Встречи</button>
        <button data-tab="chat">Чат <em class="tw-badge hidden" data-el="badge"></em></button><button data-tab="proj" class="hidden">Проекты</button></nav>
      <main class="op-grid">
        <section class="panel op-col" data-col="tasks"><div class="panel-h">Мои задачи <span class="h-meta" data-el="tmeta"></span></div>
          <div class="seg" data-el="seg"><button data-view="all">Все</button><button data-view="today">Сегодня</button><button data-view="week">Неделя</button></div>
          <ul class="tasks" data-el="tasks"></ul><form class="inline-add hidden" data-form="task"><input name="text" required placeholder="Новая задача…" autocomplete="off">
          <input name="due" type="date" aria-label="Срок"><button class="btn">＋</button></form></section>
        <section class="panel op-col" data-col="meet"><div class="panel-h">Встречи <span class="h-meta" data-el="mmeta"></span></div>
          <ul class="tasks" data-el="meet"></ul></section>
        <section class="panel op-col op-chat" data-col="chat"><div class="panel-h">Чат с владельцем</div>
          <div class="tw-chat-log" data-el="log"></div>
          <form class="tw-send" data-form="chat"><textarea name="text" rows="1" placeholder="Сообщение… (Ctrl+Enter — отправить)" required></textarea>
          <button class="btn primary" aria-label="Отправить">➤</button></form></section>
        <section class="panel op-col hidden" data-col="proj"><div class="panel-h">Проекты</div><ul class="op-proj" data-el="proj"></ul></section>
      </main>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) { e.preventDefault(); e.target.form.requestSubmit(); }
    });
  }

  async start() {
    this.me = await this.api("/api/op/me");
    const op = this.me.operator;
    this.el("who").innerHTML = `<span class="tw-av">${esc(op.name.slice(0, 1).toUpperCase())}</span><span><b>${esc(op.name)}</b><small>оператор</small></span>`;
    this.root.querySelector('[data-form="task"]').classList.toggle("hidden", !op.perms.includes("add_tasks"));
    const proj = op.perms.includes("projects");
    this.root.querySelector('[data-tab="proj"]').classList.toggle("hidden", !proj);
    this.root.querySelector('[data-col="proj"]').classList.toggle("hidden", !proj);
    this.setTab(this.tab);
    await Promise.all([this.loadTasks(), this.loadMeetings(), this.loadChat(), proj ? this.loadProjects() : null]);
    this.connect();
  }

  setTab(tab) {
    this.tab = tab;
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    this.root.querySelectorAll("[data-col]").forEach((c) => c.classList.toggle("active", c.dataset.col === tab));
    if (tab === "chat") { this.el("badge").classList.add("hidden"); this.el("log").scrollTo(0, 1e9); }
  }

  async loadTasks() {
    const r = await this.api(`/api/op/tasks?view=${this.view}`);
    this.root.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === this.view));
    this.el("tmeta").textContent = `${r.tasks.length} открыто · ${r.done_today.length} сегодня готово`;
    const row = (t) => `<li class="task ${t.status === "done" ? "done" : ""} prio-${t.priority}" data-id="${esc(t.id)}">
      <button class="check" data-check="${t.status === "done" ? "todo" : "done"}" aria-label="${t.status === "done" ? "Вернуть" : "Выполнено"}"></button>
      <div class="t-text">${esc(t.text)}</div>${t.due ? `<div class="t-meta ${t.due < this.me.today && t.status !== "done" ? "over" : t.due === this.me.today ? "today" : ""}">${esc(fmtDate(t.due))}</div>` : ""}</li>`;
    this.el("tasks").innerHTML = [...r.tasks, ...r.done_today].map(row).join("") || `<li class="empty">Поручений нет — можно выдохнуть.</li>`;
  }

  async loadMeetings() {
    const m = await this.api("/api/op/meetings");
    this.el("mmeta").textContent = m.today ? `${m.today} сегодня` : "";
    const row = (x) => `<li class="task meet ${x.status === "done" ? "done" : ""}" data-id="${esc(x.id)}">
      <button class="check" data-check="${x.status === "done" ? "todo" : "done"}" aria-label="${x.status === "done" ? "Вернуть" : "Состоялась"}"></button>
      <div class="t-text"><b>${esc(x.title)}</b><small class="muted">${esc(fmtDate(x.due))}${x.time ? ` · ${esc(x.time)}` : ""}${x.place ? ` · 📍 ${esc(x.place)}` : ""}</small></div></li>`;
    this.el("meet").innerHTML = (m.upcoming.map(row).join("") || `<li class="empty">Встреч не назначено.</li>`)
      + (m.done.length ? `<li class="fm-group">Состоялись</li>${m.done.map(row).join("")}` : "");
  }

  async loadChat(fromEvent = false) {
    const r = await this.api("/api/op/chat");
    this.el("log").innerHTML = r.messages.length ? chatDays(r.messages, this.me.today).map((d) => `<div class="tw-day">${esc(d.label)}</div>
      ${d.items.map((m) => `<div class="tw-msg ${m.from === "operator" ? "mine" : ""}"><p>${esc(m.text).replace(/\n/g, "<br>")}</p><small>${esc(m.time)}</small></div>`).join("")}`).join("")
      : `<p class="empty">Напишите владельцу — вопрос, отчёт, что угодно.</p>`;
    this.el("log").scrollTo(0, 1e9);
    if (fromEvent && this.tab !== "chat" && innerWidth < 900) { const b = this.el("badge"); b.textContent = "•"; b.classList.remove("hidden"); }
  }

  async loadProjects() {
    const r = await this.api("/api/op/projects");
    this.el("proj").innerHTML = r.projects.map((p) => `<li><b>${esc(p.name)}</b><small class="muted">${esc(p.description || "")}</small><span class="pill ${esc(p.status)}">${esc(p.status)}</span></li>`).join("")
      || `<li class="empty">Проектов нет.</li>`;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (m) => {
      let e; try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === "chat") { this.loadChat(true); if (e.data?.message?.from === "owner") this.toast(`Владелец: ${e.data.message.text.slice(0, 120)}`, "info"); }
      if (e.type === "refresh") { clearTimeout(this.rt); this.rt = setTimeout(() => { this.loadTasks(); this.loadMeetings(); }, 250); }
      if (e.type === "operators") this.start().catch(() => location.reload());
    };
    ws.onclose = () => setTimeout(() => this.connect(), 3000);
  }

  async onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { this.setTab(tab.dataset.tab); return; }
    const v = t.closest("[data-view]");
    if (v) { this.view = v.dataset.view; this.loadTasks(); return; }
    const check = t.closest("[data-check]");
    if (check) {
      const li = check.closest("[data-id]");
      li.classList.toggle("done", check.dataset.check === "done");
      try {
        await this.api(`/api/op/tasks/${encodeURIComponent(li.dataset.id)}/status`, { method: "POST", body: { status: check.dataset.check } });
        await Promise.all([this.loadTasks(), this.loadMeetings()]);
      } catch (err) { li.classList.toggle("done"); this.toast(err.message, "error"); }
      return;
    }
    if (t.closest('[data-act="logout"]')) { await this.api("/api/logout", { method: "POST", body: {} }).catch(() => {}); location.href = "./"; }
  }

  async onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.form === "chat") {
        await this.api("/api/op/chat", { method: "POST", body: { text: v.text } });
        f.reset();
        await this.loadChat();
      } else if (f.dataset.form === "task") {
        await this.api("/api/op/tasks", { method: "POST", body: { text: v.text, due: v.due || null } });
        f.reset();
        await this.loadTasks();
      }
    } catch (err) { this.toast(err.message, "error"); }
  }
}
