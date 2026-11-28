// Окно «Приложения» — каталог: встроенные приложения Atom (карта, финансы, хранилище, граф, команда, настройки и
// диагностика) и свои программы из каталога (/api/apps). Открывается кнопкой в нижней навигации и в шапке.
// Логика без DOM — apps-catalog.js; своё приложение со ссылкой открывается внутри Atom (app-viewer.js).
import { esc } from "./markdown.js?v=33";
import { appIcon, groupedBuiltin, launcherItems } from "./apps-catalog.js?v=33";

export class AppsWindow {
  /** launch(id) — открыть встроенное; openApp(app) — своё по ссылке; openPage(app) — страница проекта / заметка. */
  constructor(root, { api, toast, launch, openApp, openPage, standalone = false }) {
    Object.assign(this, { root, api, toast, launch, openApp, openPage, standalone });
    this.data = { apps: [], available: [] };
    this.query = "";
    root.innerHTML = `
      <div class="fw-top">
        <div class="fw-title">Приложения <span class="muted" data-el="meta"></span></div>
        <input class="aw-search" data-el="q" type="search" placeholder="Найти приложение…" aria-label="Найти приложение" autocomplete="off">
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="aw-body" data-el="body"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    this.el("q").addEventListener("input", () => { this.query = this.el("q").value; this.render(); });
    root.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches(".app-tile")) { e.preventDefault(); e.target.click(); }
    });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show() {
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    this.render();
    await this.reload();
  }

  close() { this.root.classList.add("hidden"); document.body.classList.remove("fw-on"); }

  async reload() {
    try { this.data = await this.api("/api/apps"); } catch (e) { this.toast(e.message, "error"); }
    this.render();
  }

  tile(a, own) {
    const sub = own ? `<div class="app-meta"><span class="pill ${esc(a.status)}">${esc(a.status_label || "")}</span>${a.repo ? `<span class="muted">${esc(a.repo)}</span>` : ""}</div>` : "";
    return `<article class="app-tile ${own ? "own" : "builtin"}" ${own ? `data-own="${a.i}"` : `data-launch="${esc(a.id)}"`} tabindex="0" role="button" aria-label="${esc(a.name)}">
      <div class="app-ic big" aria-hidden="true">${esc(appIcon(a))}</div>
      <b>${esc(a.name)}</b><small>${esc(a.description || "без описания")}</small>${sub}
      ${own ? `<div class="app-acts">
        ${a.url ? `<button class="btn primary" data-open="${a.i}">Открыть</button>` : ""}
        <button class="btn ghost" data-page="${a.i}">${a.kind === "project" ? "Проект" : "Заметка"}</button>
        ${a.kind === "project" ? `<button class="h-btn" data-remove="${a.i}" title="Убрать из каталога" aria-label="Убрать из каталога">✕</button>` : ""}
      </div>` : ""}</article>`;
  }

  render() {
    const { builtin, own } = launcherItems({ apps: this.data.apps, standalone: this.standalone, query: this.query });
    const groups = groupedBuiltin(builtin);
    this.el("meta").textContent = this.data.apps.length ? `${this.data.apps.length} своих` : "";
    this.el("body").innerHTML = `
      <p class="aw-lead">Остальные дела Atom. Задачи и проекты — на своих вкладках, голос — на «Главной».</p>
      ${groups.map((g) => `<section><h3 class="aw-h">${g.title}</h3>
        <div class="aw-grid">${g.items.map((a) => this.tile(a, false)).join("")}</div></section>`).join("")
        || (this.query ? `<p class="empty">Среди приложений Atom ничего не нашлось.</p>` : "")}
      <section><h3 class="aw-h">Мои приложения <button class="btn ghost" data-act="add">＋ Добавить</button></h3>
        <div class="aw-grid">${own.map((a) => this.tile(a, true)).join("")
          || `<p class="empty">${this.query ? "Среди своих приложений ничего не нашлось." : "Здесь будут ваши программы. «＋ Добавить» — проект в каталог, или заметка с <code>type: app</code> и <code>url:</code>."}</p>`}</div></section>
      <div class="aw-add hidden" data-el="add"></div>`;
  }

  async onClick(e) {
    const t = e.target;
    if (t.closest("[data-act=close]")) { this.close(); return; }
    const open = t.closest("[data-open]");
    if (open) { this.openApp(this.data.apps[+open.dataset.open]); return; }
    const page = t.closest("[data-page]");
    if (page) { this.close(); this.openPage(this.data.apps[+page.dataset.page]); return; }
    const rm = t.closest("[data-remove]");
    if (rm) {
      const a = this.data.apps[+rm.dataset.remove];
      try { this.data = await this.api("/api/apps", { method: "POST", body: { name: a.name, on: false } }); this.render(); this.toast(`«${a.name}» убран из каталога`, "ok"); }
      catch (err) { this.toast(err.message, "error"); }
      return;
    }
    const pick = t.closest("[data-pick]");
    if (pick) {
      try { this.data = await this.api("/api/apps", { method: "POST", body: { name: pick.dataset.pick, on: true } }); this.render(); }
      catch (err) { this.toast(err.message, "error"); }
      return;
    }
    if (t.closest("[data-act=add]")) {
      const box = this.el("add");
      box.innerHTML = this.data.available.length
        ? `<p class="muted">Проект попадёт в каталог — в его заметке появится строка <code>catalog: true</code>.</p>
          <div class="pick-list">${this.data.available.map((n) => `<button class="btn ghost" data-pick="${esc(n)}">${esc(n)}</button>`).join("")}</div>`
        : `<p class="muted">Все проекты уже в каталоге. Новый проект — «＋» в разделе «Проекты».</p>`;
      box.classList.toggle("hidden");
      return;
    }
    const launch = t.closest("[data-launch]");
    if (launch) { this.close(); this.launch(launch.dataset.launch); return; }
    const own = t.closest("[data-own]");
    if (own && !t.closest("button, a")) {
      const a = this.data.apps[+own.dataset.own];
      if (a.url) this.openApp(a); else { this.close(); this.openPage(a); }
    }
  }
}
