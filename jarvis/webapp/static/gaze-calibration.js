// Калибровка взгляда поверх голограммы. Точка плавно переезжает, ждёт, пока взгляд устоится, и только потом
// сжимается — идёт замер (по нему учится модель). Затем проверочные точки — по ним видна точность; в конце владелец
// сам нажимает «ГОТОВО» взглядом и щипком.
//   быстрая — 9 точек и 4 проверочные, ~25 с; большая — 25 и 8, ~1 мин;
//   привязка — 3 точки, ~6 с, при каждом включении взгляда: убирает сдвиг новой сессии (свет, поза), модель та же.
// Все записывают «сырые» кадры (точки глаз и лица, без фото) в хранилище (Jarvis/Gaze/sessions) — для анализа:
// scripts/gaze_eval.mjs. Логика точек — Calibration в gaze.js, сам взгляд считает голограмма (hologram.js: trackGaze).
import { Calibration, MAGNET_LEVELS } from "./gaze.js?v=13";

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
  /** holo — Hologram (взгляд уже включён: holo.gaze); onDone(model, errorPx, session, mode) — сохранить модель и
   *  запись, может вернуть Promise с путём записи в хранилище; onMagnet(level) — сменили силу магнита;
   *  onCancel() — закрыли, а модели так и нет. */
  constructor({ root, holo, say = () => {}, onDone = () => {}, onMagnet = () => {}, onCancel = () => {} }) {
    Object.assign(this, { root, holo, say, onDone, onMagnet, onCancel });
    this.el = document.createElement("section");
    this.el.className = "gc hidden";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Калибровка взгляда");
    this.el.innerHTML = `<div class="gc-dot hidden"><i></i></div><div class="gc-status" aria-live="polite"></div>
      <div class="gc-panel panel"></div>`;
    root.append(this.el);
    this.dot = this.el.querySelector(".gc-dot");
    this.status = this.el.querySelector(".gc-status");
    this.panel = this.el.querySelector(".gc-panel");
    this.el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) this[btn.dataset.act](btn);
    });
    this.tick = this.tick.bind(this);
  }

  get active() { return !this.el.classList.contains("hidden"); }
  get hasModel() { return Boolean(this.holo.gaze?.model); }

  /** mode: "anchor" — сразу привязка (при включении взгляда, если модель уже есть), иначе — выбор калибровки. */
  open({ mode = null } = {}) {
    this.el.classList.remove("hidden");
    this.holo.suppressOpen = true;
    if (mode === "anchor" && this.hasModel) this.begin("anchor");
    else this.intro();
  }

  intro() {
    this.stop();
    const anchor = this.hasModel ? '<button class="btn ghost" data-act="anchor" data-air>ПРИВЯЗКА · 6 с</button>' : "";
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> КАЛИБРОВКА ВЗГЛЯДА</div>
      <p><b>Смотрите на точку.</b> Она плавно переедет, подождёт, пока взгляд устоится, и сожмётся — это замер.
        Голову и телефон держите как обычно, лицо целиком в кадре, свет спереди.</p>
      <p class="muted"><b>Привязка</b> — 3 точки при каждом включении взгляда: убирает сдвиг, если свет или поза другие.
        <b>Большая</b> калибровка точнее быстрой. Нажатия щипком по цели сразу поправляют курсор.</p>
      <p class="muted">Каждая калибровка записывается для анализа — точки глаз и лица, без фото — в хранилище,
        папка Jarvis/Gaze.</p>
      ${this.liveLine()}
      <div class="gc-actions"><button class="btn ghost" data-act="cancel">ОТМЕНА</button>${anchor}
        <button class="btn ghost" data-act="quick" data-air>БЫСТРАЯ · 25 с</button>
        <button class="btn primary" data-act="big" data-air>БОЛЬШАЯ · 1 мин</button></div>`);
    this.say("Калибровка взгляда. Смотрите на точку, пока она не сожмётся.");
  }

  showPanel(html) {
    this.panel.innerHTML = html;
    this.panel.classList.remove("hidden");
  }

  /** Точность в работе — промах взгляда на последних нажатиях щипком (по ним курсор и поправляется). */
  liveLine() {
    const live = this.holo.gaze?.model?.liveErrorPx?.();
    const n = this.holo.gaze?.model?.usage?.length || 0;
    return live === null || live === undefined ? ""
      : `<p class="muted">Точность в работе ≈ ${live} px — по последним нажатиям (${n}).</p>`;
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
  anchor() { this.begin("anchor"); }

  begin(mode = "quick") {
    if (!this.holo.gaze) { this.cancel(); return; }
    this.panel.classList.add("hidden");
    this.cal = new Calibration({ mode, screen: { w: innerWidth, h: innerHeight }, record: true });
    this.holo.gaze.calibration = this.cal;
    this.dot.classList.remove("hidden", "sampling", "check");
    this.lastPoint = null;
    this.startedAt = performance.now();
    if (mode === "anchor") this.say("Привязка. Посмотрите на три точки.");
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
    }
    this.dot.classList.toggle("sampling", c.sampling);
    this.dot.style.setProperty("--p", String(c.sampling ? (c.progress - 0.3) / 0.7 : 0));
    const { n, total } = c.counter;
    const lost = c.faceSeenAt === null ? ts - this.startedAt > 2500 : c.faceLost(ts);
    const what = c.mode === "anchor" ? "привязка" : c.checking ? "проверка" : "точка";
    this.status.innerHTML = lost
      ? '<span class="gt-bad">не вижу лицо — посмотрите в камеру, нужен свет спереди</span>'
      : `${what} ${n}/${total}${c.sampling ? "" : " · смотрите на точку"}`;
    requestAnimationFrame(this.tick);
  }

  finish() {
    const cal = this.cal;
    const session = cal.toSession({ device: deviceLabel() });
    this.holo.gaze.calibration = null;
    this.dot.classList.add("hidden");
    this.status.textContent = "";
    if (cal.mode === "anchor") { this.finishAnchor(cal, session); return; }
    const { errorPx } = cal;
    const model = cal.adaptive();
    this.holo.setGazeModel(model, errorPx);
    const saving = Promise.resolve(this.onDone(model, errorPx, session, cal.mode));
    const px = Math.round(errorPx);
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> ВЗГЛЯД НАСТРОЕН</div>
      <p><b>Точность ≈ ${px} px</b> — ${esc(qualityLabel(px))}.</p>
      <p class="gc-saved muted">записываю калибровку в хранилище…</p>
      ${this.magnetRow()}
      <p class="gc-how">👁 взгляд — курсор; ближайшая к нему кнопка или заметка подсвечивается — её и нажмёт щипок<br>
        🤏 короткий щипок (свести и развести пальцы) — нажать; после каждого нажатия курсор поправляется сам<br>
        🤏 щипок и движение — вращать граф или листать заметку, на которую смотрите<br>
        📱 при каждом включении взгляда — привязка по 3 точкам; «поза другая» на камере — пройдите её снова (◎)<br>
        ✊ ✌ 👍 ✋ 👋 — как раньше: закрыть, править, сохранить, сброс, листать</p>
      <p class="muted">Попробуйте сразу: посмотрите на «ГОТОВО» и щипните. Повторить калибровку — кнопка ◎ вверху.</p>
      <div class="gc-actions"><button class="btn ghost" data-act="intro" data-air>ПОВТОРИТЬ</button>
        <button class="btn primary" data-act="close" data-air>ГОТОВО</button></div>`);
    this.say(px <= 110 ? "Взгляд настроен. Посмотрите на «Готово» и щипните пальцами." : "Калибровка грубая, сэр. Лучше повторить при хорошем свете.");
    saving.then((path) => this.savedLine(path ? `Запись калибровки: ${path}` : ""),
      (err) => this.savedLine(`Запись не сохранилась: ${err?.message || err}`, true));
  }

  /** Привязка: модель та же, поправляется только сдвиг — и окно закрывается само. */
  finishAnchor(cal, session) {
    const model = this.holo.gaze.model;
    const before = { ...model.bias };
    const bias = model.anchor(cal.anchorSamples, cal.poseRange);
    const shift = Math.round(Math.hypot((bias.x - before.x) * innerWidth, (bias.y - before.y) * innerHeight));
    this.holo.setGazeModel(model, this.holo.gaze.errorPx);
    this.onDone(model, this.holo.gaze.errorPx, session, "anchor");
    this.showPanel(`<div class="panel-h"><span class="idx">◈</span> ПРИВЯЗКА ГОТОВА</div>
      <p>Курсор поправлен на ${shift} px. Нажатия щипком дальше поправляют его сами.</p>
      <div class="gc-actions"><button class="btn primary" data-act="close" data-air>ГОТОВО</button></div>`);
    this.say("Привязка готова.");
    this.cal = null;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => { if (this.active && !this.cal) this.close(); }, 2500);
  }

  savedLine(text, bad = false) {
    const el = this.panel.querySelector(".gc-saved");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("gt-bad", bad);
    el.classList.toggle("hidden", !text);
  }

  stop() {
    if (this.holo.gaze?.calibration === this.cal) this.holo.gaze.calibration = null;
    this.cal = null;
    this.dot.classList.add("hidden");
    this.status.textContent = "";
  }

  cancel() {
    this.close();
    this.onCancel();
  }

  close() {
    clearTimeout(this.closeTimer);
    this.stop();
    this.startedAt = null;
    this.holo.suppressOpen = false;
    this.el.classList.add("hidden");
  }
}
