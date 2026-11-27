// Приложение «Диск» — Google Drive внутри Atom: папки, загрузка файлов и выдача доступа операторам.
//
// Один класс на два режима: владелец (mode: "owner") видит весь Диск, создаёт папки, грузит файлы
// и отмечает, кому из операторов что открыто; оператор (mode: "operator") видит только выданные папки
// и грузит в те, где владелец разрешил загрузку.
//
// Анонимность обеспечивает сервер (jarvis/gdrive.py): сюда не приходят ни почта аккаунта, ни владельцы
// файлов, ни пути по Диску — только id, имя, вид, размер и дата. Поэтому в интерфейсе и нет слова «Google».
import { esc } from "./markdown.js?v=30";

const KIND = { doc: "📄", sheet: "📊", slides: "🖼", text: "📝", file: "📎", folder: "📁" };
const LEVEL = { view: "Просмотр", upload: "Загрузка", copy: "Копия" };

export class DriveWindow {
  constructor(root, { api, toast, mode = "owner" }) {
    Object.assign(this, { root, api, toast, mode });
    this.owner = mode === "owner";
    this.base = this.owner ? "/api/drive" : "/api/op/drive";
    this.stack = [];                       // история папок — «назад» без запросов
    this.data = { folder: { id: "", name: "Диск" }, files: [], can_upload: false };
    root.innerHTML = `
      <div class="fw-top">
        <button class="btn ghost" data-act="back" title="Назад" aria-label="Назад">‹</button>
        <div class="fw-title" data-el="title">Диск</div>
        <input class="drive-search" data-el="search" placeholder="Поиск по имени…" autocomplete="off" aria-label="Поиск">
        <button class="btn ghost" data-act="reload" title="Обновить" aria-label="Обновить">↻</button>
        ${this.owner ? `<button class="btn ghost" data-act="mkdir">＋ Папка</button>` : ""}
        <button class="btn primary" data-act="upload">⬆ Загрузить</button>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="drive-body" data-el="body"></div>
      <input type="file" data-el="file" multiple class="hidden"
             accept="image/*,video/*,application/pdf,text/*,application/msword,application/vnd.openxmlformats-officedocument.*">
      <div class="drive-share hidden" data-el="share"></div>`;
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
    this.el("share").classList.add("hidden");
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
    if (this.data.error) { this.el("body").innerHTML = `<p class="empty">${esc(this.data.error)}</p>`; return; }
    this.render();
  }

  canUpload() {
    return this.owner ? Boolean(this.data.can_write) : Boolean(this.data.can_upload);
  }

  render() {
    const { folder, files = [] } = this.data;
    this.el("title").textContent = folder?.name || "Диск";
    this.root.querySelector('[data-act="back"]').disabled = !this.stack.length;
    this.root.querySelector('[data-act="upload"]').disabled = !this.canUpload() || !(folder?.id || this.owner);
    this.root.querySelector('[data-act="mkdir"]')?.toggleAttribute("disabled", !this.owner || !this.data.can_write);
    this.el("body").innerHTML = files.length ? this.grid(files) : this.empty();
    this.el("share").classList.add("hidden");
  }

  grid(files) {
    const folders = files.filter((f) => f.kind === "folder");
    const rest = files.filter((f) => f.kind !== "folder");
    const rows = (list) => `<div class="drive-grid">${list.map((f) => this.card(f)).join("")}</div>`;
    return `${folders.length ? `<h3 class="aw-h">Папки · ${folders.length}</h3>${rows(folders)}` : ""}
      ${rest.length ? `<h3 class="aw-h">Файлы · ${rest.length}</h3>${rows(rest)}` : ""}
      ${this.owner ? `<p class="muted small">Операторы видят только отмеченное: кнопка «Доступ» у папки или файла.
        Чужие данные аккаунта сюда не попадают.</p>` : `<p class="muted small">Только то, что открыл владелец.
        Грузить можно в папки с уровнем «Загрузка».</p>`}`;
  }

