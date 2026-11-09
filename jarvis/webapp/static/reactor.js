// Ядро-«реактор»: кольца вращаются, свечение реагирует на голос (микрофон / речь Jarvis).
// Внешние дуги — показатели дня: задачи, бюджет, нагрузка сервера.

const TAU = Math.PI * 2;
const COLORS = {
  idle: [62, 232, 255], listening: [120, 245, 255], thinking: [62, 200, 255], speaking: [150, 250, 255],
  alert: [255, 179, 71], error: [255, 77, 94],
};

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
    this.resize();
    window.addEventListener("resize", () => this.resize());
    requestAnimationFrame((ts) => this.frame(ts));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    this.size = Math.max(200, Math.min(r.width, r.height) || 400);
    this.c.width = this.size * dpr;
    this.c.height = this.size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(s) { this.state = COLORS[s] ? s : "idle"; }
  setLevel(v) { this.target = Math.max(0, Math.min(1, v)); }
  setMetrics(m) { this.metrics = m; }

  frame(ts) {
    const dt = Math.min(0.05, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    const speed = { idle: 0.25, listening: 0.6, thinking: 1.4, speaking: 0.8, alert: 0.9, error: 0.9 }[this.state];
    this.t += dt * speed;
    this.level += (this.target - this.level) * Math.min(1, dt * 12);
    if (this.state !== "speaking" && this.state !== "listening") this.target *= 0.9;
    const goal = COLORS[this.state];
    for (let i = 0; i < 3; i++) this.color[i] += (goal[i] - this.color[i]) * Math.min(1, dt * 4);
    this.draw();
    requestAnimationFrame((t) => this.frame(t));
  }

  rgba(a) { const [r, g, b] = this.color.map(Math.round); return `rgba(${r},${g},${b},${a})`; }

  draw() {
    const { ctx, size: S } = this;
    const cx = S / 2, cy = S / 2, R = S * 0.46;
    const lvl = this.level, t = this.t;
    ctx.clearRect(0, 0, S, S);

    // мягкое свечение
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    glow.addColorStop(0, this.rgba(0.32 + lvl * 0.4));
    glow.addColorStop(0.35, this.rgba(0.08 + lvl * 0.12));
    glow.addColorStop(1, this.rgba(0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = this.rgba(0.9);

    // внешние дуги показателей
    const arcR = R * 0.95;
    this.metrics.forEach((m, i) => {
      const start = -Math.PI / 2 + i * (TAU / 3) + 0.08;
      const span = TAU / 3 - 0.16;
      ctx.lineWidth = S * 0.012;
      ctx.strokeStyle = this.rgba(0.12);
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(0, 0, arcR, start, start + span); ctx.stroke();
      const v = Math.max(0, Math.min(1, m.value || 0));
      ctx.strokeStyle = v >= 1 ? "rgba(255,77,94,.95)" : v >= 0.8 ? "rgba(255,179,71,.95)" : this.rgba(0.9);
      ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(0, 0, arcR, start, start + span * v); ctx.stroke();
      // подпись
      const mid = start + span / 2;
      const bottom = Math.sin(mid) > 0.2;   // внизу пишем «по дуге снаружи», чтобы текст не был вверх ногами
      ctx.save();
      ctx.rotate(bottom ? mid - Math.PI / 2 : mid + Math.PI / 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = this.rgba(0.65);
      ctx.font = `600 ${Math.max(8, S * 0.022)}px Orbitron, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = bottom ? "top" : "alphabetic";
      ctx.fillText(`${m.label} ${Math.round(v * 100)}%`, 0, bottom ? arcR + S * 0.02 : -arcR - S * 0.02);
      ctx.restore();
    });

    // таймер фокуса
    if (this.focus && this.focus.until) {
      const left = Math.max(0, this.focus.until - Date.now() / 1000);
      const frac = left / this.focus.total;
      ctx.lineWidth = S * 0.006;
      ctx.strokeStyle = "rgba(255,179,71,.9)";
      ctx.shadowColor = "rgba(255,179,71,.9)";
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.865, -Math.PI / 2, -Math.PI / 2 + TAU * frac); ctx.stroke();
      ctx.shadowColor = this.rgba(0.9);
    }

    // кольцо делений
    ctx.save();
    ctx.rotate(-t * 0.35);
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * TAU;
      const long = i % 10 === 0;
      const r1 = R * 0.8, r2 = R * (long ? 0.74 : 0.77);
      ctx.strokeStyle = this.rgba(long ? 0.8 : 0.3);
      ctx.lineWidth = long ? 2 : 1;
      ctx.shadowBlur = long ? 6 : 0;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.stroke();
    }
    ctx.restore();

    // прерывистое кольцо (сканер)
    ctx.save();
    ctx.rotate(t * 0.9);
    ctx.lineWidth = S * 0.008;
    ctx.shadowBlur = 12;
    const scan = this.state === "thinking" ? 6 : 3;
    for (let i = 0; i < scan; i++) {
      const a = (i / scan) * TAU;
      ctx.strokeStyle = this.rgba(0.85);
      ctx.beginPath(); ctx.arc(0, 0, R * 0.69, a, a + (this.state === "thinking" ? 0.45 : 0.9)); ctx.stroke();
    }
    ctx.restore();

    // катушки реактора (10 сегментов)
    ctx.save();
    ctx.rotate(t * 0.18);
    const coils = 10, rIn = R * (0.4 + lvl * 0.03), rOut = R * (0.6 + lvl * 0.05);
    for (let i = 0; i < coils; i++) {
      const a = (i / coils) * TAU, w = (TAU / coils) * 0.62;
      ctx.beginPath();
      ctx.arc(0, 0, rOut, a, a + w);
      ctx.arc(0, 0, rIn, a + w * 0.92, a + w * 0.08, true);
      ctx.closePath();
      const g = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut);
      g.addColorStop(0, this.rgba(0.55 + lvl * 0.4));
      g.addColorStop(1, this.rgba(0.12 + lvl * 0.2));
      ctx.fillStyle = g;
      ctx.shadowBlur = 14 + lvl * 20;
      ctx.fill();
      ctx.strokeStyle = this.rgba(0.9);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();

    // внутреннее кольцо
    ctx.lineWidth = S * 0.01;
    ctx.strokeStyle = this.rgba(0.9);
    ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.34, 0, TAU); ctx.stroke();

    // треугольник в центре (как в Mk II — но свой)
    ctx.save();
    ctx.rotate(-t * 0.5);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.rgba(0.6);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * TAU;
      ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * R * 0.27, Math.sin(a) * R * 0.27);
    }
    ctx.closePath(); ctx.stroke();
    ctx.restore();

    // ядро
    const coreR = R * (0.2 + lvl * 0.07 + Math.sin(this.t * 3) * 0.005);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, "rgba(255,255,255,1)");
    core.addColorStop(0.35, this.rgba(0.95));
    core.addColorStop(1, this.rgba(0.05));
    ctx.fillStyle = core;
    ctx.shadowBlur = 40 + lvl * 40;
    ctx.beginPath(); ctx.arc(0, 0, coreR, 0, TAU); ctx.fill();

    // звуковая волна по кругу
    if (lvl > 0.02) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.rgba(0.7);
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * TAU;
        const wob = Math.sin(a * 8 + this.t * 9) * Math.sin(a * 3 - this.t * 4);
        const r = R * 0.36 + wob * R * 0.06 * lvl;
        ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
