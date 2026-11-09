// Окно первоначального обучения жестам поверх голограммы. Логика шагов — gesture-coach.js,
// схемы рук рисуются из тех же эталонных поз, по которым проверяется распознавание (gestures.js).
import { GestureCoach, STEPS } from "./gesture-coach.js?v=10";
import { BONES, KIND_LABEL, POSES } from "./gestures.js?v=10";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** SVG-схема руки в стиле наложения камеры: голубые кости, белые суставы. flip — левая рука. */
function hand(name, { flip = false, x = 0, y = 0, cls = "" } = {}) {
  const lm = POSES[name].map((p) => ({ x: flip ? 100 - p.x : p.x, y: p.y }));
  const bones = BONES.map(([a, b]) => `<line x1="${lm[a].x}" y1="${lm[a].y}" x2="${lm[b].x}" y2="${lm[b].y}"/>`).join("");
  const joints = lm.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="${[4, 8, 12, 16, 20].includes(i) ? 2.6 : 1.8}"/>`).join("");
  return `<g class="gt-hand ${cls}" transform="translate(${x} ${y})">${bones}${joints}</g>`;
}

function picture(step) {
  const svg = (inner, vb = "0 0 100 100") => `<svg viewBox="${vb}" class="gt-svg gt-${step.anim || "still"}" aria-hidden="true">${inner}</svg>`;
  switch (step.pose) {
    case "intro":
      return svg(`<rect class="gt-phone" x="2" y="22" width="24" height="44" rx="4"/><circle class="gt-lens" cx="14" cy="27" r="1.6"/>
        <path class="gt-stand" d="M6 66 L14 80 L22 66"/><line class="gt-dash" x1="32" y1="50" x2="56" y2="50"/>
        <text x="44" y="44" class="gt-txt">40–60 см</text>${hand("palm", { x: 50, y: 6 })}`, "0 0 150 100");
    case "pinch2":
      return svg(`<g class="gt-l">${hand("pinch", { flip: true, x: -6 })}</g><g class="gt-r">${hand("pinch", { x: 56 })}</g>`, "0 0 150 100");
    case "point": {
      const extra = step.anim === "target" ? '<circle class="gt-node" cx="34" cy="16" r="4"/><circle class="gt-ring" cx="34" cy="16" r="9"/>'
        : step.anim === "press" ? '<rect class="gt-key" x="18" y="9" width="32" height="12" rx="2"/><circle class="gt-ring" cx="34" cy="15" r="9"/>'
          : "";
      return svg(`${hand("point")}${extra}`);
    }
    case "done":
      return svg('<circle class="gt-ok" cx="50" cy="50" r="30"/><path class="gt-check" d="M36 51 L46 61 L65 40"/>');
    default:
      return svg(hand(step.pose));
  }
}

export class GestureTutorial {
  /** holo — Hologram; startCamera() включает камеру; say(text) — голос Jarvis; onFinish() — обучение пройдено. */
  constructor({ root, holo, startCamera, say = () => {}, onFinish = () => {}, onError = () => {} }) {
    Object.assign(this, { root, holo, startCamera, say, onFinish, onError });
    this.el = document.createElement("section");
    this.el.className = "gt panel hidden";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Обучение жестам");
    root.append(this.el);
    this.el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) this[act]();
    });
    this.onGesture = this.onGesture.bind(this);
    this.place = this.place.bind(this);
    this.timers = [];
  }

  get active() { return !this.el.classList.contains("hidden"); }

  /** from — id шага, с которого начать (только новые жесты, камера уже включена). */
  open({ from = null } = {}) {
    this.coach = new GestureCoach(STEPS, { hasNodes: Boolean(this.holo.nodes?.length), start: from });
    this.el.classList.remove("hidden");
    this.root.classList.add("training");
    this.holo.suppressOpen = true;
    this.holo.gestureListeners.add(this.onGesture);
    this.timers.push(setInterval(() => this.renderStatus(), 400));
    window.addEventListener("resize", this.place);
    this.render(true);
  }

  /** Окошко камеры — сразу под шапкой голограммы (её высота зависит от ширины экрана). */
  place() {
    const ui = this.root.querySelector(".holo-ui");
    if (ui) this.root.style.setProperty("--gt-top", `${Math.round(ui.getBoundingClientRect().bottom + 10)}px`);
  }

  close() {
    this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    this.timers = [];
    this.holo.gestureListeners.delete(this.onGesture);
    window.removeEventListener("resize", this.place);
    this.holo.suppressOpen = false;
    this.el.classList.add("hidden");
    this.root.classList.remove("training");
  }

  // ---------- кнопки ----------
  async begin() {
    const btn = this.el.querySelector("[data-act=begin]");
    btn.disabled = true;
    btn.textContent = "ВКЛЮЧАЮ КАМЕРУ…";
    try {
      await this.startCamera();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "ПОВТОРИТЬ";
      const denied = err?.name === "NotAllowedError";
      this.el.querySelector(".gt-status").innerHTML = `<span class="gt-bad">${denied
        ? "Нет доступа к камере. iPhone: «Настройки» → «Safari» → «Камера» → «Спросить» или «Разрешить», затем обновите страницу."
        : `Камера недоступна: ${esc(err?.message || err)}. Нужна https-ссылка (туннель или GitHub Pages).`}</span>`;
      return;
    }
    this.advance();
  }

  /** Сразу к жестам: обучение больше не показывать само (повторить — кнопка «?»). */
  async noTraining() {
    this.onFinish();
    this.close();
    await this.startCamera().catch((err) => this.onError(err));
  }

  skip() { this.advance(); }
  /** Кнопка шага «нажми пальцем»: нажали пальцем в воздухе (голограмма) или по экрану — засчитано. */
  tap() { this.onGesture({ type: "press" }); }
  exit() { this.onFinish(); this.close(); }
  finish() { this.onFinish(); this.close(); }

  advance() {
    this.coach.next(performance.now());
    this.render(true);
  }

  // ---------- события от голограммы ----------
  onGesture(evt) {
    const done = this.coach.feed(evt, performance.now());
    this.renderProgress();
    if (!done) return;
    const step = this.coach.step;
    this.el.classList.add("gt-success");
    this.el.querySelector(".gt-status").innerHTML = `<span class="gt-good">✓ ${esc(step.praise || "Готово")}</span>`;
    if (step.praise) this.say(step.praise);
    const at = this.coach.index;
    this.timers.push(setTimeout(() => {
      this.el.classList.remove("gt-success");
      if (this.active && this.coach.index === at) this.advance();   // если не нажали «Пропустить» раньше
    }, 1100));
  }

  // ---------- отрисовка ----------
  render(speak) {
    const c = this.coach, s = c.step, { n, total } = c.counter;
    const head = s.manual ? "" : `ШАГ ${n}/${total}`;
    let actions;
    if (s.id === "intro") actions = '<button class="btn ghost" data-act="noTraining">БЕЗ ОБУЧЕНИЯ</button><button class="btn primary" data-act="begin">ВКЛЮЧИТЬ КАМЕРУ</button>';
    else if (s.id === "done") actions = '<button class="btn primary" data-act="finish" data-air>ГОТОВО</button>';
    else actions = '<button class="btn ghost" data-act="exit">ВЫЙТИ</button><button class="btn ghost" data-act="skip">ПРОПУСТИТЬ ШАГ</button>';
    if (s.anim === "press") actions = `<button class="btn primary gt-tap" data-act="tap" data-air>НАЖМИ МЕНЯ</button>${actions}`;
    const title = c.first > 0 ? "ЖЕСТЫ ДЛЯ ЗАМЕТОК" : "КАЛИБРОВКА ЖЕСТОВ";
    this.el.innerHTML = `
      <div class="panel-h"><span class="idx">◈</span> ${title} <span class="h-meta">${head}</span></div>
      <div class="gt-body">
        <div class="gt-pic">${picture(s)}</div>
        <div class="gt-text"><b>${esc(s.title)}</b><p>${esc(s.text)}</p></div>
      </div>
      ${s.manual ? "" : '<div class="gt-bar"><i></i></div>'}
      <div class="gt-status" aria-live="polite"></div>
      <div class="gt-actions">${actions}</div>`;
    if (speak) this.say(s.speech);
    this.renderProgress();
    this.renderStatus();
    this.place();
  }

  renderProgress() {
    const bar = this.el.querySelector(".gt-bar i");
    if (bar) bar.style.width = `${Math.round(this.coach.progress * 100)}%`;
  }

  renderStatus() {
    const c = this.coach, st = this.el.querySelector(".gt-status");
    if (!st || c.step.manual || c.complete || st.querySelector(".gt-bad")) return;
    const now = performance.now();
    if (c.handLost(now)) {
      st.innerHTML = '<span class="gt-bad">○ Не вижу руку — подвиньтесь к свету, рука целиком в кадре (окошко камеры сверху)</span>';
    } else if (c.lastHandAt !== null && now - c.lastHandAt < 600) {
      st.innerHTML = `<span class="gt-good">● Распознаю: ${esc(KIND_LABEL[c.lastKind] || c.lastKind)}</span>`;
    } else {
      st.innerHTML = '<span class="muted">… ищу руку</span>';
    }
  }
}
