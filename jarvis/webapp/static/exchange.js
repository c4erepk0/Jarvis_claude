// Приложение «Обмен файлами» — папки на сервере Atom: владелец передаёт файлы операторам и принимает их.
//
// Никакого облака: файлы лежат в data/exchange/ на той машине, где работает Atom (jarvis/fileshare.py).
// Владелец видит все папки, создаёт свои, загружает и удаляет; оператор — только выданные папки, и грузит
// туда, где уровень «upload». Один класс на два режима: "owner" и "operator".
import { esc } from "./markdown.js?v=34";

const KIND = { image: "🖼", video: "🎬", audio: "🎵", text: "📝", pdf: "📄", file: "📎", folder: "📁" };
const LEVEL = { view: "Просмотр", upload: "Просмотр и загрузка" };

export class ExchangeWindow {
  constructor(root, { api, toast, mode = "owner" }) {
    Object.assign(this, { root, api, toast, mode });
    this.owner = mode === "owner";
    this.base = this.owner ? "/api/exchange" : "/api/op/exchange";
    this.stack = [];
    this.data = { folder: { id: "", name: "Обмен файлами" }, files: [] };
    root.innerHTML = `
      <div class="fw-top">
        <button class="btn ghost" data-act="back" title="Назад" aria-label="Назад">‹</button>
        <div class="fw-title" data-el="title">Обмен файлами</div>
        <input class="ex-search" data-el="search" placeholder="Поиск по имени…" autocomplete="off" aria-label="Поиск">
        <span class="ex-usage muted" data-el="usage"></span>
        <button class="btn ghost" data-act="reload" title="Обновить" aria-label="Обновить">↻</button>
        ${this.owner ? `<button class="btn ghost" data-act="mkdir">＋ Папка</button>` : ""}
        <button class="btn primary" data-act="upload">⬆ Загрузить</button>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="ex-body" data-el="body"></div>
      <input type="file" data-el="file" multiple class="hidden"
             accept="image/*,video/*,audio/*,application/pdf,text/*,application/msword,application/vnd.openxmlformats-officedocument.*">
      <div class="ex-panel hidden" data-el="panel"></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("change", (e) => this.onChange(e));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !root.classList.contains("hidden")) this.close();
      if (e.key === "Enter" && e.target.matches("[data-el=mkdir-name]")) this.mkdir();
    });
    if (!this.owner) this.el("search").classList.add("hidden");
    this.el("search").addEventListener("input", () => {
      clearTimeout(this._t);
      this._t = setTimeout(() => this.load(this.data.folder.id || "", true), 300);
    });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show(opts = {}) {
    this.stack = [];
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    await this.load(opts.folder || "");
  }

  close() {
    this.root.classList.add("hidden");
    document.body.classList.remove("fw-on");
    this.el("panel").classList.add("hidden");
  }

  // ---------- данные ----------
  async load(folder = "", keepSearch = false) {
    const q = keepSearch ? this.el("search").value.trim() : "";
    if (!keepSearch) this.el("search").value = "";
    const url = this.owner
      ? `${this.base}?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q)}`
      : `${this.base}/list?folder=${encodeURIComponent(folder)}`;
    this.el("body").innerHTML = `<p class="empty">Загружаю…</p>`;
    try {
      this.data = await this.api(url);
    } catch (e) {
      this.el("body").innerHTML = `<p class="empty">${esc(e.message)}</p>`;
      return;
    }
    this.render();
  }

  canUpload() {
    return this.owner ? true : Boolean(this.data.can_upload);
  }

  render() {
    const { folder, files = [] } = this.data;
    this.el("title").textContent = folder?.name || "Обмен файлами";
    this.root.querySelector('[data-act="back"]').disabled = !this.stack.length;
    this.root.querySelector('[data-act="upload"]').disabled = !this.canUpload();
    this.root.querySelector('[data-act="mkdir"]')?.toggleAttribute("disabled", !this.owner);
    const u = this.data;
    this.el("usage").textContent = u.quota
      ? `${u.size_label || "0 Б"} из ${u.quota_label}${u.count ? ` · ${u.count} файлов` : ""}` : "";
    this.el("body").innerHTML = files.length ? this.grid(files) : this.empty();
    this.el("panel").classList.add("hidden");
  }

  grid(files) {
    const folders = files.filter((f) => f.kind === "folder");
    const rest = files.filter((f) => f.kind !== "folder");
    const rows = (list) => `<div class="ex-grid">${list.map((f) => this.card(f)).join("")}</div>`;
    return `${folders.length ? `<h3 class="aw-h">Папки · ${folders.length}</h3>${rows(folders)}` : ""}
      ${rest.length ? `<h3 class="aw-h">Файлы · ${rest.length}</h3>${rows(rest)}` : ""}
      ${this.owner
        ? `<p class="muted small">«Доступ» у папки — кому из операторов она открыта и можно ли в неё загружать.
           Файлы хранятся на этом сервере, в data/exchange/.</p>`
        : `<p class="muted small">Только папки, которые открыл владелец. Загружать можно туда, где разрешено.</p>`}`;
  }

  card(f) {
    const isFolder = f.kind === "folder";
    const thumb = f.kind === "image"
      ? `<img class="ex-thumb" loading="lazy" alt="" src="${this.base}/raw/${encodeURIComponent(f.id)}?inline=1">` : "";
    const badge = f.level ? `<span class="pill">${esc(LEVEL[f.level] || f.level)}</span>` : "";
    return `<article class="ex-card" data-id="${esc(f.id)}">
      <button class="ex-open" data-open="${esc(f.id)}" ${isFolder ? "" : "data-file"} title="${esc(f.name)}">
        ${thumb || `<span class="ex-ic" aria-hidden="true">${KIND[f.kind] || "📎"}</span>`}
        <b>${esc(f.name)}</b>
        <small class="muted">${esc(f.size_label || "")}${f.modified ? ` · ${esc(String(f.modified).slice(0, 10))}` : ""}</small>
      </button>
      <div class="ex-acts">${badge}
        ${isFolder ? `<button class="h-btn" data-open="${esc(f.id)}" title="Открыть">Открыть</button>` : ""}
        ${isFolder && this.owner
          ? `<button class="h-btn" data-share="${esc(f.id)}" data-name="${esc(f.name)}" title="Кому открыто">Доступ</button>`
          : ""}
        ${!isFolder ? `<a class="h-btn" href="${this.base}/raw/${encodeURIComponent(f.id)}" title="Скачать">Скачать</a>` : ""}
        ${!isFolder && this.owner
          ? `<button class="h-btn" data-del="${esc(f.id)}" title="Удалить">Удалить</button>` : ""}
      </div></article>`;
  }

  empty() {
    if (!this.owner && !this.data.folder?.id) return `<p class="empty">Владелец пока не открыл вам папки для обмена файлами.</p>`;
    if (!this.owner) return `<p class="empty">Папка пуста.${this.canUpload() ? " Можно загрузить первый файл." : ""}</p>`;
    return `<p class="empty">Здесь пусто. «＋ Папка» — создать, «⬆ Загрузить» — положить файлы.</p>`;
  }

  // ---------- действия ----------
  async onClick(e) {
    const t = e.target;
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "close") return this.close();
    if (act === "reload") return this.load(this.data.folder?.id || "");
    if (act === "back") { const prev = this.stack.pop(); return this.load(prev || ""); }
    if (act === "mkdir") return this.mkdirForm();
    if (act === "upload") return this.el("file").click();

    const open = t.closest("[data-open]");
    if (open) {
      if (!open.hasAttribute("data-file")) {
        const current = this.data.folder?.id || "";
        if (!this.stack.length || this.stack[this.stack.length - 1] !== current) this.stack.push(current);
        return this.load(open.dataset.open);
      }
      const id = open.dataset.open;
      window.open(`${this.base}/raw/${encodeURIComponent(id)}?inline=1`, "_blank", "noopener");
      return;
    }

    const del = t.closest("[data-del]");
    if (del && this.owner) return this.remove(del);

    const share = t.closest("[data-share]");
    if (share && this.owner) return this.openShare(share.dataset.share, share.dataset.name);

    if (t.closest("[data-panel-close]")) { this.el("panel").classList.add("hidden"); return; }
  }

  onChange(e) {
    if (e.target.matches("[data-el=file]")) this.upload([...e.target.files || []]);
  }

  async remove(btn) {
    if (!btn.dataset.sure) { btn.dataset.sure = "1"; btn.textContent = "Точно?"; return; }
    try {
      await this.api("/api/exchange/delete", { method: "POST", body: { id: btn.closest("[data-id]").dataset.id } });
      this.toast("Удалено", "ok");
      await this.load(this.data.folder?.id || "");
    } catch (err) { this.toast(err.message, "error"); }
  }

  // ---------- папка ----------
  mkdirForm() {
    const panel = this.el("panel");
    panel.classList.remove("hidden");
    panel.innerHTML = `<section class="tw-card"><h3>Новая папка</h3>
      <div class="inline-add"><input data-el="mkdir-name" placeholder="Название папки" autocomplete="off" maxlength="120">
        <button class="btn primary" data-act="mkdir-go">Создать</button>
        <button class="btn ghost" data-panel-close>Отмена</button></div></section>`;
    this.el("mkdir-name").focus();
    panel.querySelector('[data-act="mkdir-go"]').onclick = () => this.mkdir();
  }

  async mkdir() {
    const input = this.el("mkdir-name");
    const name = input?.value.trim();
    if (!name) return;
    try {
      await this.api("/api/exchange/mkdir", { method: "POST", body: { name, parent: this.data.folder?.id || "" } });
      this.toast("Папка создана", "ok");
      await this.load(this.data.folder?.id || "");
    } catch (err) { this.toast(err.message, "error"); }
  }

  // ---------- загрузка ----------
  async upload(files) {
    if (!files.length) return;
    const folder = this.data.folder?.id || "";
    let done = 0;
    this.toast(`Загружаю ${files.length}…`, "ok");
    for (const f of files) {
      const form = new FormData();
      form.append("file", f);
      form.append("folder", folder);
      try {
        await this.api(`${this.base}/upload`, { method: "POST", form });
        done += 1;
      } catch (err) { this.toast(`${f.name}: ${err.message}`, "error"); }
    }
    this.el("file").value = "";
    if (done) this.toast(done === 1 ? "Файл загружен" : `Загружено файлов: ${done}`, "ok");
    await this.load(folder);
  }

  // ---------- доступ операторам ----------
  async openShare(path, name) {
    const panel = this.el("panel");
    panel.classList.remove("hidden");
    panel.innerHTML = `<section class="tw-card"><h3>Доступ · ${esc(name)}</h3><p class="muted">Загружаю…</p></section>`;
    let data;
    try { data = await this.api("/api/admin/operators"); }
    catch (err) { panel.innerHTML = `<section class="tw-card"><p class="empty">${esc(err.message)}</p></section>`; return; }
    const ops = data.operators || [];
    const rows = ops.map((op) => {
      const current = (op.files || []).find((g) => g.path === path)?.level || "";
      return `<label class="tw-app-row"><span class="tw-av">${esc(op.name.slice(0, 1).toUpperCase())}</span>
        <span class="tw-app-name">${esc(op.name)}</span>
        <select data-grant="${esc(op.id)}"><option value="">Не открыто</option>
          ${Object.entries(LEVEL).map(([k, l]) => `<option value="${k}" ${current === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
        </select></label>`;
    }).join("");
    panel.innerHTML = `<section class="tw-card"><h3>Доступ · ${esc(name)}</h3>
      ${ops.length ? `<div class="tw-apps">${rows}</div>` : `<p class="empty">Сначала пригласите оператора в «Команде».</p>`}
      <p class="muted small">Папка открывает своё содержимое, включая подпапки. «Загрузка» — оператор сможет
        класть файлы сюда и скачивать ваши. Остальные папки ему не видны.</p>
      <div class="mw-acts"><button class="btn ghost" data-panel-close>Готово</button></div></section>`;
    panel.querySelectorAll("[data-grant]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        try {
          await this.api("/api/exchange/share", { method: "POST",
            body: { op: sel.dataset.grant, path, name, level: sel.value } });
          this.toast(sel.value ? "Доступ обновлён" : "Доступ убран", "ok");
        } catch (err) { this.toast(err.message, "error"); }
      });
    });
  }
}
