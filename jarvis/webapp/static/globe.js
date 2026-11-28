// Приложение «Глобус» — анализатор новостей и тактический инвестор в прямом эфире.
// Земля из частиц (Canvas 2D: работает на любом устройстве, без WebGL и CDN), маркеры новостей появляются по мере
// прихода (событие WebSocket «news»): конфликты, катастрофы и землетрясения, экономика, а экономические маркеры —
// новости с явным прогнозом, который влияет на рынок; от них дуги тянутся к рынкам (нефть — Лондон, ставки —
// Вашингтон…). Справа — лента, тактика (давление на рынки, ваши позиции, идеи) и котировки-ориентиры.
// Данные — /api/news (jarvis/news.py), разбор — /api/news/brief (мозг Atom). Геометрия без DOM — globe-geo.js.
import { esc, renderMarkdown } from "./markdown.js?v=33";
import { reduced } from "./motion.js?v=33";
import { FILTERS, MARKER_COLORS, ago, arc, arrow, centerOn, matches, mergeItems, pick, pressureClass, project,
  shortestTurn, spherePoints, toVec, rotate } from "./globe-geo.js?v=33";

const POINTS = 16000;
const TABS = [["feed", "Лента"], ["tactics", "Тактика"], ["markets", "Рынки"]];
const rub = (k) => (k === null || k === undefined ? "—" : (k / 100).toLocaleString("ru-RU", { maximumFractionDigits: k >= 1e6 ? 0 : 2 }));
const pct = (v) => (v === null || v === undefined ? "" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

export class GlobeWindow {
  constructor(root, { api, toast, store, speak = null }) {
    Object.assign(this, { root, api, toast, store, speak });
    this.tab = store.get("globe.tab", "feed");
    this.filter = store.get("globe.filter", "all");
    this.items = [];
    this.data = null;
    this.sel = null;
    this.brief = null;
    this.view = { yaw: 40, tilt: 25, zoom: 1, cx: 0, cy: 0, r: 100 };
    this.target = null;               // плавный перелёт к маркеру
    this.idleSince = 0;
    this.fresh = new Map();           // id → когда появился (для пульса)
    root.innerHTML = `
      <div class="fw-top gw-top">
        <div class="fw-title">Глобус <span class="gw-live" data-el="live"><i></i>в эфире</span></div>
        <div class="seg gw-filters" data-el="filters">${FILTERS.map(([k, l]) => `<button data-filter="${k}">${l}</button>`).join("")}</div>
        <button class="btn ghost" data-act="brief-all" title="Тактическая сводка от мозга Atom (с поиском в интернете)">🧠<span class="lbl"> Сводка</span></button>
        <button class="btn ghost" data-act="refresh" title="Опросить ленты сейчас" aria-label="Обновить">⟳</button>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="gw-body">
        <div class="gw-stage" data-el="stage">
          <canvas data-el="canvas" aria-label="Глобус с маркерами новостей"></canvas>
          <div class="gw-tip hidden" data-el="tip"></div>
          <div class="gw-legend">${[["economic", "прогноз по рынку"], ["conflict", "конфликт"], ["disaster", "катастрофа"],
            ["economy", "экономика"], ["politics", "политика"], ["tech", "технологии"]]
            .map(([k, l]) => `<span><i style="background:${MARKER_COLORS[k]}"></i>${l}</span>`).join("")}</div>
          <div class="gw-ticker" data-el="ticker"></div>
        </div>
        <aside class="gw-panel">
          <div class="seg gw-tabs" data-el="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join("")}</div>
          <div class="gw-side" data-el="side"><p class="empty">Загружаю новости…</p></div>
        </aside>
      </div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    this.canvas = this.el("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.points = spherePoints(POINTS).filter((p, i) => p.land || i % 6 === 0).map((p) => ({ ...p, v: toVec(p.lat, p.lon) }));
    root.addEventListener("click", (e) => this.onClick(e));
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(this.el("stage"));
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show() {
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    this.resize();
    this.renderTabs();
    this.loop();
    await this.reload();
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.root.classList.add("hidden");
    document.body.classList.remove("fw-on");
  }

  escape() { if (this.sel) { this.sel = null; this.brief = null; this.renderSide(); } else this.close(); }

  async reload({ refresh = false } = {}) {
    try {
      this.data = refresh ? await this.api("/api/news/refresh", { method: "POST", body: {} }) : await this.api("/api/news");
    } catch (e) { this.toast(e.message, "error"); return; }
    this.items = mergeItems([], this.data.items || []);
    if (refresh) this.toast(this.data.new ? `Новых событий: ${this.data.new}` : "Нового пока нет", this.data.new ? "ok" : "info");
    this.renderSide();
    this.renderTicker();
  }

  /** Событие с сервера: новые новости и пересчитанная тактика — маркеры появляются сразу. */
  onNews(d) {
    if (!d) return;
    const now = performance.now();
    for (const it of d.items || []) this.fresh.set(it.id, now);
    this.items = mergeItems(this.items, d.items || []);
    if (this.data) { this.data.tactics = d.tactics || this.data.tactics; this.data.updated = d.updated; }
    if (!this.isOpen) return;
    const econ = (d.items || []).filter((i) => i.economic);
    if (econ.length) this.toast(`Прогноз: ${econ[0].title.slice(0, 120)}`, "warn");
    this.renderSide();
    this.renderTicker();
  }

  // ---------- холст ----------
  resize() {
    const box = this.el("stage").getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (!box.width) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.canvas.style.width = `${box.width}px`;
    this.canvas.style.height = `${box.height}px`;
    this.view.cx = (box.width * dpr) / 2;
    this.view.cy = (box.height * dpr) / 2 - 14 * dpr;
    this.baseR = Math.min(box.width, box.height - 40) * dpr * 0.42;
  }

  visible() {
    const now = Date.now() / 1000;
    return this.items.filter((i) => i.place && now - i.ts < 48 * 3600 && matches(i, this.filter)).slice(0, 260);
  }

  loop() {
    if (this.raf) return;
    let last = performance.now();
    const frame = (t) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.step(dt);
      this.draw(t);
    };
    this.raf = requestAnimationFrame(frame);
  }

  step(dt) {
    const v = this.view;
    if (this.target) {                                   // плавный перелёт к выбранному маркеру
      const dy = shortestTurn(v.yaw, this.target.yaw), dtl = this.target.tilt - v.tilt;
      const k = Math.min(1, dt * 4);
      v.yaw += dy * k; v.tilt += dtl * k;
      if (Math.abs(dy) < 0.05 && Math.abs(dtl) < 0.05) this.target = null;
    } else if (!this.dragging && !this.sel && !reduced() && performance.now() - this.idleSince > 4000) {
      v.yaw = (v.yaw + dt * 3) % 360;                    // медленное вращение, пока никто не трогает
    }
    v.r = (this.baseR || 100) * v.zoom;
  }

  draw(t) {
    const { ctx, view: v } = this, W = this.canvas.width, H = this.canvas.height, d = this.dpr || 1;
    ctx.clearRect(0, 0, W, H);
    // атмосфера
    const halo = ctx.createRadialGradient(v.cx, v.cy, v.r * 0.85, v.cx, v.cy, v.r * 1.35);
    halo.addColorStop(0, "rgba(255,69,58,0.16)"); halo.addColorStop(1, "rgba(255,69,58,0)");
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
    const body = ctx.createRadialGradient(v.cx - v.r * 0.35, v.cy - v.r * 0.4, v.r * 0.1, v.cx, v.cy, v.r);
    body.addColorStop(0, "rgba(60,30,30,0.55)"); body.addColorStop(1, "rgba(18,12,13,0.92)");
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(v.cx, v.cy, v.r, 0, Math.PI * 2); ctx.fill();
    // частицы суши и редкие — океана
    const yaw = v.yaw, tilt = v.tilt;
    for (const p of this.points) {
      const [x, y, z] = rotate(p.v, yaw, tilt);
      if (z <= 0) continue;
      const sx = v.cx + x * v.r, sy = v.cy - y * v.r;
      if (p.land) {
        const a = 0.25 + 0.75 * z, s = (0.9 + 1.1 * z) * d;
        ctx.fillStyle = `rgba(255,${Math.round(150 + 80 * z)},${Math.round(140 + 70 * z)},${a})`;
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      } else {
        ctx.fillStyle = `rgba(255,120,110,${0.1 * z})`;
        ctx.fillRect(sx - 0.6 * d, sy - 0.6 * d, 1.2 * d, 1.2 * d);
      }
    }
    ctx.strokeStyle = "rgba(255,120,110,0.25)"; ctx.lineWidth = 1 * d;
    ctx.beginPath(); ctx.arc(v.cx, v.cy, v.r, 0, Math.PI * 2); ctx.stroke();
    const markets = this.data?.markets || {};
    const press = Object.fromEntries((this.data?.tactics?.markets || []).map((m) => [m.market, m.pressure]));
    // дуги: выбранный маркер — ко всем его рынкам; свежие прогнозы — тонко
    const list = this.visible();
    const arcsFor = this.sel ? [this.sel] : list.filter((i) => i.economic).slice(0, 8);
    for (const it of arcsFor) {
      for (const m of it.markets || []) {
        const hub = markets[m.market]?.hub;
        if (!hub) continue;
        this.drawArc(arc([it.place.lat, it.place.lon], hub, 40), m.dir > 0 ? "#4cd990" : "#ff6fa8", this.sel ? 1 : 0.35, t);
      }
    }
    // рынки: ромбы на биржах; подписи — у рынков выбранной новости (иначе в Европе всё слипается)
    const named = new Set((this.sel?.markets || []).map((m) => m.market));
    ctx.font = `${600} ${11 * d}px Manrope, system-ui, sans-serif`;
    for (const [k, m] of Object.entries(markets)) {
      const p = project(m.hub[0], m.hub[1], v, 0.01);
      if (p.z <= 0.05) continue;
      const pr = press[k] || 0, c = pr >= 0.2 ? "#4cd990" : pr <= -0.2 ? "#ff6fa8" : "#d8cfcc";
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = c; ctx.globalAlpha = 0.35 + 0.6 * p.z; ctx.fillRect(-3.5 * d, -3.5 * d, 7 * d, 7 * d); ctx.restore();
      if (named.has(k)) {
        ctx.globalAlpha = 0.6 + 0.4 * p.z; ctx.fillStyle = c;
        ctx.fillText(`${m.name} ${Math.abs(pr) >= 0.2 ? arrow(pr) : ""}`, p.x + 8 * d, p.y + 4 * d);
      }
      ctx.globalAlpha = 1;
    }
    // маркеры новостей: «шип» над точкой, пульс у свежих и выбранного
    const now = performance.now();
    for (const it of list) {
      const sev = it.severity || 0.3, base = project(it.place.lat, it.place.lon, v), top = project(it.place.lat, it.place.lon, v, 0.03 + 0.13 * sev);
      if (base.z <= 0.02) continue;
      const c = MARKER_COLORS[it.marker] || MARKER_COLORS.other, sel = this.sel?.id === it.id;
      ctx.globalAlpha = 0.35 + 0.65 * base.z;
      ctx.strokeStyle = c; ctx.lineWidth = (sel ? 2 : 1.2) * d;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.fillStyle = c;
      const rad = (2 + 3 * sev) * d * (sel ? 1.4 : 1);
      if (it.economic) {
        ctx.save(); ctx.translate(top.x, top.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-rad, -rad, rad * 2, rad * 2); ctx.restore();
      } else { ctx.beginPath(); ctx.arc(top.x, top.y, rad, 0, Math.PI * 2); ctx.fill(); }
      const born = this.fresh.get(it.id);
      if ((sel || (born && now - born < 120000)) && !reduced()) {
        const ph = ((t / 1600) + (it.id.charCodeAt(0) % 10) / 10) % 1;
        ctx.globalAlpha = (1 - ph) * 0.8 * base.z; ctx.lineWidth = 1.5 * d;
        ctx.beginPath(); ctx.arc(top.x, top.y, rad + ph * 22 * d, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawArc(pts, color, alpha, t) {
    const { ctx, view: v } = this, d = this.dpr || 1;
    ctx.strokeStyle = color; ctx.lineWidth = 1.4 * d;
    ctx.setLineDash([6 * d, 6 * d]); ctx.lineDashOffset = reduced() ? 0 : -(t / 40) % 12;
    ctx.beginPath();
    let on = false;
    for (const q of pts) {
      const p = project(q.lat, q.lon, v, q.alt);
      const front = rotate(toVec(q.lat, q.lon), v.yaw, v.tilt)[2] > -0.15 || q.alt > 0.08;
      ctx.globalAlpha = alpha;
      if (!front) { on = false; continue; }
      if (on) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      on = true;
    }
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  bindPointer() {
    const c = this.canvas, pts = new Map();
    let start = null, pinch = null;
    const xy = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (this.dpr || 1), (e.clientY - r.top) * (this.dpr || 1)]; };
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      start = { x: e.clientX, y: e.clientY, yaw: this.view.yaw, tilt: this.view.tilt, moved: false };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.view.zoom }; }
      this.dragging = true; this.target = null; this.idleSince = performance.now();
    });
    c.addEventListener("pointermove", (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.view.zoom = Math.max(0.6, Math.min(3.5, pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d));
        return;
      }
      if (start && pts.size === 1) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 4) start.moved = true;
        const k = 0.35 / this.view.zoom;
        this.view.yaw = start.yaw - dx * k;
        this.view.tilt = Math.max(-80, Math.min(80, start.tilt + dy * k));
        return;
      }
      if (e.pointerType === "mouse") this.hover(xy(e), e);
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) {
        this.dragging = false; this.idleSince = performance.now();
        if (start && !start.moved && e.type === "pointerup") {
          const hit = pick(this.visible(), this.view, ...xy(e), 20 * (this.dpr || 1));
          if (hit) this.select(hit); else if (this.sel) { this.sel = null; this.brief = null; this.renderSide(); }
        }
        start = null;
      }
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", () => this.el("tip").classList.add("hidden"));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.view.zoom = Math.max(0.6, Math.min(3.5, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
      this.idleSince = performance.now();
    }, { passive: false });
  }

  hover([x, y], e) {
    const hit = pick(this.visible(), this.view, x, y, 16 * (this.dpr || 1)), tip = this.el("tip");
    this.canvas.style.cursor = hit ? "pointer" : "grab";
    if (!hit) { tip.classList.add("hidden"); return; }
    const r = this.el("stage").getBoundingClientRect();
    tip.innerHTML = `<b>${esc(hit.kind_label)}${hit.place ? ` · ${esc(hit.place.name)}` : ""}</b>${esc(hit.title)}`;
    tip.style.left = `${Math.min(r.width - 260, e.clientX - r.left + 14)}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.classList.remove("hidden");
  }

  select(it) {
    this.sel = it;
    this.brief = null;
    if (it.place) this.target = centerOn(it.place.lat, it.place.lon);
    this.tab = "feed";
    this.renderTabs();
    this.renderSide();
    this.el("side").scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- панель ----------
  renderTabs() {
    this.store.set("globe.tab", this.tab); this.store.set("globe.filter", this.filter);
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    this.root.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === this.filter));
  }

  renderSide() {
    const live = this.el("live");
    live.lastChild.textContent = this.data?.updated ? `в эфире · ${ago(this.data.updated)}` : this.data?.enabled === false ? "новости выключены" : "в эфире";
    live.classList.toggle("off", this.data?.enabled === false);
    this.el("side").innerHTML = this.tab === "tactics" ? this.tacticsHtml() : this.tab === "markets" ? this.marketsHtml() : this.feedHtml();
  }

  chips(markets) {
    return (markets || []).map((m) => `<span class="gw-mk ${m.dir > 0 ? "up" : "down"}" title="${esc(m.reason)}">${esc(m.name)} ${arrow(m.dir)}<small>${Math.round(m.conf * 100)}%</small></span>`).join("");
  }

  card(it) {
    return `<article class="gw-card" style="--c:${MARKER_COLORS[it.marker] || MARKER_COLORS.other}">
      <div class="gw-card-h"><span class="gw-kind">${esc(it.economic ? "Прогноз · " + it.kind_label : it.kind_label)}</span>
        <span class="muted">${it.place ? esc(it.place.name) + " · " : ""}${esc(ago(it.ts))}</span>
        <button class="h-btn" data-act="unselect" aria-label="Закрыть">✕</button></div>
      <h3>${esc(it.title)}</h3>
      ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
      ${it.forecast ? `<p class="gw-fc">Явный прогноз: «${esc(it.forecast)}»</p>` : ""}
      ${(it.markets || []).length ? `<div class="gw-impact"><b>Влияние на рынки</b>${it.markets.map((m) => `<div class="gw-imp-row">
          <span class="gw-mk ${m.dir > 0 ? "up" : "down"}">${esc(m.name)} ${arrow(m.dir)}</span>
          <span class="gw-conf"><i style="width:${Math.round(m.conf * 100)}%"></i></span><small>${Math.round(m.conf * 100)}%</small>
          <p class="muted">${esc(m.reason)}</p></div>`).join("")}</div>` : `<p class="muted small">Прямого влияния на рынки правила не нашли.</p>`}
      <div class="gw-acts">${this.data?.brain ? `<button class="btn primary" data-brief="${esc(it.id)}">🧠 Разбор</button>` : ""}
        ${it.link ? `<a class="btn ghost" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">Источник · ${esc(it.source)} ↗</a>` : `<span class="muted small">${esc(it.source || "")}</span>`}</div>
      ${this.brief ? `<div class="gw-brief md">${this.brief === "…" ? `<p class="muted">Думаю — смотрю подробности…</p>` : renderMarkdown(this.brief).html}</div>` : ""}
    </article>`;
  }

  feedHtml() {
    const list = this.items.filter((i) => matches(i, this.filter)).slice(0, 120);
    const unplaced = list.filter((i) => !i.place).length;
    return `${this.sel ? this.card(this.sel) : ""}
      ${!this.sel && this.brief ? `<article class="gw-card"><div class="gw-card-h"><span class="gw-kind">Тактическая сводка</span><button class="h-btn" data-act="unbrief" aria-label="Закрыть">✕</button></div>
        <div class="gw-brief md">${this.brief === "…" ? `<p class="muted">Собираю картину дня…</p>` : renderMarkdown(this.brief).html}</div></article>` : ""}
      <ul class="gw-feed">${list.map((i) => `<li class="${this.sel?.id === i.id ? "on" : ""}" data-item="${esc(i.id)}">
        <i style="background:${MARKER_COLORS[i.marker] || MARKER_COLORS.other}" class="${i.economic ? "dia" : ""}"></i>
        <div><small>${esc(i.economic ? "Прогноз · " + i.kind_label : i.kind_label)}${i.place ? ` · ${esc(i.place.name)}` : " · без места"} · ${esc(ago(i.ts))}</small>
          <b>${esc(i.title)}</b>${(i.markets || []).length ? `<div class="gw-mks">${this.chips(i.markets)}</div>` : ""}</div></li>`).join("")
        || `<li class="empty">${this.data ? "Новостей под этот фильтр пока нет." : "Загружаю…"}</li>`}</ul>
      ${unplaced ? `<p class="muted small">Без места на карте: ${unplaced} — они только в ленте.</p>` : ""}`;
  }

  tacticsHtml() {
    const t = this.data?.tactics;
    if (!t) return `<p class="empty">Нет данных.</p>`;
    const bar = (p) => `<span class="gw-press ${pressureClass(p)}"><i style="${p >= 0 ? "left:50%" : `left:${50 + p * 50}%`};width:${Math.abs(p) * 50}%"></i></span>`;
    return `<p class="gw-disc">${esc(t.disclaimer)}</p>
      <section><h4>Идеи</h4>${t.ideas.length ? t.ideas.map((i) => `<div class="gw-idea ${pressureClass(i.pressure)}">
        <div><b>${esc(i.name)} ${arrow(i.pressure)}</b><span>${esc(i.label)}</span><small title="сила сигнала">сила ${Math.round(i.confidence * 100)}%</small></div>
        <p><b>${esc(i.action)}</b>${i.yours.length ? ` · у вас: ${esc(i.yours.join(", "))}` : ""}</p>
        <p class="muted">Почему: ${esc(i.why)}</p></div>`).join("") : `<p class="muted">Сильных сигналов нет — можно ничего не делать.</p>`}</section>
      <section><h4>Ваши позиции</h4>${t.positions.length ? `<ul class="gw-pos">${t.positions.map((p) => `<li class="${pressureClass(p.score)}">
        <b>${esc(p.ticker || p.name)}</b><span>${esc(p.stance)}</span>${bar(p.score)}<small class="muted">${esc(p.markets.join(", "))}</small></li>`).join("")}</ul>`
        : `<p class="muted">Добавьте активы в «Финансы → Активы» — Atom покажет, какие позиции под ветром новостей.</p>`}</section>
      <section><h4>Давление на рынки · 48 ч</h4><ul class="gw-press-list">${t.markets.map((m) => `<li data-market="${esc(m.market)}">
        <span>${esc(m.name)}</span>${bar(m.pressure)}<small>${m.signals ? `${m.signals} сигн.` : "—"}</small></li>`).join("")}</ul></section>`;
  }

  marketsHtml() {
    const q = this.data?.quotes || {}, srcs = this.data?.sources || [];
    const rows = Object.entries(q).map(([k, v]) => `<li><span>${esc(this.data.markets[k]?.name || k)}<small class="muted"> · ${esc(v.label)}</small></span>
      <b>${rub(v.price)} ₽</b><em class="${v.change > 0 ? "up" : v.change < 0 ? "down" : ""}">${esc(pct(v.change))}</em></li>`).join("");
    return `<section><h4>Ориентиры</h4><ul class="gw-quotes">${rows || `<li class="empty">Котировки недоступны (нужен интернет: Мосбиржа, CoinGecko, ЦБ).</li>`}</ul></section>
      <section><h4>Источники</h4><ul class="gw-src">${srcs.map((s) => `<li class="${s.ok === false ? "bad" : s.ok ? "ok" : ""}"><i></i>
        <span>${esc(s.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</span><small class="muted">${s.ok === false ? esc(s.error || "ошибка") : s.ok ? `${s.count} шт · ${s.ms} мс` : "ещё не опрашивали"}</small></li>`).join("")}</ul>
      <p class="muted small">Свои ленты — «Настройки и диагностика → Ключи и токены → NEWS_FEEDS». Опрос — раз в ${esc(String(this.data?.interval || 10))} мин.</p></section>`;
  }

  renderTicker() {
    const t = this.data?.tactics?.markets || [], q = this.data?.quotes || {};
    this.el("ticker").innerHTML = t.filter((m) => q[m.market] || Math.abs(m.pressure) >= 0.2).map((m) => {
      const v = q[m.market];
      return `<span class="${pressureClass(m.pressure)}"><b>${esc(m.name)}</b>${v ? ` ${rub(v.price)} <em>${esc(pct(v.change))}</em>` : ""}${Math.abs(m.pressure) >= 0.2 ? ` ${arrow(m.pressure)}` : ""}</span>`;
    }).join("");
  }

  async runBrief(id = null) {
    this.brief = "…";
    if (!id) this.sel = null;
    this.tab = "feed"; this.renderTabs(); this.renderSide();
    try {
      const r = await this.api("/api/news/brief", { method: "POST", body: id ? { id } : {} });
      this.brief = r.text || "Пустой ответ.";
    } catch (e) { this.brief = null; this.toast(e.message, "error"); }
    this.renderSide();
  }

  async onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; this.renderTabs(); this.renderSide(); return; }
    const f = t.closest("[data-filter]");
    if (f) { this.filter = f.dataset.filter; this.renderTabs(); this.renderSide(); return; }
    const li = t.closest("[data-item]");
    if (li && !t.closest("a")) { const it = this.items.find((x) => x.id === li.dataset.item); if (it) this.select(it); return; }
    const b = t.closest("[data-brief]");
    if (b) { this.runBrief(b.dataset.brief); return; }
    const mk = t.closest("[data-market]");
    if (mk) {
      const hub = this.data?.markets?.[mk.dataset.market]?.hub;
      if (hub) this.target = centerOn(hub[0], hub[1]);
      return;
    }
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "close") this.close();
    else if (act === "refresh") { const btn = t.closest("button"); btn.disabled = true; await this.reload({ refresh: true }); btn.disabled = false; }
    else if (act === "brief-all") {
      if (!this.data?.brain) { this.toast("Для сводки нужен мозг: ключ Claude, GigaChat или YandexGPT в «Настройках»", "warn"); return; }
      this.runBrief();
    } else if (act === "unselect") { this.sel = null; this.brief = null; this.renderSide(); }
    else if (act === "unbrief") { this.brief = null; this.renderSide(); }
  }
}
