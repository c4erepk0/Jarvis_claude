// Ядро Atom: сфера из частиц (particle-sphere.js, three.js) — дышит в покое, волнуется от голоса (микрофон / речь Atom),
// закручивается, когда Atom думает. Тонкие дуги вокруг — показатели дня: задачи, бюджет, нагрузка сервера (2D-холст поверх).
// Нет WebGL или CDN недоступен — сфера рисуется здесь же, на 2D-холсте. Имя класса прежнее — ради совместимости.

const TAU = Math.PI * 2;
const COLORS = {
  idle: [255, 69, 58], listening: [255, 120, 100], thinking: [255, 82, 82], speaking: [255, 140, 115],
  alert: [255, 179, 71], error: [255, 111, 168],
};
// «уменьшить движение» в системе — кольца вращаются в несколько раз медленнее (свечение от голоса остаётся)
const CALM = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

export class Reactor {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = "idle";
    this.level = 0;          // 0..1 — громкость текущего звука
    this.target = 0;
    this.metrics = [{ label: "ЗАДАЧИ", value: 0 }, { label: "БЮДЖЕТ", value: 0 }, { label: "НАГРУЗКА", value: 0 }];
    this.color = [...COLORS.idle];
    this.t = 0;
    this.focus = null;       // {until, total}
    this.gl = null;          // ParticleSphere, когда three.js загрузился
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((ts) => this.frame(ts));
    this.loadParticles();
  }

  async loadParticles() {
    if (typeof WebGLRenderingContext === "undefined" || new URLSearchParams(location.search).has("flat")) return;
    try {
      const { ParticleSphere } = await import("./particle-sphere.js?v=26");
      this.gl = new ParticleSphere(this.c.parentElement);
      this.c.parentElement.classList.add("particles");
    } catch (e) {
      console.info("ядро: сфера из частиц недоступна, рисую плоскую", e);
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.size = Math.max(200, Math.min(r.width, r.height) || 400);
    this.c.width = this.size * dpr;
    this.c.height = this.size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.gl?.resize();
  }

  setState(s) { this.state = COLORS[s] ? s : "idle"; }
  setLevel(v) { this.target = Math.max(0, Math.min(1, v)); }
  setMetrics(m) { this.metrics = m; }

  frame(ts) {
    const dt = Math.min(0.05, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    const speed = { idle: 0.25, listening: 0.6, thinking: 1.4, speaking: 0.8, alert: 0.9, error: 0.9 }[this.state];
    this.t += dt * speed * (CALM?.matches ? 0.2 : 1);
    this.level += (this.target - this.level) * Math.min(1, dt * 12);
    if (this.state !== "speaking" && this.state !== "listening") this.target *= 0.9;
    const goal = COLORS[this.state];
    for (let i = 0; i < 3; i++) this.color[i] += (goal[i] - this.color[i]) * Math.min(1, dt * 4);
    this.draw();
    this.gl?.render({ t: this.t, dt, level: this.level, state: this.state, color: this.color });
    requestAnimationFrame((t) => this.frame(t));
  }

  rgba(a) { const [r, g, b] = this.color.map(Math.round); return `rgba(${r},${g},${b},${a})`; }

  draw() {
    // Спокойная «живая» сфера вместо реактора: дышит в покое, реагирует на голос, думает — по краю бежит отблеск.
    const { ctx, size: S } = this;
    const cx = S / 2, cy = S / 2, R = S * 0.46;
    const lvl = this.level, t = this.t;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(cx, cy);

    // тонкие дуги показателей дня
    const arcR = R * 0.94;
    this.metrics.forEach((m, i) => {
      const start = -Math.PI / 2 + i * (TAU / 3) + 0.14;
      const span = TAU / 3 - 0.28;
      const v = Math.max(0, Math.min(1, m.value || 0));
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, S * 0.008);
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.beginPath(); ctx.arc(0, 0, arcR, start, start + span); ctx.stroke();
      if (v > 0) {
        ctx.strokeStyle = v >= 1 ? "rgba(255,111,168,.95)" : v >= 0.8 ? "rgba(255,179,71,.95)" : this.rgba(0.85);
        ctx.beginPath(); ctx.arc(0, 0, arcR, start, start + span * v); ctx.stroke();
      }
      const mid = start + span / 2;
      const bottom = Math.sin(mid) > 0.2;
      ctx.save();
      ctx.rotate(bottom ? mid - Math.PI / 2 : mid + Math.PI / 2);
      ctx.fillStyle = "rgba(236,230,228,.55)";
      ctx.font = `600 ${Math.max(9, S * 0.026)}px Manrope, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = bottom ? "top" : "alphabetic";
      const label = m.label.charAt(0) + m.label.slice(1).toLowerCase();
      ctx.fillText(`${label} ${Math.round(v * 100)}%`, 0, bottom ? arcR + S * 0.022 : -arcR - S * 0.022);
      ctx.restore();
    });

    // таймер фокуса — янтарное кольцо внутри дуг
    if (this.focus && this.focus.until) {
      const left = Math.max(0, this.focus.until - Date.now() / 1000);
      ctx.lineWidth = Math.max(2, S * 0.006);
      ctx.strokeStyle = "rgba(255,179,71,.9)";
      ctx.beginPath(); ctx.arc(0, 0, R * 0.84, -Math.PI / 2, -Math.PI / 2 + TAU * (left / this.focus.total)); ctx.stroke();
    }

    if (this.gl) { ctx.restore(); return; }   // сферу рисуют частицы

    // мягкий ореол
    const r0 = R * (0.5 + Math.sin(t * 1.6) * 0.012 + lvl * 0.06);
    const halo = ctx.createRadialGradient(0, 0, r0 * 0.6, 0, 0, R * 0.9);
    halo.addColorStop(0, this.rgba(0.16 + lvl * 0.2));
    halo.addColorStop(1, this.rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, TAU); ctx.fill();

    // сфера: край чуть «живой», голос даёт волну
    const blob = (r, amp, phase) => {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * TAU;
        const w = Math.sin(a * 3 + t * 1.3 + phase) * 0.5 + Math.sin(a * 5 - t * 1.7 + phase) * 0.3
          + Math.sin(a * 9 + t * 6) * lvl * 0.9;
        const rr = r * (1 + w * amp);
        ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
    };
    const body = ctx.createRadialGradient(-r0 * 0.35, -r0 * 0.4, r0 * 0.05, 0, 0, r0 * 1.05);
    body.addColorStop(0, "rgba(255,236,232,.95)");
    body.addColorStop(0.25, this.rgba(0.95));
    body.addColorStop(1, this.rgba(0.35));
    ctx.fillStyle = body;
    blob(r0, 0.018 + lvl * 0.06, 0);
    ctx.fill();
    // второй контур — тонкая обводка, чуть смещённая по фазе
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    blob(r0 * 1.08, 0.025 + lvl * 0.08, 1.7);
    ctx.stroke();

    // думаю — по окружности бежит отблеск
    if (this.state === "thinking") {
      const a = t * 2.2;
      ctx.lineWidth = Math.max(2, S * 0.008);
      ctx.lineCap = "round";
      const g = ctx.createConicGradient ? ctx.createConicGradient(a, 0, 0) : null;
      if (g) { g.addColorStop(0, this.rgba(0.9)); g.addColorStop(0.25, this.rgba(0)); g.addColorStop(1, this.rgba(0)); }
      ctx.strokeStyle = g || this.rgba(0.8);
      ctx.beginPath(); ctx.arc(0, 0, r0 * 1.22, a, a + 1.4); ctx.stroke();
    }
    ctx.restore();
  }
}