  card(f) {
    const isFolder = f.kind === "folder";
    const size = f.size_label || (f.size ? this.human(f.size) : "");
    const thumb = f.mime?.startsWith("image/")
      ? `<img class="drive-thumb" loading="lazy" alt="" src="${this.base}/raw/${encodeURIComponent(f.id)}">` : "";
    const badge = f.level ? `<span class="pill">${esc(LEVEL[f.level] || f.level)}</span>` : "";
    return `<article class="drive-card" data-id="${esc(f.id)}" data-kind="${esc(f.kind || "file")}">
      <button class="drive-open" data-open="${esc(f.id)}" ${isFolder ? "" : `data-file="${esc(f.id)}"`} title="${esc(f.name)}">
        ${thumb || `<span class="drive-ic" aria-hidden="true">${KIND[f.kind] || "📄"}</span>`}
        <b>${esc(f.name)}</b>
        <small class="muted">${esc(size)}${f.modified ? ` · ${esc(String(f.modified).slice(0, 10))}` : ""}</small>
      </button>
      <div class="drive-acts">${badge}
        ${this.owner ? `<button class="h-btn" data-share="${esc(f.id)}" data-name="${esc(f.name)}"
          data-kind="${isFolder ? "folder" : "file"}" title="Кому открыто">Доступ</button>` : ""}
      </div></article>`;
  }

  empty() {
    if (!this.owner && !this.data.folder?.id) return `<p class="empty">Владелец пока не открыл вам папки на Диске.</p>`;
    if (!this.owner) return `<p class="empty">Папка пуста.${this.canUpload() ? " Можно загрузить первый файл." : ""}</p>`;
    return `<p class="empty">${this.data.ready === false ? "Диск не подключён — как подключить, см. docs/drive.md."
      : "Здесь пусто. «＋ Папка» — создать, «⬆ Загрузить» — положить файл."}</p>`;
  }

