// Приложение из каталога внутри Atom: окно со встроенной страницей (iframe) — «Ценники» и другие свои программы
// открываются, не уходя с дашборда. Работает и у владельца, и в кабинете оператора.
// Мост с приложением (app-bridge.js): готовые файлы приложение отдаёт Atom, и Atom показывает своё окно «Файл готов»
// (во встроенной странице браузер не даёт скачать файл или вызвать «Поделиться», особенно на iPhone); общие данные
// приложения хранит Atom (/api/appdata, у оператора — /api/op/appdata) и рассылает изменения всем открытым копиям.
import { esc } from "./markdown.js?v=34";
import { appIcon } from "./apps-catalog.js?v=34";
import { embeddableUrl, fileFromMessage, fileSize, fromApp, toApp } from "./app-bridge.js?v=34";

const CLIENT = Math.random().toString(36).slice(2, 10);

export class AppViewer {
  /** storeApi — адрес общих данных: владелец — /api/appdata, оператор — /api/op/appdata. */
  constructor(root, { api = null, toast = () => {}, storeApi = "/api/appdata" } = {}) {
    Object.assign(this, { root, api, toast, storeApi });
    this.app = null;
    this.rev = 0;
    root.innerHTML = `<div class="av-top">
        <span class="av-ic" data-el="ic"></span><b data-el="name"></b><small class="muted" data-el="host"></small>
        <span class="av-sync hidden" data-el="sync" title="Данные приложения общие: владелец и операторы видят одно и то же"></span>
        <a class="btn ghost" data-el="ext" target="_blank" rel="noopener" title="Открыть в новой вкладке">↗ В новой вкладке</a>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button></div>
      <div class="av-frame" data-el="frame"></div>
      <div class="av-sheet hidden" data-el="sheet" role="dialog" aria-label="Файл готов"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    addEventListener("message", (e) => this.onMessage(e));
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  open(app) {
    if (!embeddableUrl(app.url)) { window.open(app.url, "_blank", "noopener"); return; }
    const url = new URL(app.url);
    this.app = app;
    this.origin = url.origin;
    this.rev = 0;
    this.el("ic").textContent = appIcon(app);
    this.el("name").textContent = app.name;
    this.el("host").textContent = url.host;
    this.el("ext").href = url.href;
    this.el("sync").classList.add("hidden");
    this.el("frame").innerHTML = `<iframe src="${esc(url.href)}" title="${esc(app.name)}" referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      allow="clipboard-write; web-share; fullscreen"></iframe>
      <p class="av-hint muted">Если страница не появилась — сайт не разрешает встраивание: нажмите «↗ В новой вкладке».</p>`;
    this.frame = this.el("frame").querySelector("iframe");
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
  }

  close() {
    this.hideSheet();
    this.el("frame").innerHTML = "";
    this.frame = null;
    this.app = null;
    this.root.classList.add("hidden");
    document.body.classList.remove("fw-on");
  }

  post(atom, extra = {}) { this.frame?.contentWindow?.postMessage(toApp(atom, extra), this.origin); }

  // ---------- мост ----------
  async onMessage(e) {
    const m = fromApp(e, this.frame?.contentWindow, this.origin);
    if (!m || !this.app) return;
    if (m.atom === "hello") {
      const features = ["download"];
      let store = null;
      if (this.api && this.app.note) {
        try { store = await this.api(`${this.storeApi}?app=${encodeURIComponent(this.app.note)}`); features.push("store"); }
        catch { /* нет доступа или старый сервер — только файлы */ }
      }
      if (store) { this.rev = store.rev; this.syncLabel(store); }
      this.post("welcome", { features, store: store ? { data: store.data, rev: store.rev, by: store.by } : null });
    } else if (m.atom === "store:set") {
      if (!this.api || !this.app.note) return;
      try {
        const r = await this.api(this.storeApi, { method: "PUT", body: { app: this.app.note, data: m.data, client: CLIENT } });
        this.rev = r.rev;
        this.syncLabel(r);
      } catch (err) { this.toast(`${this.app.name}: не сохранилось в Atom — ${err.message}`, "error"); }
    } else if (m.atom === "download") {
      try { this.showSheet(fileFromMessage(m)); } catch (err) { this.toast(err.message, "error"); }
    }
  }

  /** Событие «appdata»: данные приложения сохранил кто-то другой — отдать свежие открытому приложению. */
  async onAppData(d) {
    if (!this.app || !d || d.app !== this.app.note || d.client === CLIENT || d.rev <= this.rev || !this.api) return;
    try {
      const s = await this.api(`${this.storeApi}?app=${encodeURIComponent(this.app.note)}`);
      this.rev = s.rev;
      this.syncLabel(s);
      this.post("store", { data: s.data, rev: s.rev, by: s.by });
    } catch { /* доступ отняли или нет сети */ }
  }

  syncLabel(s) {
    const el = this.el("sync");
    el.textContent = `⇅ общие${s.by ? ` · ${s.by}` : ""}`;
    el.classList.remove("hidden");
  }

  // ---------- окно «Файл готов» ----------
  showSheet(f) {
    this.hideSheet();
    const url = URL.createObjectURL(f.blob);
    const file = new File([f.blob], f.name, { type: f.type });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    this.sheet = { url, file };
    const box = this.el("sheet");
    box.innerHTML = `<div class="av-sheet-box"><b>Файл готов</b><p>${esc(f.name)} <span class="muted">· ${esc(fileSize(f.size))}</span></p>
      <div class="av-sheet-acts">
        ${canShare ? `<button class="btn primary" data-act="share">Поделиться · Печать · В «Файлы»</button>` : ""}
        <a class="btn ${canShare ? "ghost" : "primary"}" data-act="download" href="${url}" download="${esc(f.name)}">Скачать</a>
        <a class="btn ghost" data-act="open-file" href="${url}" target="_blank" rel="noopener">Открыть</a>
        <button class="btn ghost" data-act="sheet-close">Закрыть</button></div></div>`;
    box.classList.remove("hidden");
  }

  hideSheet() {
    if (this.sheet) setTimeout((u) => URL.revokeObjectURL(u), 60000, this.sheet.url);
    this.sheet = null;
    this.el("sheet").classList.add("hidden");
  }

  async onClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") this.close();
    else if (act === "sheet-close" || e.target === this.el("sheet")) this.hideSheet();
    else if (act === "share") {
      try { await navigator.share({ files: [this.sheet.file], title: this.sheet.file.name }); this.hideSheet(); }
      catch (err) { if (err?.name !== "AbortError") this.toast("«Поделиться» недоступно — нажмите «Скачать»", "warn"); }
    } else if (act === "download" || act === "open-file") setTimeout(() => this.hideSheet(), 400);
  }
}
