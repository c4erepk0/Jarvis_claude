// Выбор модели-мозга на главном экране: кнопка под строкой команды показывает, какая модель ответит,
// по нажатию — список моделей тех провайдеров, у которых задан ключ (GET /api/brain), выбор — POST /api/brain.
// Логика без DOM (groupOptions, buttonView) проверяется в tests/js/brain-picker.test.mjs.
import { esc } from "./markdown.js?v=30";

/** Модели по провайдерам в порядке списка: [{backend, provider, error, items}]. */
export function groupOptions(options = []) {
  const groups = [];
  for (const o of options) {
    let g = groups.find((x) => x.backend === o.backend);
    if (!g) groups.push(g = { backend: o.backend, provider: o.provider, error: o.error || "", items: [] });
    g.items.push(o);
  }
  return groups;
}

/** Что написать на кнопке по состоянию дашборда (/api/state). */
export function buttonView(st) {
  if (!st || !st.llm) {
    return { provider: "", label: "Только команды", cls: "warn",
      title: "Модель не подключена — задайте ключ в «Настройки» → «Мозг»" };
  }
  const provider = st.brain || "Claude";
  const label = st.model_label || st.model || "";
  return { provider, label, cls: "on", title: `Отвечает ${provider} · ${st.model || label}. Нажмите, чтобы выбрать другую модель` };
}

export class BrainPicker {
  /** api(path, opts) — как в app.js; onChange(info) — после выбора; onSettings() — открыть «Настройки». */
  constructor(button, { api, toast, onChange, onSettings }) {
    this.btn = button;
    this.api = api;
    this.toast = toast;
    this.onChange = onChange;
    this.onSettings = onSettings;
    this.menu = null;
    button.addEventListener("click", (e) => { e.stopPropagation(); this.menu ? this.close() : this.open(); });
    document.addEventListener("click", (e) => { if (this.menu && !this.menu.contains(e.target)) this.close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    window.addEventListener("resize", () => this.close());
  }

  render(st) {
    const v = buttonView(st);
    this.btn.className = `brain-pick ${v.cls}`;
    this.btn.title = v.title;
    this.btn.setAttribute("aria-label", `Модель: ${v.provider} ${v.label}`.trim());
    this.btn.innerHTML = `<i class="bp-dot" aria-hidden="true"></i>${v.provider ? `<span class="bp-prov">${esc(v.provider)}</span>` : ""}`
      + `<b>${esc(v.label)}</b><span class="bp-caret" aria-hidden="true">▾</span>`;
  }

  async open() {
    let info;
    try { info = await this.api("/api/brain"); } catch (e) { this.toast(e.message, "error"); return; }
    const menu = document.createElement("div");
    menu.className = "bp-menu";
    menu.setAttribute("role", "menu");
    const groups = groupOptions(info.options);
    menu.innerHTML = `<div class="bp-h">Какая модель отвечает</div>`
      + (groups.length ? groups.map((g) => `<div class="bp-group"><div class="bp-gh">${esc(g.provider)}`
        + `${g.error ? ` <em class="bp-err">${esc(g.error)}</em>` : ""}</div>`
        + g.items.map((o) => `<button type="button" role="menuitemradio" aria-checked="${o.active}" class="bp-item${o.active ? " on" : ""}"`
          + ` data-backend="${esc(o.backend)}" data-model="${esc(o.model)}"><span class="bp-name">${esc(o.label)}</span>`
          + `<small>${esc(o.note)}${o.label !== o.model ? ` · ${esc(o.model)}` : ""}</small>`
          + `<span class="bp-check" aria-hidden="true">${o.active ? "✓" : ""}</span></button>`).join("") + "</div>").join("")
        : `<p class="bp-empty">Нет подключённых моделей — Atom понимает только команды.</p>`)
      + `<button type="button" class="bp-foot" data-act="settings">Ключи и другие модели — в «Настройках»</button>`;
    menu.addEventListener("click", async (e) => {
      const item = e.target.closest(".bp-item");
      if (e.target.closest("[data-act=settings]")) { this.close(); this.onSettings?.(); return; }
      if (!item || item.classList.contains("on")) { if (item) this.close(); return; }
      menu.querySelectorAll(".bp-item").forEach((b) => { b.disabled = true; });
      try {
        const res = await this.api("/api/brain", { method: "POST", body: { backend: item.dataset.backend, model: item.dataset.model } });
        this.close();
        this.toast(`Теперь отвечает ${res.provider} · ${res.label}. Разговор начат заново.`, "ok");
        this.onChange?.(res);
      } catch (err) {
        this.toast(err.message, "error");
        menu.querySelectorAll(".bp-item").forEach((b) => { b.disabled = false; });
      }
    });
    document.body.append(menu);
    this.menu = menu;
    this.place();
    menu.querySelector(".bp-item.on, .bp-item, .bp-foot")?.focus({ preventScroll: true });
  }

  place() {
    const r = this.btn.getBoundingClientRect();
    const m = this.menu;
    const w = Math.min(320, window.innerWidth - 32);
    m.style.width = `${w}px`;
    m.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - w - 16))}px`;
    const below = window.innerHeight - r.bottom;
    if (below > m.offsetHeight + 12 || below > r.top) { m.style.top = `${r.bottom + 6}px`; m.style.bottom = ""; }
    else { m.style.bottom = `${window.innerHeight - r.top + 6}px`; m.style.top = ""; }
    m.style.maxHeight = `${Math.max(200, (m.style.top ? below : r.top) - 24)}px`;
  }

  close() {
    this.menu?.remove();
    this.menu = null;
  }
}