  human(n) {
    return n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`;
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
      const id = open.dataset.open;
      if (open.dataset.file) return this.openFile(id);
      if (!this.stack.length || this.stack[this.stack.length - 1] !== this.data.folder?.id) {
        this.stack.push(this.data.folder?.id || "");
      }
      return this.load(id);
    }

    const share = t.closest("[data-share]");
    if (share) return this.openShare(share.dataset.share, share.dataset.name, share.dataset.kind);

    if (t.closest("[data-share-close]")) { this.el("share").classList.add("hidden"); return; }
  }

  onChange(e) {
    if (e.target.matches("[data-el=file]")) this.upload([...e.target.files || []]);
  }

  async mkdirForm() {
    this.el("share").classList.remove("hidden");
    this.el("share").innerHTML = `<section class="tw-card"><h3>Новая папка</h3>
      <div class="inline-add"><input data-el="mkdir-name" placeholder="Название папки" autocomplete="off" maxlength="120">
        <button class="btn primary" data-act="mkdir-go">Создать</button>
        <button class="btn ghost" data-share-close>Отмена</button></div></section>`;
    this.el("mkdir-name").focus();
    this.el("share").querySelector('[data-act="mkdir-go"]').onclick = () => this.mkdir();
  }

  async mkdir() {
    const input = this.el("mkdir-name");
    const name = input?.value.trim();
    if (!name) return;
    try {
      await this.api("/api/drive/mkdir", { method: "POST", body: { name, parent: this.data.folder?.id || "" } });
      this.toast("Папка создана", "ok");
      await this.load(this.data.folder?.id || "");
    } catch (err) { this.toast(err.message, "error"); }
  }

  // ---------- загрузка ----------
  async upload(files) {
    if (!files.length) return;
    const folder = this.data.folder?.id || "";
    const url = `${this.base}/upload`;
    let done = 0;
    this.toast(`Загружаю ${files.length}…`, "ok");
    for (const f of files) {
      const form = new FormData();
      form.append("file", f);
      form.append("folder", folder);
      try {
        await this.api(url, { method: "POST", form });
        done += 1;
      } catch (err) { this.toast(`${f.name}: ${err.message}`, "error"); }
    }
    this.el("file").value = "";
    if (done) this.toast(done === 1 ? "Файл загружен" : `Загружено файлов: ${done}`, "ok");
    await this.load(folder);
  }

  // ---------- просмотр файла ----------
  async openFile(id) {
    this.el("share").classList.remove("hidden");
    this.el("share").innerHTML = `<section class="tw-card"><h3>Открываю…</h3></section>`;
    try {
      const file = await this.api(`${this.base}/${encodeURIComponent(id)}`);
      const save = file.can_save
        ? `<div class="mw-acts"><button class="btn ghost" data-save="${esc(id)}">Сохранить копию к себе</button></div>` : "";
      this.el("share").innerHTML = `<section class="tw-card"><h3>${esc(file.name)}</h3>
        <pre class="drive-text">${esc(file.text || "")}</pre>${save}
        <p class="muted small">Источник: Диск ядра.</p>
        <div class="mw-acts"><button class="btn ghost" data-share-close>Закрыть</button></div></section>`;
      this.el("share").querySelector("[data-save]")?.addEventListener("click", async (ev) => {
        try {
          await this.api(`${this.base}/${encodeURIComponent(id)}`, { method: "POST", body: { action: "save" } });
          this.toast("Копия сохранена в вашу папку «Диск»", "ok");
          ev.target.disabled = true;
        } catch (err) { this.toast(err.message, "error"); }
      });
    } catch (err) {
      this.el("share").innerHTML = `<section class="tw-card"><p class="empty">${esc(err.message)}</p>
        <div class="mw-acts"><button class="btn ghost" data-share-close>Закрыть</button></div></section>`;
    }
  }

  // ---------- доступ операторам (только владелец) ----------
  async openShare(id, name, kind) {
    const box = this.el("share");
    box.classList.remove("hidden");
    box.innerHTML = `<section class="tw-card"><h3>Доступ · ${esc(name)}</h3><p class="muted">Загружаю…</p></section>`;
    let data;
    try { data = await this.api("/api/admin/operators"); }
    catch (err) { box.innerHTML = `<section class="tw-card"><p class="empty">${esc(err.message)}</p></section>`; return; }
    const ops = data.operators || [];
    const levels = (data.drive?.levels_by_kind || {})[kind] || (kind === "folder" ? ["view", "upload"] : ["view", "copy"]);
    const rows = ops.map((op) => {
      const current = (op.drive || []).find((g) => g.id === id)?.level || "";
      return `<label class="tw-app-row"><span class="tw-av">${esc(op.name.slice(0, 1).toUpperCase())}</span>
        <span class="tw-app-name">${esc(op.name)}</span>
        <select data-grant="${esc(op.id)}"><option value="">Не открыто</option>
          ${levels.map((k) => `<option value="${k}" ${current === k ? "selected" : ""}>${esc(LEVEL[k])}</option>`).join("")}
        </select></label>`;
    }).join("");
    box.innerHTML = `<section class="tw-card"><h3>Доступ · ${esc(name)}</h3>
      ${ops.length ? `<div class="tw-apps">${rows}</div>` : `<p class="empty">Сначала пригласите оператора в «Команде».</p>`}
      <p class="muted small">${kind === "folder"
        ? "Папка открывает своё содержимое целиком. «Загрузка» — оператор сможет класть в неё файлы."
        : "Файл: «Просмотр» или «Копия» — заметка в личную папку оператора."}
        Остальные папки и данные аккаунта оператор не видит.</p>
      <div class="mw-acts"><button class="btn ghost" data-share-close>Готово</button></div></section>`;
    box.querySelectorAll("[data-grant]").forEach((sel) => {
      sel.addEventListener("change", async () => {
        try {
          await this.api("/api/drive/share", { method: "POST",
            body: { op: sel.dataset.grant, id, name, kind, level: sel.value } });
          this.toast(sel.value ? "Доступ обновлён" : "Доступ убран", "ok");
        } catch (err) { this.toast(err.message, "error"); }
      });
    });
  }
}
