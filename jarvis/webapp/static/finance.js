// Окно «Финансы»: обзор месяца и динамика, категории к среднему, регулярные платежи, активы с котировками, долги.
// Данные — /api/finance, /api/finance/analytics, /api/finance/assets (на iPhone без сервера отвечает core/*.js).
// Операции в одно касание: частые траты и неоплаченные регулярные платежи вносятся кнопкой.
import { donut, esc, money, sparkline, trendBars } from "./fin-charts.js?v=24";
import { countTo } from "./motion.js?v=24";

const TABS = [["overview", "Обзор"], ["categories", "Категории"], ["recurring", "Регулярные"], ["assets", "Активы"], ["debts", "Долги"]];
const KIND_OPTIONS = [["акция", "Акции (Мосбиржа)"], ["фонд", "Фонд / БПИФ"], ["облигация", "Облигация"], ["крипто", "Крипта"],
  ["валюта", "Валюта"], ["деньги", "Деньги, вклад"], ["недвижимость", "Недвижимость"], ["авто", "Авто"],
  ["техника", "Техника"], ["имущество", "Другое имущество"]];
const MARKET_KINDS = new Set(["акция", "фонд", "облигация", "крипто", "валюта"]);
const pctTxt = (p, signed = true) => (p === null || p === undefined ? "—" : `${signed && p > 0 ? "+" : ""}${p}%`);
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

