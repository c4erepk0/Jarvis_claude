// Управление взглядом: взгляд — курсор, жесты — действия (короткий щипок — «нажать»).
// Здесь — логика без DOM (тест — tests/js/gaze.test.mjs):
//   eyeFeatures — признаки взгляда по 478 точкам MediaPipe Face Landmarker (радужки, уголки глаз, поворот головы)
//     и коэффициентам eyeLook*; Calibration — точки на экране, на которые смотрит владелец; GazeModel — гребневая
//     регрессия «признаки → точка экрана»; OneEuro2D — сглаживание дрожания; pickTarget — «магнит» к ближайшей цели.
// Камера телефона определяет взгляд с ошибкой порядка сантиметров на экране, поэтому курсор примагничивается
// к кнопкам и узлам, а нажатие — только жестом (взгляд сам ничего не нажимает: иначе нажималось бы всё подряд).

// Точки лица MediaPipe (478, с радужками): уголки глаз, центры радужек, нос, края лица, лоб, подбородок.
export const FACE = { rOuter: 33, rInner: 133, rIris: 468, lOuter: 263, lInner: 362, lIris: 473,
  nose: 1, left: 234, right: 454, top: 10, chin: 152 };
const LOOK = ["eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeLookDownLeft",
  "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeLookDownRight"];

/** Где радужка внутри глаза, в долях ширины глаза: вдоль линии уголков (+ — вправо по кадру) и поперёк
 *  (+ — вниз). Ось берём одинаково для обоих глаз, иначе у левого и правого знаки были бы разные. */
function eyeOffset(lm, outer, inner, iris) {
  const a = lm[outer], b = lm[inner], c = lm[iris];
  const ex = b.x - a.x, ey = b.y - a.y, w = Math.hypot(ex, ey) || 1e-6;
  const sign = ex < 0 ? -1 : 1;
  const ux = (sign * ex) / w, uy = (sign * ey) / w;
  const dx = c.x - (a.x + b.x) / 2, dy = c.y - (a.y + b.y) / 2;
  return [(dx * ux + dy * uy) / w, (dy * ux - dx * uy) / w];
}

/** Признаки взгляда одного кадра или null — лица нет или глаза закрыты (моргание — не взгляд).
 *  blend — коэффициенты лица { eyeBlinkLeft: 0.1, eyeLookInLeft: 0.4, … }. */
export function eyeFeatures(lm, blend = {}) {
  if (!lm || lm.length < 478) return null;
  if ((blend.eyeBlinkLeft ?? 0) > 0.5 && (blend.eyeBlinkRight ?? 0) > 0.5) return null;
  const [rx, ry] = eyeOffset(lm, FACE.rOuter, FACE.rInner, FACE.rIris);
  const [lx, ly] = eyeOffset(lm, FACE.lOuter, FACE.lInner, FACE.lIris);
  const L = lm[FACE.left], R = lm[FACE.right], N = lm[FACE.nose], T = lm[FACE.top], C = lm[FACE.chin];
  const fw = Math.hypot(R.x - L.x, R.y - L.y) || 1e-6, fh = Math.hypot(C.x - T.x, C.y - T.y) || 1e-6;
  const yaw = (N.x - (L.x + R.x) / 2) / fw, pitch = (N.y - (T.y + C.y) / 2) / fh;
  // где лицо в кадре и насколько близко: сдвинулся — та же радужка смотрит в другую точку экрана
  return [rx, ry, lx, ly, yaw, pitch, N.x, N.y, fw, ...LOOK.map((k) => blend[k] ?? 0)];
}

// ---------- модель: гребневая регрессия признаки → экран (в долях экрана 0…1) ----------
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export class GazeModel {
  /** lambda — сила «сжатия» весов: спасает, когда признаков много, а точек калибровки мало. */
  constructor({ lambda = 1 } = {}) {
    this.lambda = lambda;
    this.samples = [];
    this.mean = null; this.std = null; this.wx = null; this.wy = null;
  }

  add(f, x, y) { this.samples.push([f, x, y]); }
  get ready() { return Boolean(this.wx); }

  fit() {
    const n = this.samples.length;
    if (n < 3) throw new Error("мало точек калибровки");
    const d = this.samples[0][0].length;
    this.mean = Array.from({ length: d }, (_, j) => this.samples.reduce((s, [f]) => s + f[j], 0) / n);
    this.std = Array.from({ length: d }, (_, j) => Math.sqrt(this.samples.reduce((s, [f]) => s + (f[j] - this.mean[j]) ** 2, 0) / n) || 1);
    const X = this.samples.map(([f]) => [1, ...this.z(f)]);
    const k = d + 1;
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)
      + (i === j && i > 0 ? this.lambda : 0)));      // свободный член не штрафуем
    const bx = Array.from({ length: k }, (_, i) => X.reduce((s, r, m) => s + r[i] * this.samples[m][1], 0));
    const by = Array.from({ length: k }, (_, i) => X.reduce((s, r, m) => s + r[i] * this.samples[m][2], 0));
    this.wx = solve(A, bx);
    this.wy = solve(A, by);
    return this;
  }

  z(f) { return f.map((v, j) => (v - this.mean[j]) / this.std[j]); }

  /** Точка экрана в долях (0…1, может выйти за край — обрежет вызывающий). */
  predict(f) {
    const r = [1, ...this.z(f)];
    return { x: r.reduce((s, v, i) => s + v * this.wx[i], 0), y: r.reduce((s, v, i) => s + v * this.wy[i], 0) };
  }

  toJSON() { return { lambda: this.lambda, mean: this.mean, std: this.std, wx: this.wx, wy: this.wy }; }

  static fromJSON(o) {
    const m = new GazeModel({ lambda: o.lambda });
    Object.assign(m, { mean: o.mean, std: o.std, wx: o.wx, wy: o.wy });
    return m;
  }
}

