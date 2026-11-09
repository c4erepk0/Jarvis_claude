// Калибровка взгляда поверх голограммы: точки по очереди по всему экрану (по ним учится модель), затем
// проверочные — по ним видна точность; в конце владелец сам нажимает «ГОТОВО» взглядом и щипком.
// Логика точек — Calibration в gaze.js, сам взгляд считает голограмма (hologram.js: trackGaze).
import { Calibration } from "./gaze.js?v=10";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Как назвать точность калибровки. */
export function qualityLabel(errorPx) {
  if (errorPx <= 60) return "хорошая";
  if (errorPx <= 110) return "средняя — курсор будет липнуть к ближайшей кнопке";
  return "грубая — лучше повторить при ровном свете спереди";
}

export class GazeCalibration {
  /** holo — Hologram (взгляд уже включён: holo.gaze); onDone(model, errorPx) — сохранить; onCancel() — закрыли без калибровки. */
  constructor({ root, holo, say = () => {}, onDone = () => {}, onCancel = () => {} }) {
    Object.assign(this, { root, holo, say, onDone, onCancel });
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
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) this[act]();
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
    this.status.textContent = "";
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> КАЛИБРОВКА ВЗГЛЯДА</div>
      <p><b>Смотрите на точку, пока она не сожмётся</b> — потом она перепрыгнет. Всего 13 точек, около 20 секунд.</p>
      <p class="muted">Держите телефон или садитесь к ноутбуку как обычно: лицо целиком в кадре, свет спереди.
        Голову держать неподвижно не нужно, но и вертеть не стоит. Кадры никуда не уходят — всё на устройстве.</p>
      <div class="gc-actions"><button class="btn ghost" data-act="cancel">ОТМЕНА</button>
        <button class="btn primary" data-act="begin" data-air>НАЧАТЬ</button></div>`);
    this.say("Калибровка взгляда. Смотрите на точку, пока она не сожмётся.");
  }

  showPanel(html) {
    this.panel.innerHTML = html;
    this.panel.classList.remove("hidden");
  }

  begin() {
    if (!this.holo.gaze) { this.cancel(); return; }
    this.panel.classList.add("hidden");
    this.cal = new Calibration({ screen: { w: innerWidth, h: innerHeight } });
    this.holo.gaze.calibration = this.cal;
    this.dot.classList.remove("hidden");
    this.lastPoint = null;
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
    }
    this.dot.style.setProperty("--p", String(c.progress));
    const { n, total } = c.counter;
    const lost = c.faceSeenAt === null ? ts - this.startedAt > 2500 : c.faceLost(ts);
    this.status.innerHTML = lost
      ? '<span class="gt-bad">не вижу лицо — посмотрите в камеру, нужен свет спереди</span>'
      : `${c.checking ? "проверка" : "точка"} ${n}/${total}`;
    requestAnimationFrame(this.tick);
  }

  finish() {
    const { model, errorPx } = this.cal;
    this.holo.gaze.calibration = null;
    this.holo.setGazeModel(model, errorPx);
    this.onDone(model, errorPx);
    this.dot.classList.add("hidden");
    this.status.textContent = "";
    const px = Math.round(errorPx);
    this.showPanel(`
      <div class="panel-h"><span class="idx">◈</span> ВЗГЛЯД НАСТРОЕН</div>
      <p><b>Точность ≈ ${px} px</b> — ${esc(qualityLabel(px))}.</p>
      <p class="gc-how">👁 взгляд — курсор, он прилипает к ближайшей кнопке или заметке<br>
        🤏 короткий щипок (свести и развести пальцы) — нажать<br>
        🤏 щипок и движение — вращать граф или листать заметку, на которую смотрите<br>
        ✊ ✌ 👍 ✋ 👋 — как раньше: закрыть, править, сохранить, сброс, листать</p>
      <p class="muted">Попробуйте сразу: посмотрите на «ГОТОВО» и щипните. Повторить калибровку — кнопка ◎ вверху.</p>
      <div class="gc-actions"><button class="btn ghost" data-act="intro" data-air>ПОВТОРИТЬ</button>
        <button class="btn primary" data-act="close" data-air>ГОТОВО</button></div>`);
    this.say(px <= 110 ? "Взгляд настроен. Посмотрите на «Готово» и щипните пальцами." : "Калибровка грубая, сэр. Лучше повторить при хорошем свете.");
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
