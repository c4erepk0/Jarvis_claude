// Калибровка взгляда поверх голограммы: точки по очереди по всему экрану (по ним учится модель), затем
// проверочные — по ним видна точность; в конце владелец сам нажимает «ГОТОВО» взглядом и щипком.
// Быстрая — 9 точек, скан лица и 4 проверочные, ~35 с; большая — 25 точек, скан и 8 проверочных, ~1,5 мин.
// Скан лица: смотрите на точку и водите телефоном — модель учится, что движение телефона ≠ перевод взгляда
// (иначе калибровка верна только в той позе, где её прошли). Обе записывают «сырые» кадры (точки глаз и лица,
// без фото) — запись уходит в хранилище (Jarvis/Gaze/sessions) для анализа: scripts/gaze_eval.mjs.
// Логика точек — Calibration в gaze.js, сам взгляд считает голограмма (hologram.js: trackGaze).
import { Calibration, MAGNET_LEVELS, SCAN_AXES } from "./gaze.js?v=12";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Как назвать точность калибровки. */
export function qualityLabel(errorPx) {
  if (errorPx <= 60) return "хорошая";
  if (errorPx <= 110) return "средняя — курсор будет липнуть к ближайшей кнопке";
  return "грубая — лучше повторить при ровном свете спереди";
}

/** Подпись устройства в записи: модель телефона/ОС и браузер — чтобы сравнивать калибровки на разных устройствах. */
function deviceLabel() {
  const ua = navigator.userAgent || "";
  const os = /iPhone|iPad|Android|Mac OS X|Windows|Linux/.exec(ua)?.[0] || "";
  const br = /CriOS|FxiOS|Edg|Chrome|Safari|Firefox/.exec(ua)?.[0] || "";
  return `${os} ${br} ${screen.width}×${screen.height}@${devicePixelRatio}`.trim();
}