// ---------- сглаживание: фильтр One Euro (Casiez и др., 2012) ----------
// Когда взгляд стоит — сильно сглаживает дрожание, когда прыгает на другую цель — почти не запаздывает.
export class OneEuro {
  constructor({ minCutoff = 0.8, beta = 0.004, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = null; this.dx = 0; this.t = null;
  }

  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }

  filter(x, ts) {
    if (this.x === null) { this.x = x; this.t = ts; return x; }
    const dt = Math.max(1e-3, (ts - this.t) / 1000);
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    this.t = ts;
    return this.x;
  }
}

export class OneEuro2D {
  constructor(opts) { this.fx = new OneEuro(opts); this.fy = new OneEuro(opts); }
  filter(p, ts) { return { x: this.fx.filter(p.x, ts), y: this.fy.filter(p.y, ts) }; }
}

// ---------- магнит ----------
/** Расстояние от точки до цели: { x, y } — точка (узел графа), { x, y, w, h } — прямоугольник (кнопка). */
export function targetDistance(p, t) {
  const dx = Math.max(0, Math.abs(p.x - t.x) - (t.w || 0) / 2), dy = Math.max(0, Math.abs(p.y - t.y) - (t.h || 0) / 2);
  return Math.hypot(dx, dy);
}

/** Ближайшая цель в радиусе или null. За текущую цель держимся, пока взгляд недалеко и другая цель не ближе
 *  явно (на 24 px): иначе курсор прыгал бы между соседними кнопками от дрожания. Но если взгляд уже внутри
 *  другой цели — переходим на неё сразу: строки списка ниже 24 px, и курсор застревал бы на соседней. */
export function pickTarget(p, targets, current = null, radius = 70) {
  let best = null, bestD = Infinity, cur = null, curD = Infinity;
  for (const t of targets) {
    const d = targetDistance(p, t);
    if (current !== null && t.id === current) { cur = t; curD = d; }
    if (d < bestD || (d === 0 && bestD === 0 && t.w * t.h < best.w * best.h)) { best = t; bestD = d; }
  }
  if (cur && curD === 0) return cur;
  if (cur && bestD > 0 && curD < radius * 1.4 && !(bestD < curD - 24)) return cur;
  return bestD <= radius ? best : null;
}

// ---------- калибровка ----------
// Сначала 9 точек по краям и в центре — по ним учится модель, потом 4 проверочные — по ним видно точность.
export const CAL_POINTS = [[0.5, 0.5], [0.08, 0.1], [0.5, 0.1], [0.92, 0.1], [0.92, 0.5], [0.92, 0.9], [0.5, 0.9],
  [0.08, 0.9], [0.08, 0.5]];
export const CHECK_POINTS = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];

export class Calibration {
  /** screen — { w, h } в px (для точности в пикселях); settleMs — глаз доводится до точки, sampleMs — замер. */
  constructor({ screen = { w: 390, h: 844 }, points = CAL_POINTS, check = CHECK_POINTS, settleMs = 650, sampleMs = 850,
    lambda = 1 } = {}) {
    Object.assign(this, { screen, settleMs, sampleMs });
    this.list = [...points.map((p) => ({ p, check: false })), ...check.map((p) => ({ p, check: true }))];
    this.fitCount = points.length;
    this.model = new GazeModel({ lambda });
    this.i = 0;
    this.time = 0;          // сколько точку уже видели (идёт, только пока лицо в кадре)
    this.last = null;
    this.got = [];          // предсказания на текущей проверочной точке
    this.errors = [];
    this.faceSeenAt = null;
  }

  get done() { return this.i >= this.list.length; }
  get point() { return this.done ? null : this.list[this.i].p; }
  get checking() { return !this.done && this.list[this.i].check; }
  get progress() { return Math.min(1, this.time / (this.settleMs + this.sampleMs)); }
  get counter() { return { n: Math.min(this.i + 1, this.list.length), total: this.list.length }; }
  /** Средняя ошибка на проверочных точках, px. */
  get errorPx() { return this.errors.length ? this.errors.reduce((s, e) => s + e, 0) / this.errors.length : null; }
  faceLost(ts, ms = 800) { return this.faceSeenAt === null ? false : ts - this.faceSeenAt > ms; }

  /** Кадр с камеры: f — eyeFeatures (null — лица не видно, время точки стоит). */
  feed(f, ts) {
    if (this.done) return;
    // медленное устройство (несколько кадров в секунду) калибруется в том же темпе, а долгий перерыв
    // (вкладку свернули) не «проматывает» точку
    const dt = this.last === null ? 0 : Math.min(250, ts - this.last);
    this.last = ts;
    if (!f) return;
    this.faceSeenAt = ts;
    this.time += dt;
    const { p, check } = this.list[this.i];
    if (this.time >= this.settleMs) {
      if (check) this.got.push(this.model.predict(f));
      else this.model.add(f, p[0], p[1]);
    }
    if (this.time < this.settleMs + this.sampleMs) return;
    if (check) {
      const m = this.got.reduce((s, q) => ({ x: s.x + q.x / this.got.length, y: s.y + q.y / this.got.length }), { x: 0, y: 0 });
      this.errors.push(Math.hypot((m.x - p[0]) * this.screen.w, (m.y - p[1]) * this.screen.h));
      this.got = [];
    }
    this.i += 1;
    this.time = 0;
    if (this.i === this.fitCount) this.model.fit();
  }
}

/** Радиус магнита по точности калибровки: чем точнее взгляд, тем меньше «прилипает». */
export const snapRadius = (errorPx) => Math.round(Math.max(48, Math.min(150, (errorPx ?? 90) * 1.2)));