export class FinanceWindow {
  /** root — пустой #fw; api, toast — как в app.js; openNote(path) — заметка в голограмме; today() — ГГГГ-ММ-ДД. */
  constructor(root, { api, toast, openNote, today, store }) {
    Object.assign(this, { root, api, toast, openNote, today, store });
    this.tab = store?.get("fw.tab", "overview") || "overview";
    this.data = { summary: null, analytics: null, assets: null };
    root.innerHTML = `
      <div class="fw-top">
        <div class="fw-title">Финансы <span class="muted" data-el="month"></span></div>
        <div class="seg fw-tabs" data-el="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join("")}</div>
        <button class="btn ghost" data-act="refresh" title="Обновить котировки" aria-label="Обновить">⟳</button>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="fw-body" data-el="body"><p class="empty">Загружаю…</p></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => {
      if (e.target.name === "kind") this.toggleTicker(e.target.form);
    });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show(tab = null) {
    if (tab) this.tab = tab;
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    await this.reload();
  }

  close() {
    this.f3d?.destroy(); this.f3d = null; this.shownTab = null;
    this.root.classList.add("hidden");
    document.body.classList.remove("fw-on");
  }

  async reload({ quotes = this.tab === "assets" || this.tab === "debts" || !this.data.assets } = {}) {
    const [summary, analytics, assets] = await Promise.all([
      this.api("/api/finance").catch(() => null),
      this.api("/api/finance/analytics?months=6").catch((e) => { this.toast(e.message, "error"); return null; }),
      quotes ? this.api("/api/finance/assets").catch(() => null) : Promise.resolve(this.data.assets),
    ]);
    this.data = { summary, analytics, assets };
    this.render();
  }

  render() {
    this.store?.set("fw.tab", this.tab);
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const a = this.data.analytics;
    if (a) {
      const [y, m] = a.month.split("-");
      this.el("month").textContent = new Date(+y, +m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    }
    const body = this.el("body");
    if (!a) { body.innerHTML = `<p class="empty">Финансы недоступны.</p>`; return; }
    // числа KPI докручиваются от прежних значений (на той же вкладке)
    const prev = new Map([...body.querySelectorAll(".fw-kpi")].map((k) => [k.querySelector("span")?.textContent, k.querySelector("b")?.textContent]));
    const sameTab = this.shownTab === this.tab;
    this.shownTab = this.tab;
    this.f3d?.destroy(); this.f3d = null;
    body.innerHTML = this[`render_${this.tab}`]();
    body.classList.remove("swap"); void body.offsetWidth; if (!sameTab) body.classList.add("swap");
    body.querySelectorAll(".fw-kpi").forEach((k) => {
      const b = k.querySelector("b"), was = prev.get(k.querySelector("span")?.textContent);
      if (!b) return;
      const text = b.textContent;
      b.textContent = sameTab && was ? was : text.replace(/\d/g, "0");
      countTo(b, text);
    });
    if (this.tab === "categories") this.mount3D();
    body.querySelectorAll("form.fw-add-asset").forEach((f) => this.toggleTicker(f));
  }

  cur() { return this.data.analytics?.currency || "RUB"; }

  // ---------- обзор ----------
  render_overview() {
    const a = this.data.analytics, s = this.data.summary, r = this.data.assets, c = this.cur();
    const now = a.trend[a.trend.length - 1];
    const kpi = (label, value, extra = "", klass = "") => `<div class="fw-kpi ${klass}"><span>${label}</span><b>${value}</b>${extra ? `<small>${extra}</small>` : ""}</div>`;
    const budget = s && s.budget_total ? `бюджет ${s.budget_percent}%` : "";
    return `
      <div class="fw-kpis">
        ${kpi("Доход", money(now.income, c))}
        ${kpi("Расход", money(now.expense, c), a.average_expense ? `обычно ${money(a.average_expense, c)}` : "")}
        ${kpi("Сбережения", a.savings_rate === null ? "—" : `${a.savings_rate}%`, money(now.net, c, { signed: true }), cls(now.net))}
        ${kpi("Прогноз", money(a.forecast, c), budget)}
        ${r && (r.items.length || r.debts.length) ? kpi("Капитал", money(r.net_worth, c, { short: true }), `долги ${money(r.debt, c, { short: true })}`, cls(r.net_worth)) : ""}
      </div>
      <div class="fw-grid">
        <section class="fw-card wide"><h3>Доходы и расходы <small class="muted">· 6 месяцев</small></h3>
          ${trendBars(a.trend, { currency: c })}
          <div class="fc-legend"><i class="inc"></i>доход <i class="exp"></i>расход <i class="net"></i>сбережения</div></section>
        <section class="fw-card"><h3>Выводы</h3>
          ${a.insights.length ? `<ul class="fw-insights">${a.insights.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
            : `<p class="empty">Внесите несколько операций — появятся выводы.</p>`}</section>
        <section class="fw-card"><h3>Быстро внести</h3>${this.quickAdd()}</section>
        <section class="fw-card"><h3>Крупные траты месяца</h3>
          ${a.top.length ? `<ul class="fw-rows">${a.top.map((e) => `<li><span class="d">${e.date.slice(8)}.${e.date.slice(5, 7)}</span><span>${esc(e.note || e.category)} <small class="muted">${esc(e.category)}</small></span><b>${money(e.amount, c)}</b></li>`).join("")}</ul>`
            : `<p class="empty">Расходов пока нет.</p>`}</section>
      </div>`;
  }

  quickAdd() {
    const a = this.data.analytics, c = this.cur();
    const chips = a.frequent.map((f, i) => `<button class="chip-btn ${f.amount > 0 ? "in" : ""}" data-act="quick" data-i="${i}"
      title="${esc(f.category)} · было ${f.count} раз">${esc(f.note)} <b>${money(f.amount, c, { signed: true })}</b></button>`).join("");
    return `${chips ? `<div class="chip-row">${chips}</div>` : `<p class="muted small">Частые операции появятся здесь.</p>`}
      <form class="inline-add fw-op" data-form="op">
        <input name="amount" inputmode="decimal" placeholder="−450" class="amt" autocomplete="off" aria-label="Сумма">
        <input name="note" placeholder="на что / откуда" autocomplete="off" aria-label="Описание">
        <button class="btn" type="submit" aria-label="Внести">＋</button>
      </form>`;
  }

  // ---------- категории ----------
  render_categories() {
    const a = this.data.analytics, c = this.cur();
    const rows = a.categories.filter((x) => x.spent || x.average);
    if (!rows.length) return `<p class="empty">Расходов пока нет.</p>`;
    const max = Math.max(1, ...rows.map((x) => Math.max(x.spent, x.average)));
    const map = a.matrix && a.matrix.categories.length ? `<section class="fw-card"><h3>3D-карта расходов <small class="muted">· категории × 6 месяцев — вращайте, наведите на столбик</small></h3>
      <div class="f3d" data-f3d></div></section>` : "";
    return `${map}<section class="fw-card"><h3>Категории месяца <small class="muted">· к среднему за 3 месяца</small></h3>
      <ul class="fw-cats">${rows.map((x) => `<li>
        <div class="row"><span>${esc(x.category)}</span><b>${money(x.spent, c)}</b>
          <span class="chg ${x.change === null ? "" : x.change > 15 ? "down" : x.change < -15 ? "up" : ""}">${x.change === null ? "новая" : pctTxt(x.change)}</span></div>
        <div class="bar2"><i style="width:${(x.spent / max) * 100}%"></i>${x.average ? `<s style="left:${(x.average / max) * 100}%" title="среднее ${money(x.average, c)}"></s>` : ""}</div>
        <small class="muted">${x.share}% расходов${x.average ? ` · обычно ${money(x.average, c)}` : ""}</small></li>`).join("")}</ul></section>`;
  }

  async mount3D() {
    const host = this.el("body").querySelector("[data-f3d]");
    const m = this.data.analytics?.matrix;
    if (!host || !m || !m.categories.length) return;
    try {
      const { Finance3D } = await import("./fin3d.js?v=24");
      if (!host.isConnected) return;
      this.f3d = new Finance3D(host, m, { currency: this.cur() });
    } catch {
      host.innerHTML = `<p class="muted small">3D недоступно: нет WebGL или нет связи с CDN three.js.</p>`;
    }
  }

  // ---------- регулярные ----------
  render_recurring() {
    const a = this.data.analytics, c = this.cur();
    if (!a.recurring.length) {
      return `<p class="empty">Регулярные платежи найдутся сами: операция с тем же описанием в двух месяцах (подписки, связь, аренда).</p>`;
    }
    return `<section class="fw-card"><h3>Регулярные платежи ${a.recurring_pending ? `<small class="muted">· ждут оплаты ${money(a.recurring_pending, c)}</small>` : ""}</h3>
      <ul class="fw-rows rec">${a.recurring.map((r, i) => `<li class="${r.paid ? "paid" : ""}">
        <span class="d">${r.paid ? "✓" : `~${r.day}`}</span>
        <span>${esc(r.note)} <small class="muted">${esc(r.category)} · ${r.months} мес.</small></span>
        <b>${money(-r.amount, c)}</b>
        ${r.paid ? `<span class="muted small">оплачено</span>` : `<button class="btn ghost" data-act="pay" data-i="${i}">Внести</button>`}</li>`).join("")}</ul></section>`;
  }

  // ---------- активы ----------
  render_assets() {
    const r = this.data.assets, c = this.cur();
    if (!r) return `<p class="empty">Активы недоступны.</p>`;
    if (!r.exists && !r.debts.length) {
      return `<section class="fw-card fw-empty"><h3>Активы ещё не заведены</h3>
        <p>Я создам заметку <code>${esc(r.path)}</code> с таблицами «Активы» и «Долги». Акции, фонды и облигации
        оцениваются по Мосбирже, крипта — по CoinGecko, валюта — по ЦБ, имущество — по виду актива.</p>
        <button class="btn primary" data-act="init">Создать таблицу</button></section>`;
    }
    const hist = r.history || [];
    const first = hist.length > 1 ? hist[0] : null;
    const delta = first ? r.net_worth - first.net_worth : null;
    return `
      <div class="fw-kpis">
        <div class="fw-kpi"><span>Активы</span><b>${money(r.total, c, { short: true })}</b><small>куплено за ${money(r.cost, c, { short: true })}</small></div>
        <div class="fw-kpi ${cls(r.pnl)}"><span>Переоценка</span><b>${money(r.pnl, c, { signed: true, short: true })}</b><small>${pctTxt(r.pnl_pct)}</small></div>
        <div class="fw-kpi"><span>Долги</span><b>${money(r.debt, c, { short: true })}</b></div>
        <div class="fw-kpi ${cls(r.net_worth)}"><span>Чистый капитал</span><b>${money(r.net_worth, c, { short: true })}</b>
          <small>${delta === null ? "динамика — со следующего дня" : `${money(delta, c, { signed: true, short: true })} с ${first.date.slice(8)}.${first.date.slice(5, 7)}`}</small></div>
      </div>
      <div class="fw-grid">
        <section class="fw-card"><h3>Структура</h3>
          ${r.by_kind.length ? `<div class="fw-donut">${donut(r.by_kind.map((k) => ({ label: `${k.label}: ${money(k.value, c)}`, value: k.value })))}
            <ul class="fw-legend">${r.by_kind.map((k, i) => `<li><i class="s${i % 8}"></i>${esc(k.label)} <b>${k.share}%</b></li>`).join("")}</ul></div>`
            : `<p class="empty">Добавьте первый актив.</p>`}</section>
        <section class="fw-card"><h3>Капитал по дням</h3>
          ${sparkline(hist.map((h) => h.net_worth)) || `<p class="muted small">Atom записывает капитал раз в день в <code>Finance/Capital.md</code> — линия появится со второго дня.</p>`}</section>
        <section class="fw-card wide"><h3>Активы ${r.exists ? `<button class="h-btn" data-act="note" data-path="${esc(r.path)}" title="Открыть заметку">▤</button>` : ""}</h3>
          ${r.items.length ? `<div class="fw-table"><table><thead><tr><th>Актив</th><th>Кол-во</th><th>Цена</th><th>Стоимость</th><th>Рост</th><th>День</th></tr></thead><tbody>
            ${r.items.map((i) => `<tr><td><b>${esc(i.name)}</b><small>${esc(i.kind_label)}${i.ticker ? ` · ${esc(i.ticker)}` : ""} · ${esc(i.source)}</small></td>
              <td>${i.qty.toLocaleString("ru-RU", { maximumFractionDigits: 8 })}</td><td>${money(i.unit, c)}</td><td><b>${money(i.value, c)}</b></td>
              <td class="${cls(i.pnl)}">${pctTxt(i.pnl_pct)}</td><td class="${cls(i.change)}">${pctTxt(i.change)}</td></tr>`).join("")}
            </tbody></table></div>` : `<p class="empty">Пока пусто.</p>`}
          ${this.assetForm()}</section>
      </div>`;
  }

  assetForm() {
    return `<details class="fw-form"><summary>＋ Добавить актив</summary>
      <form class="fw-add-asset" data-form="asset">
        <label>Название<input name="name" required placeholder="Сбербанк, Bitcoin, Квартира" autocomplete="off"></label>
        <label>Вид<select name="kind">${KIND_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <label class="tk">Тикер<input name="ticker" placeholder="SBER, BTC, USD" autocomplete="off"></label>
        <label>Количество<input name="qty" inputmode="decimal" value="1" autocomplete="off"></label>
        <label>Цена покупки за ед., ₽<input name="buy" inputmode="decimal" required autocomplete="off"></label>
        <label>Дата покупки<input name="date" type="date"></label>
        <label class="pr">Своя оценка за ед., ₽<input name="price" inputmode="decimal" placeholder="необязательно" autocomplete="off"></label>
        <div class="fw-form-acts"><button class="btn primary" type="submit">Добавить</button></div>
      </form></details>`;
  }

  toggleTicker(form) {
    if (!form || !form.kind) return;
    const market = MARKET_KINDS.has(form.kind.value);
    form.querySelector(".tk").classList.toggle("hidden", !market);
    form.querySelector(".pr").classList.toggle("hidden", market);
  }

  // ---------- долги ----------
  render_debts() {
    const r = this.data.assets, c = this.cur();
    if (!r) return `<p class="empty">Долги недоступны.</p>`;
    return `<section class="fw-card"><h3>Долги <small class="muted">· всего ${money(r.debt, c)}</small></h3>
      ${r.debts.length ? `<ul class="fw-rows debts">${r.debts.map((d) => `<li>
        <span class="d">${d.due ? esc(d.due.slice(8) + "." + d.due.slice(5, 7)) : "—"}</span>
        <span>${esc(d.name)} ${d.note && d.note !== d.name ? `<small class="muted">${esc(d.note)}</small>` : ""}</span>
        <b>${money(d.amount, c)}</b>
        <button class="h-btn" data-act="note" data-path="${esc(d.source)}" title="${d.source === r.path ? "Таблица долгов" : "Заметка проекта"}">▤</button></li>`).join("")}</ul>`
        : `<p class="empty">Долгов нет — или они ещё не записаны.</p>`}
      <p class="muted small">Долги берутся из таблицы «Долги» в <code>${esc(r.path)}</code> и из проектов с тегом <code>долг</code> — сумма из описания («Отдать 165 000₽»).</p>
      <details class="fw-form"><summary>＋ Записать долг</summary>
        <form data-form="debt" class="fw-add-debt">
          <label>Кому<input name="name" required autocomplete="off"></label>
          <label>Сумма, ₽<input name="amount" inputmode="decimal" required autocomplete="off"></label>
          <label>Срок<input name="due" type="date"></label>
          <label>Заметка<input name="note" autocomplete="off"></label>
          <div class="fw-form-acts"><button class="btn primary" type="submit">Записать</button></div>
        </form></details></section>`;
  }

  // ---------- действия ----------
  async addOp(amount, note, category = "") {
    await this.api("/api/finance", { method: "POST", body: { amount, note, category: category || undefined } });
    this.toast(`Записано: ${money(Math.round(amount * 100), this.cur(), { signed: true })} · ${note || category}`, "ok");
    await this.reload({ quotes: false });
  }

  async onClick(e) {
    const tab = e.target.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; this.render(); if (["assets", "debts"].includes(this.tab) && !this.data.assets) this.reload(); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, a = this.data.analytics;
    try {
      if (act === "close") this.close();
      else if (act === "refresh") await this.reload({ quotes: true });
      else if (act === "quick") { const f = a.frequent[+b.dataset.i]; await this.addOp(f.amount / 100, f.note, f.category); }
      else if (act === "pay") { const r = a.recurring[+b.dataset.i]; await this.addOp(-r.amount / 100, r.note, r.category); }
      else if (act === "init") { await this.api("/api/finance/assets", { method: "POST", body: { action: "init" } }); await this.reload({ quotes: true }); }
      else if (act === "note" && b.dataset.path) { this.close(); this.openNote(b.dataset.path); }
    } catch (err) { this.toast(err.message, "error"); }
  }

  async onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    try {
      if (f.dataset.form === "op") {
        const raw = String(v.amount || "").trim().replace("−", "-");
        const n = parseFloat(raw.replace(",", ".").replace(/\s/g, ""));
        if (!raw || Number.isNaN(n)) { this.toast("Сумма должна быть числом", "warn"); return; }
        const income = raw.startsWith("+");
        await this.addOp(income ? Math.abs(n) : -Math.abs(n), String(v.note || "").trim());
        return;
      }
      if (f.dataset.form === "asset") {
        await this.api("/api/finance/assets", { method: "POST", body: { action: "asset", ...v, price: MARKET_KINDS.has(v.kind) ? "" : v.price } });
        this.toast(`Актив «${v.name}» добавлен`, "ok");
      } else if (f.dataset.form === "debt") {
        await this.api("/api/finance/assets", { method: "POST", body: { action: "debt", ...v } });
        this.toast(`Долг «${v.name}» записан`, "ok");
      }
      await this.reload({ quotes: true });
    } catch (err) { this.toast(err.message, "error"); }
  }
}