export class GazeCalibration {
  /** holo — Hologram (взгляд уже включён: holo.gaze); onDone(model, errorPx, session) — сохранить модель и запись,
   *  может вернуть Promise с путём записи в хранилище; onMagnet(level) — сменили силу магнита;
   *  onCancel() — закрыли без калибровки. */
  constructor({ root, holo, say = () => {}, onDone = () => {}, onMagnet = () => {}, onCancel = () => {} }) {
    Object.assign(this, { root, holo, say, onDone, onMagnet, onCancel });
    this.el = document.createElement("section");
    this.el.className = "gc hidden";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Калибровка взгляда");
    this.el.innerHTML = `<div class="gc-dot hidden"><i></i></div><div class="gc-status" aria-live="polite"></div>
      <div class="gc-scan hidden">${Object.entries(SCAN_AXES).map(([k, name]) =>
        `<div class="gc-axis" data-axis="${k}"><span>${{ x: "↔", y: "↕", z: "⤢", roll: "⟲" }[k]} ${name}</span><i></i></div>`).join("")}</div>
      <div class="gc-panel panel"></div>`;
    root.append(this.el);
    this.dot = this.el.querySelector(".gc-dot");
    this.scanBox = this.el.querySelector(".gc-scan");
    this.status = this.el.querySelector(".gc-status");
    this.panel = this.el.querySelector(".gc-panel");
    this.el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) this[btn.dataset.act](btn);
    });
    this.tick = this.tick.bind(this);
  }

  get active() { return !this.el.classList.contains("hidden"); }

  open() {
    this.el.classList.remove("hidden");
    this.holo.suppressOpen = true;
    this.intro();
  }

  intro() {
    this.cal = null;
    if (this.holo.gaze) this.holo.gaze.calibration = null;
    this.dot.classList.add("hidden");
    this.scanBox.classList.add("hidden");
    this.status.textContent = "";
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> КАЛИБРОВКА ВЗГЛЯДА</div>
      <p><b>Смотрите на точку, пока она не сожмётся</b> — потом она перепрыгнет.</p>
      <p><b>Скан лица</b>: когда точка станет янтарной, смотрите на неё и <b>медленно водите телефоном</b> — влево-вправо,
        вверх-вниз, ближе-дальше, наклоняйте. Тогда калибровка не собьётся, когда телефон в руке сдвинется.</p>
      <p class="muted">Держите телефон или садитесь к ноутбуку как обычно: лицо целиком в кадре, свет спереди.</p>
      <p class="muted"><b>Большая</b> точнее и записывает данные для анализа и улучшения: точки глаз и лица по кадрам,
        без фото — в хранилище, папка Jarvis/Gaze. Быстрая тоже сохраняется.</p>
      ${this.liveLine()}
      <div class="gc-actions"><button class="btn ghost" data-act="cancel">ОТМЕНА</button>
        <button class="btn ghost" data-act="quick" data-air>БЫСТРАЯ · 35 с</button>
        <button class="btn primary" data-act="big" data-air>БОЛЬШАЯ · 1,5 мин</button></div>`);
    this.say("Калибровка взгляда. Смотрите на точку, пока она не сожмётся.");
  }

  showPanel(html) {
    this.panel.innerHTML = html;
    this.panel.classList.remove("hidden");
  }

  /** Точность в работе — по последним нажатиям щипком (модель на них доучивается). */
  liveLine() {
    const live = this.holo.gaze?.model?.liveErrorPx?.();
    const n = this.holo.gaze?.model?.usage?.length || 0;
    return live === null || live === undefined ? ""
      : `<p class="muted">Точность в работе ≈ ${live} px — по последним нажатиям (${n}); модель на них доучивается.</p>`;
  }

  magnetRow() {
    const cur = this.holo.gaze?.magnet ?? 1;
    return `<div class="gc-magnet"><span class="muted">Магнит:</span>${MAGNET_LEVELS.map((name, lvl) =>
      `<button class="btn ${lvl === cur ? "primary" : "ghost"}" data-act="magnet" data-level="${lvl}" data-air>${name}</button>`).join("")}</div>`;
  }

  magnet(btn) {
    const level = Number(btn.dataset.level);
    this.holo.setGazeMagnet(level);
    this.onMagnet(level);
    this.panel.querySelectorAll('[data-act="magnet"]').forEach((b) => {
      b.classList.toggle("primary", Number(b.dataset.level) === level);
      b.classList.toggle("ghost", Number(b.dataset.level) !== level);
    });
  }

  quick() { this.begin("quick"); }
  big() { this.begin("big"); }

  begin(mode = "quick") {
    if (!this.holo.gaze) { this.cancel(); return; }
    this.panel.classList.add("hidden");
    this.cal = new Calibration({ mode, screen: { w: innerWidth, h: innerHeight }, record: true });
    this.holo.gaze.calibration = this.cal;
    this.dot.classList.remove("hidden");
    this.lastPoint = null;
    this.scanSaid = false;
    this.startedAt = performance.now();
    requestAnimationFrame(this.tick);
  }

  tick(ts) {
    const c = this.cal;
    if (!c || !this.active || this.holo.gaze?.calibration !== c) return;
    if (c.done) { this.finish(); return; }
    const [x, y] = c.point;
    if (this.lastPoint !== c.point) {
      this.lastPoint = c.point;
      this.dot.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px)`;
      this.dot.classList.toggle("check", c.checking);
      this.dot.classList.toggle("scan", c.scanning);
      this.scanBox.classList.toggle("hidden", !c.scanning);
      this.status.classList.toggle("gc-status-scan", c.scanning);
      if (c.scanning && !this.scanSaid) { this.scanSaid = true; this.say("Скан лица. Смотрите на точку и медленно водите телефоном."); }
    }
    this.dot.style.setProperty("--p", String(c.progress));
    const { n, total } = c.counter;
    const lost = c.faceSeenAt === null ? ts - this.startedAt > 2500 : c.faceLost(ts);
    const cov = c.scanning ? c.coverage : null;
    if (cov) for (const el of this.scanBox.querySelectorAll(".gc-axis")) el.style.setProperty("--p", String(cov[el.dataset.axis]));
    const left = cov ? Object.keys(SCAN_AXES).filter((k) => cov[k] < 1).map((k) => SCAN_AXES[k]) : [];
    this.status.innerHTML = lost
      ? '<span class="gt-bad">не вижу лицо — посмотрите в камеру, нужен свет спереди</span>'
      : c.scanning ? `<b>скан лица</b>: смотрите на точку и медленно водите телефоном${left.length ? ` — ещё ${left.join(", ")}` : " — так держать"}`
        : `${c.checking ? "проверка" : "точка"} ${n}/${total}`;
    requestAnimationFrame(this.tick);
  }

  finish() {
    const cal = this.cal;
    const { errorPx } = cal;
    const model = cal.adaptive();
    const session = cal.toSession({ device: deviceLabel() });
    this.holo.gaze.calibration = null;
    this.holo.setGazeModel(model, errorPx);
    const saving = Promise.resolve(this.onDone(model, errorPx, session));
    this.dot.classList.add("hidden");
    this.scanBox.classList.add("hidden");
    this.status.textContent = "";
    const px = Math.round(errorPx);
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> ВЗГЛЯД НАСТРОЕН</div>
      <p><b>Точность ≈ ${px} px</b> — ${esc(qualityLabel(px))}.</p>
      <p class="gc-saved muted">записываю калибровку в хранилище…</p>
      ${this.magnetRow()}
      <p class="gc-how">👁 взгляд — курсор; ближайшая к нему кнопка или заметка подсвечивается — её и нажмёт щипок<br>
        🤏 короткий щипок (свести и развести пальцы) — нажать<br>
        🤏 щипок и движение — вращать граф или листать заметку, на которую смотрите<br>
        📱 телефон можно двигать — скан это учёл; надпись «поза вне скана» на камере — пора пройти калибровку снова<br>
        ✊ ✌ 👍 ✋ 👋 — как раньше: закрыть, править, сохранить, сброс, листать</p>
      <p class="muted">Попробуйте сразу: посмотрите на «ГОТОВО» и щипните. Повторить калибровку — кнопка ◎ вверху.</p>
      <div class="gc-actions"><button class="btn ghost" data-act="intro" data-air>ПОВТОРИТЬ</button>
        <button class="btn primary" data-act="close" data-air>ГОТОВО</button></div>`);
    this.say(px <= 110 ? "Взгляд настроен. Посмотрите на «Готово» и щипните пальцами." : "Калибровка грубая, сэр. Лучше повторить при хорошем свете.");
    saving.then((path) => this.savedLine(path ? `Запись калибровки: ${path}` : ""),
      (err) => this.savedLine(`Запись не сохранилась: ${err?.message || err}`, true));
  }

  savedLine(text, bad = false) {
    const el = this.panel.querySelector(".gc-saved");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("gt-bad", bad);
    el.classList.toggle("hidden", !text);
  }

  cancel() {
    this.close();
    this.onCancel();
  }

  close() {
    if (this.holo.gaze?.calibration === this.cal) this.holo.gaze.calibration = null;
    this.cal = null;
    this.startedAt = null;
    this.holo.suppressOpen = false;
    this.el.classList.add("hidden");
  }
}
