// Управление взглядом: взгляд — курсор, жесты — действия (короткий щипок — «нажать»).
// Здесь — логика без DOM (тесты — tests/js/gaze.test.mjs и gaze-sessions.test.mjs на записанных калибровках):
//   eyeFeatures — признаки взгляда по 478 точкам MediaPipe Face Landmarker (радужки, уголки глаз, поворот головы)
//     и коэффициентам eyeLook*; Calibration — точки на экране, на которые смотрит владелец (быстрая и большая);
//     GazeModel — гребневая регрессия «признаки → точка экрана»; AdaptiveGaze — та же модель, доучивается на
//     нажатиях щипком; OneEuro2D — сглаживание дрожания; pickTarget — «магнит» к ближайшей цели;
//     packFrame/unpackFrame — запись «сырых» точек лица, evaluateSession — оценка записанной калибровки.
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

/** Версия признаков: модель, обученная на других признаках, не годится — калибровать заново. */
export const FEATURE_VERSION = 3;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Признаки взгляда — только глаза, без положения головы (v3). Подобраны на калибровках владельца
 *  (Jarvis/Gaze, 3 сессии на iPhone): по горизонтали с точкой экрана связаны радужки и eyeLook (корреляция ~0,97
 *  во всех сессиях), по вертикали — они же и открытость глаз (0,97–0,99). Поза головы тоже коррелировала с точкой,
 *  но в каждой сессии по-своему (вплоть до смены знака): человек чуть двигает головой и телефоном, переводя взгляд,
 *  и модель училась на этом совпадении — в новой сессии промах был 300–500 px. Сдвиг от другой позы и света
 *  убирают привязка (3 точки) и поправка по каждому щипку (AdaptiveGaze), а не признаки головы. Поворот лица
 *  по точкам кадра (нос против краёв лица) по своей оси — помогает: в работе 71 → 64 px, после смены позы 98 → 84.
 *  Возвращает [eh, bh, yaw, ev, bv, open, blink, wide, pitch]: первые 3 — для x, остальные — для y (SPLIT). */
export function gazeFeatures(lm, blend = {}) {
  const e = eyeFeatures(lm, blend);
  if (!e) return null;
  const b = (k) => blend[k] ?? 0;
  const open = (dist(lm[159], lm[145]) / (dist(lm[33], lm[133]) || 1e-6) + dist(lm[386], lm[374]) / (dist(lm[263], lm[362]) || 1e-6)) / 2;
  return [
    (e[0] + e[2]) / 2,                                                                       // радужки вдоль глаза
    (b("eyeLookOutLeft") - b("eyeLookInLeft") + b("eyeLookInRight") - b("eyeLookOutRight")) / 2,  // eyeLook по горизонтали
    e[4],                                                                                    // поворот лица влево-вправо
    (e[1] + e[3]) / 2,                                                                       // радужки поперёк глаза
    (b("eyeLookUpLeft") + b("eyeLookUpRight") - b("eyeLookDownLeft") - b("eyeLookDownRight")) / 2,
    Number.isFinite(open) ? open : 0,                                                        // глаз открыт шире, глядя вверх
    (b("eyeBlinkLeft") + b("eyeBlinkRight")) / 2, (b("eyeWideLeft") + b("eyeWideRight")) / 2,
    e[5],                                                                                    // наклон лица вверх-вниз
  ];
}
/** Какие признаки gazeFeatures идут в горизонталь, какие — в вертикаль. */
export const SPLIT = { x: [0, 1, 2], y: [3, 4, 5, 6, 7, 8] };

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

  /** w — вес примера: нажатие по цели весит как несколько кадров калибровки. */
  add(f, x, y, w = 1) { this.samples.push([f, x, y, w]); }
  get ready() { return Boolean(this.wx); }

  fit() {
    const n = this.samples.length;
    if (n < 3) throw new Error("мало точек калибровки");
    const d = this.samples[0][0].length;
    const W = this.samples.map((s) => s[3] ?? 1), total = W.reduce((a, b) => a + b, 0);
    this.mean = Array.from({ length: d }, (_, j) => this.samples.reduce((s, [f], m) => s + W[m] * f[j], 0) / total);
    this.std = Array.from({ length: d }, (_, j) => Math.sqrt(this.samples.reduce((s, [f], m) => s + W[m] * (f[j] - this.mean[j]) ** 2, 0) / total) || 1);
    const X = this.samples.map(([f]) => [1, ...this.z(f)]);
    const k = d + 1;
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r, m) => s + W[m] * r[i] * r[j], 0)
      + (i === j && i > 0 ? this.lambda : 0)));      // свободный член не штрафуем
    const bx = Array.from({ length: k }, (_, i) => X.reduce((s, r, m) => s + W[m] * r[i] * this.samples[m][1], 0));
    const by = Array.from({ length: k }, (_, i) => X.reduce((s, r, m) => s + W[m] * r[i] * this.samples[m][2], 0));
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

/** Модель по осям: x — по своим признакам, y — по своим (SPLIT). Меньше признаков на ось — меньше подгонки под
 *  шум: при 9 точках калибровки модель на всех 17 признаках угадывала новые точки хуже. Признаки другой длины —
 *  обычная GazeModel на всех (старые записи, тесты). Тот же интерфейс, что у GazeModel. */
export class SplitModel {
  constructor({ lambda = 1, split = SPLIT } = {}) {
    this.lambda = lambda;
    this.split = split;
    this.samples = [];
    this.mx = null; this.my = null; this.full = null;
  }

  add(f, x, y, w = 1) { this.samples.push([f, x, y, w]); }
  get ready() { return Boolean(this.mx || this.full); }
  pick(f, axis) { return this.split[axis].map((i) => f[i]); }

  fit() {
    if (this.samples.length < 3) throw new Error("мало точек калибровки");
    const len = this.samples[0][0].length;
    if (len !== FEATURE_LEN) {
      this.full = new GazeModel({ lambda: this.lambda });
      this.samples.forEach(([f, x, y, w]) => this.full.add(f, x, y, w));
      this.full.fit();
      return this;
    }
    this.mx = new GazeModel({ lambda: this.lambda }); this.my = new GazeModel({ lambda: this.lambda });
    for (const [f, x, y, w] of this.samples) { this.mx.add(this.pick(f, "x"), x, 0, w); this.my.add(this.pick(f, "y"), y, 0, w); }
    this.mx.fit(); this.my.fit();
    return this;
  }

  predict(f) {
    if (this.full) return this.full.predict(f);
    return { x: this.mx.predict(this.pick(f, "x")).x, y: this.my.predict(this.pick(f, "y")).x };
  }

  toJSON() { return { lambda: this.lambda, split: this.split, mx: this.mx, my: this.my, full: this.full }; }
  static fromJSON(o) {
    const m = new SplitModel({ lambda: o.lambda, split: o.split || SPLIT });
    if (o.full) m.full = GazeModel.fromJSON(o.full);
    else { m.mx = GazeModel.fromJSON(o.mx); m.my = GazeModel.fromJSON(o.my); }
    return m;
  }
}
const FEATURE_LEN = 9;

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

/** Ближайшая цель в радиусе или null. За текущую цель держимся, пока взгляд недалеко (hold × радиус) и другая цель
 *  не ближе явно (на margin px): иначе подсветка прыгала бы между соседними кнопками от дрожания. Если взгляд уже
 *  внутри другой цели — переходим на неё сразу: строки списка невысокие, и подсветка застревала бы на соседней. */
export function pickTarget(p, targets, current = null, radius = 70, { hold = 1.15, margin = 12 } = {}) {
  let best = null, bestD = Infinity, cur = null, curD = Infinity;
  for (const t of targets) {
    const d = targetDistance(p, t);
    if (current !== null && t.id === current) { cur = t; curD = d; }
    if (d < bestD || (d === 0 && bestD === 0 && t.w * t.h < best.w * best.h)) { best = t; bestD = d; }
  }
  if (cur && curD === 0) return cur;
  if (cur && bestD > 0 && curD < radius * hold && !(bestD < curD - margin)) return cur;
  return bestD <= radius ? best : null;
}

// ---------- калибровка ----------
// Сначала 9 точек по краям и в центре — по ним учится модель, потом 4 проверочные — по ним видно точность.
export const CAL_POINTS = [[0.5, 0.5], [0.08, 0.1], [0.5, 0.1], [0.92, 0.1], [0.92, 0.5], [0.92, 0.9], [0.5, 0.9],
  [0.08, 0.9], [0.08, 0.5]];
export const CHECK_POINTS = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]];
// Большая калибровка: сетка 5×5 «змейкой» (глазу не прыгать через весь экран) и 8 проверочных между узлами сетки.
const GRID = [0.06, 0.28, 0.5, 0.72, 0.94];
export const BIG_POINTS = GRID.flatMap((y, r) => (r % 2 ? [...GRID].reverse() : GRID).map((x) => [x, y]));
export const BIG_CHECK = [[0.2, 0.4], [0.4, 0.2], [0.6, 0.8], [0.8, 0.6], [0.35, 0.65], [0.65, 0.35], [0.15, 0.85], [0.85, 0.15]];
/** Привязка: 3 точки, ~6 с — при каждом включении взгляда. Убирает сдвиг, с которым модель переходит в новую
 *  сессию (другой свет, поза, как открыты глаза): на записях владельца промах 176 → ~60 px. Модель не переучивается. */
export const ANCHOR_POINTS = [[0.5, 0.3], [0.25, 0.72], [0.75, 0.72]];
// Темп: точка плавно переезжает, затем ждём, пока взгляд устоится (не меньше settleMs, не больше settleMaxMs),
// и только потом пишем sampleMs. Прежние 0,6 с ожидания владельцу казались «точка очень быстро перемещается».
const PACE = { settleMs: 1000, settleMaxMs: 1700, sampleMs: 900 };
export const CALIBRATIONS = {
  quick: { points: CAL_POINTS, check: CHECK_POINTS, ...PACE },
  big: { points: BIG_POINTS, check: BIG_CHECK, ...PACE },
  anchor: { points: ANCHOR_POINTS, check: [], ...PACE, fit: false },
};
/** Взгляд устоялся: за последние кадры радужки почти не сдвигались (доля ширины глаза). */
const STEADY = { frames: 6, spread: 0.008 };

/** Поза головы относительно камеры по матрице MediaPipe: сдвиг (см), расстояние (см), повороты (градусы). */
export function headPose(m) {
  if (!m || m.length < 16) return null;
  const deg = (a) => (a * 180) / Math.PI;
  return { x: m[12], y: m[13], z: -m[14], yaw: deg(Math.atan2(m[8], m[10])), pitch: deg(Math.atan2(m[9], m[10])),
    roll: deg(Math.atan2(m[1], m[0])) };
}

export class Calibration {
  /** screen — { w, h } в px (для точности в пикселях); mode — quick | big | anchor (привязка: модель не учится,
   *  собираются примеры для AdaptiveGaze.anchor); record — сохранять «сырые» кадры (packFrame) для анализа. */
  constructor({ screen = { w: 390, h: 844 }, mode = "quick", points, check, settleMs, settleMaxMs, sampleMs, lambda = 1,
    record = false, maxPerPoint = 30 } = {}) {
    const preset = CALIBRATIONS[mode] || CALIBRATIONS.quick;
    points ??= preset.points; check ??= preset.check;
    settleMs ??= preset.settleMs; settleMaxMs ??= preset.settleMaxMs ?? settleMs; sampleMs ??= preset.sampleMs;
    Object.assign(this, { screen, mode, settleMs, settleMaxMs, sampleMs, lambda, record, maxPerPoint });
    this.fitModel = preset.fit !== false;
    this.frames = [];       // записанные кадры: { t, p (номер точки), lm, b, m }
    this.perPoint = 0;
    this.t0 = null;
    this.list = [...points.map((p) => ({ p, check: false })), ...check.map((p) => ({ p, check: true }))];
    this.fitCount = points.length;
    this.poseRange = null;  // в каких позах прошла калибровка — вне их точность падает
    this.model = new SplitModel({ lambda });
    this.i = 0;
    this.time = 0;          // сколько точку уже видели (идёт, только пока лицо в кадре)
    this.sampleFrom = null; // с какого момента точки пишем замер (взгляд устоялся)
    this.recent = [];       // последние признаки — устоялся ли взгляд
    this.last = null;
    this.got = [];          // предсказания на текущей проверочной точке
    this.errors = [];
    this.faceSeenAt = null;
  }

  get done() { return this.i >= this.list.length; }
  get point() { return this.done ? null : this.list[this.i].p; }
  get checking() { return !this.done && this.list[this.i].check; }
  /** Идёт ли замер (взгляд устоялся) — точка в это время сжимается. */
  get sampling() { return !this.done && this.sampleFrom !== null; }
  /** 0…0,3 — ждём взгляд, 0,3…1 — замер. */
  get progress() {
    if (this.sampleFrom === null) return Math.min(0.3, (0.3 * this.time) / this.settleMs);
    return Math.min(1, 0.3 + (0.7 * (this.time - this.sampleFrom)) / this.sampleMs);
  }
  get counter() { return { n: Math.min(this.i + 1, this.list.length), total: this.list.length }; }
  /** Средняя ошибка на проверочных точках, px. */
  get errorPx() { return this.errors.length ? this.errors.reduce((s, e) => s + e, 0) / this.errors.length : null; }
  faceLost(ts, ms = 800) { return this.faceSeenAt === null ? false : ts - this.faceSeenAt > ms; }

  steady() {
    const r = this.recent;
    if (r.length < STEADY.frames) return false;
    return [0, 2].every((j) => Math.max(...r.map((f) => f[j])) - Math.min(...r.map((f) => f[j])) < STEADY.spread);
  }

  /** Кадр с камеры: f — gazeFeatures (null — лица не видно или моргнул, время точки стоит); raw — packFrame. */
  feed(f, ts, raw = null) {
    if (this.done) return;
    if (this.t0 === null) this.t0 = ts;
    // медленное устройство (несколько кадров в секунду) калибруется в том же темпе, а долгий перерыв
    // (вкладку свернули) не «проматывает» точку
    const dt = this.last === null ? 0 : Math.min(250, ts - this.last);
    this.last = ts;
    if (!f) return;
    this.faceSeenAt = ts;
    this.time += dt;
    this.recent.push(f);
    if (this.recent.length > STEADY.frames) this.recent.shift();
    const { p, check } = this.list[this.i];
    const pose = raw?.m ? headPose(raw.m) : null;
    if (pose) {
      this.poseRange ??= {};
      for (const k of ["x", "y", "z", "yaw", "pitch", "roll"]) {
        const r = this.poseRange[k] ??= [pose[k], pose[k]];
        r[0] = Math.min(r[0], pose[k]); r[1] = Math.max(r[1], pose[k]);
      }
    }
    if (this.sampleFrom === null) {
      if (this.time < this.settleMs || (!this.steady() && this.time < this.settleMaxMs)) return;
      this.sampleFrom = this.time;
    }
    if (check) this.got.push(this.model.predict(f));
    else this.model.add(f, p[0], p[1]);
    if (this.record && raw && this.perPoint < this.maxPerPoint) {
      this.frames.push({ t: Math.round(ts - this.t0), p: this.i, ...raw });
      this.perPoint += 1;
    }
    if (this.time - this.sampleFrom < this.sampleMs) return;
    if (check) {
      const m = this.got.reduce((s, q) => ({ x: s.x + q.x / this.got.length, y: s.y + q.y / this.got.length }), { x: 0, y: 0 });
      this.errors.push(Math.hypot((m.x - p[0]) * this.screen.w, (m.y - p[1]) * this.screen.h));
      this.got = [];
    }
    this.i += 1;
    this.time = 0;
    this.sampleFrom = null;
    this.recent = [];
    this.perPoint = 0;
    if (this.i === this.fitCount && this.fitModel) this.model.fit();
  }

  /** Модель для работы — на кадрах этой калибровки (не больше 400, равномерно). */
  adaptive(opts = {}) {
    const all = this.model.samples;
    const step = Math.max(1, Math.ceil(all.length / 400));
    return new AdaptiveGaze({ base: all.filter((_, k) => k % step === 0).map(([f, x, y, w]) => [f.map(r4), x, y, w ?? 1]),
      lambda: this.lambda, range: this.poseRange, ...opts });
  }

  /** Примеры привязки: [признаки, x, y] — для AdaptiveGaze.anchor. */
  get anchorSamples() { return this.model.samples.map(([f, x, y]) => [f, x, y]); }

  /** Запись калибровки для хранилища (Jarvis/Gaze/sessions): точки, «сырые» кадры, итог. */
  toSession({ created = new Date().toISOString(), device = "" } = {}) {
    return {
      kind: "jarvis-gaze-session", version: 1, created, device, mode: this.mode,
      screen: { w: Math.round(this.screen.w), h: Math.round(this.screen.h) },
      settleMs: this.settleMs, settleMaxMs: this.settleMaxMs, sampleMs: this.sampleMs, lambda: this.lambda,
      landmarks: RAW_LANDMARKS, blend: BLEND_KEYS, featureVersion: FEATURE_VERSION,
      points: this.list.map(({ p, check }) => ({ x: p[0], y: p[1], check })),
      frames: this.frames,
      result: { errorPx: this.errorPx === null ? null : Math.round(this.errorPx * 10) / 10, errors: this.errors.map((e) => Math.round(e)) },
    };
  }
}

// ---------- точность в работе ----------
/** Поправка после нажатия: какая доля промаха убирается сразу. Подобрано на записях владельца (поток нажатий
 *  в другой сессии): 0 — 176 px, 0,4 — 65, 0,6 — 62, 0,8 — 62; после смены позы 0,6 — 98 px против 551. */
export const LIVE_ALPHA = 0.6;

/** Модель в работе: калибровка + поправка сдвига. Нажали щипком по цели — значит, смотрели на неё: промах
 *  (цель минус взгляд) сразу сдвигает курсор на долю alpha. Сдвиг от новой сессии убирает привязка (anchor).
 *  Модель на нажатиях не переучивается: на записях владельца поправка сдвига работала лучше и устойчивее.
 *  Заодно считает точность в работе — промах взгляда на последних нажатиях. */
export class AdaptiveGaze {
  /** range — в каких позах головы прошла калибровка (headPose: min/max); bias — поправка, доли экрана. */
  constructor({ base = [], usage = [], lambda = 1, limit = 60, range = null, bias = null, alpha = LIVE_ALPHA,
    featureVersion = FEATURE_VERSION } = {}) {
    Object.assign(this, { base, usage, lambda, limit, range, alpha, featureVersion });
    this.bias = bias ? { ...bias } : { x: 0, y: 0 };
    this.refit();
  }

  refit() {
    const m = new SplitModel({ lambda: this.lambda });
    for (const [f, x, y, w] of this.base) m.add(f, x, y, w ?? 1);
    this.model = m.samples.length >= 3 ? m.fit() : null;
  }

  get ready() { return Boolean(this.model); }
  predict(f) { const p = this.model.predict(f); return { x: p.x + this.bias.x, y: p.y + this.bias.y }; }

  /** Поза ушла за пределы калибровки — точность падает: голограмма подскажет пройти привязку. */
  outOfRange(pose, slack = { y: 5, z: 7, pitch: 6, roll: 10 }) {
    if (!pose || !this.range) return false;
    return Object.entries(slack).some(([k, s]) => this.range[k] && (pose[k] < this.range[k][0] - s || pose[k] > this.range[k][1] + s));
  }

  extendRange(pose) {
    if (!pose || !this.range) return;
    for (const k of Object.keys(this.range)) {
      const r = this.range[k];
      if (pose[k] !== undefined) { r[0] = Math.min(r[0], pose[k]); r[1] = Math.max(r[1], pose[k]); }
    }
  }

  /** Нажатие по цели: f — признаки, когда свели пальцы; x, y — где цель (доли экрана); errPx — промах взгляда;
   *  pose — поза головы (после поправки в этой позе подсказка «поза изменилась» больше не нужна). */
  learn(f, x, y, errPx = null, pose = null) {
    const p = this.predict(f);
    this.bias.x += this.alpha * (x - p.x);
    this.bias.y += this.alpha * (y - p.y);
    this.usage.push([f.map(r4), r4(x), r4(y), errPx === null ? null : Math.round(errPx)]);
    if (this.usage.length > this.limit) this.usage.shift();
    this.extendRange(pose);
  }

  /** Привязка по нескольким точкам: samples — [признаки, x, y]; сдвиг = средний промах модели по точкам;
   *  range — позы головы на привязке (Calibration.poseRange): в них подсказка «поза другая» не нужна.
   *  Возвращает поправку { x, y } в долях экрана. */
  anchor(samples, range = null) {
    const by = new Map();
    for (const [f, x, y] of samples) {
      const key = `${x},${y}`;
      if (!by.has(key)) by.set(key, { x, y, px: [], py: [] });
      const p = this.model.predict(f), g = by.get(key);
      g.px.push(p.x); g.py.push(p.y);
    }
    const pts = [...by.values()];
    if (!pts.length) return this.bias;
    this.bias = { x: mean(pts.map((g) => g.x - mean(g.px))), y: mean(pts.map((g) => g.y - mean(g.py))) };
    if (range) {
      this.range ??= {};
      for (const [k, [lo, hi]] of Object.entries(range)) {
        const r = this.range[k] ??= [lo, hi];
        r[0] = Math.min(r[0], lo); r[1] = Math.max(r[1], hi);
      }
    }
    return this.bias;
  }

  /** Средний промах взгляда по последним n нажатиям, px (null — нажатий ещё не было). */
  liveErrorPx(n = 20) {
    const e = this.usage.slice(-n).map((u) => u[3]).filter((v) => v !== null && v !== undefined);
    return e.length ? Math.round(e.reduce((a, b) => a + b, 0) / e.length) : null;
  }

  toJSON() {
    return { featureVersion: this.featureVersion, lambda: this.lambda, limit: this.limit, alpha: this.alpha,
      range: this.range, bias: { x: r4(this.bias.x), y: r4(this.bias.y) }, base: this.base, usage: this.usage };
  }
  static fromJSON(o) { return new AdaptiveGaze(o); }
}

// ---------- запись «сырых» кадров ----------
// Сохраняются не только признаки, а точки глаз, радужек и лица: когда eyeFeatures улучшится, признаки
// пересчитываются по тем же записям — и видно, стало ли точнее (scripts/gaze_eval.mjs, gaze-sessions.test.mjs).
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const RAW_LANDMARKS = [...RIGHT_EYE, ...LEFT_EYE, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
  1, 4, 6, 10, 152, 168, 234, 454];
export const BLEND_KEYS = ["eyeBlinkLeft", "eyeBlinkRight", ...LOOK, "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight"];
function r4(v) { return Math.round(v * 1e4) / 1e4; }
function mean(a) { return a.reduce((s, v) => s + v, 0) / (a.length || 1); }

/** Кадр в компактном виде: точки (x, y подряд), коэффициенты глаз, матрица положения головы 4×4 (если есть). */
export function packFrame(lm, blend = {}, matrix = null) {
  const out = { lm: RAW_LANDMARKS.flatMap((i) => [r4(lm[i].x), r4(lm[i].y)]), b: BLEND_KEYS.map((k) => r4(blend[k] ?? 0)) };
  if (matrix && matrix.length >= 16) out.m = Array.from(matrix).slice(0, 16).map(r4);
  return out;
}

/** Обратно: 478 точек (заполнены только записанные) и коэффициенты — как их ждёт eyeFeatures. */
export function unpackFrame(fr, { landmarks = RAW_LANDMARKS, blend = BLEND_KEYS } = {}) {
  const lm = new Array(478);
  landmarks.forEach((idx, k) => { lm[idx] = { x: fr.lm[2 * k], y: fr.lm[2 * k + 1] }; });
  return { lm, blend: Object.fromEntries(blend.map((key, j) => [key, fr.b[j]])), matrix: fr.m || null };
}

// ---------- оценка записанной калибровки ----------
/** Примеры записи: признаки пересчитываются из «сырых» точек текущей gazeFeatures (или features из opts).
 *  Кадры скана (старые записи, до v3) помечены scan — в обучение и проверку они не идут. */
export function sessionSamples(session, { features = gazeFeatures } = {}) {
  const out = [];
  for (const fr of session.frames) {
    const { lm, blend, matrix } = unpackFrame(fr, session);
    const f = features(lm, blend, matrix);
    const pt = session.points[fr.p];
    if (f && pt) out.push({ f, x: pt.x, y: pt.y, check: pt.check, scan: Boolean(pt.scan), point: fr.p, t: fr.t });
  }
  return out;
}

const groupByPoint = (rows) => { const g = new Map(); rows.forEach((r) => { if (!g.has(r.point)) g.set(r.point, []); g.get(r.point).push(r); }); return [...g.values()]; };

/** Учимся на точках калибровки, проверяем на проверочных (как в приложении) и «по одной точке на проверку»
 *  (каждая точка калибровки по очереди убирается из обучения). Ошибка — по среднему предсказанию на точке, px;
 *  jitterPx — разброс предсказаний внутри точки; livePx — проверочные точки как поток нажатий щипком: после
 *  каждого — поправка сдвига (AdaptiveGaze.learn), так считается точность в работе. */
export function evaluateSession(session, { lambda = 1, features = gazeFeatures, alpha = LIVE_ALPHA } = {}) {
  const S = sessionSamples(session, { features }).filter((r) => !r.scan);
  const { w, h } = session.screen;
  const fitOn = (rows) => { const m = new SplitModel({ lambda }); rows.forEach((r) => m.add(r.f, r.x, r.y)); return m.fit(); };
  const pointError = (m, rows) => {
    const preds = rows.map((r) => m.predict(r.f));
    const mx = mean(preds.map((q) => q.x)), my = mean(preds.map((q) => q.y));
    return { err: Math.hypot((mx - rows[0].x) * w, (my - rows[0].y) * h),
      jitter: mean(preds.map((q) => Math.hypot((q.x - mx) * w, (q.y - my) * h))) };
  };
  const train = S.filter((r) => !r.check), test = S.filter((r) => r.check);
  const round = (v) => (v === null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
  if (groupByPoint(train).length < 4) return { frames: S.length, points: groupByPoint(train).length, errorPx: null, looPx: null, jitterPx: null, livePx: null, perPoint: [] };
  const m = fitOn(train);
  const perPoint = groupByPoint(test).map((rows) => ({ x: rows[0].x, y: rows[0].y, ...pointError(m, rows) }));
  const loo = groupByPoint(train).map((rows) => pointError(fitOn(train.filter((r) => r.point !== rows[0].point)), rows).err);
  let livePx = null;
  if (perPoint.length > 1) {
    const ad = new AdaptiveGaze({ base: train.map((r) => [r.f, r.x, r.y]), lambda, alpha });
    const errs = [];
    groupByPoint(test).forEach((rows, k) => {
      const mid = rows.slice(Math.floor(rows.length / 3), Math.floor(rows.length / 3) + 6);   // ~250 мс, как при щипке
      const f = mid[0].f.map((_, j) => mean(mid.map((r) => r.f[j])));
      const p = ad.predict(f);
      if (k > 0) errs.push(Math.hypot((p.x - rows[0].x) * w, (p.y - rows[0].y) * h));
      ad.learn(f, rows[0].x, rows[0].y);
    });
    livePx = round(mean(errs));
  }
  return {
    frames: S.length, points: groupByPoint(train).length + groupByPoint(test).length,
    errorPx: perPoint.length ? round(mean(perPoint.map((q) => q.err))) : null,
    looPx: round(mean(loo)),
    jitterPx: round(mean([...perPoint.map((q) => q.jitter), ...groupByPoint(train).map((rows) => pointError(m, rows).jitter)])),
    livePx,
    perPoint: perPoint.map((q) => ({ x: q.x, y: q.y, err: Math.round(q.err), jitter: Math.round(q.jitter) })),
  };
}

/** Проверка нажатий из журнала (Jarvis/Gaze/usage) моделью калибровки: насколько взгляд промахивался мимо цели;
 *  learn — как в приложении: после каждого нажатия поправка сдвига. */
export function evaluateUsage(session, usage, { lambda = 1, features = gazeFeatures, learn = false, alpha = LIVE_ALPHA } = {}) {
  const base = sessionSamples(session, { features }).filter((r) => !r.check && !r.scan).map((r) => [r.f, r.x, r.y]);
  const ad = new AdaptiveGaze({ base, lambda, alpha });
  const { w, h } = usage.screen;
  const errs = [];
  for (const c of usage.clicks) {
    const { lm, blend, matrix } = unpackFrame(c, usage);
    const f = features(lm, blend, matrix);
    if (!f || f.length !== base[0]?.[0].length) continue;
    const p = ad.predict(f);
    const lx = c.label.x / w, ly = c.label.y / h;
    errs.push(Math.hypot((p.x - lx) * w, (p.y - ly) * h));
    if (learn) ad.learn(f, lx, ly);
  }
  return { clicks: errs.length, errorPx: errs.length ? Math.round(mean(errs) * 10) / 10 : null };
}

/** Сила магнита: 0 — выключен (цель — только то, что прямо под взглядом), 1 — слабый, 2 — средний, 3 — сильный. */
export const MAGNET_LEVELS = ["выкл", "слабый", "средний", "сильный"];
export const DEFAULT_MAGNET = 1;
/** Радиус магнита по точности калибровки и силе: чем точнее взгляд, тем меньше «прилипает». */
export function snapRadius(errorPx, level = DEFAULT_MAGNET) {
  const e = errorPx ?? 90;
  const [k, lo, hi] = [[0, 10, 10], [0.5, 20, 50], [0.8, 28, 80], [1.2, 48, 150]][Math.max(0, Math.min(3, level))];
  return Math.round(Math.max(lo, Math.min(hi, e * k)));
}

// ---------- взгляд и щипок — синхронно ----------
/** Какую цель нажимает щипок. Взгляд и рука расходятся во времени (Pfeuffer и др., «Design Principles & Issues
 *  for Gaze and Pinch Interaction»; GazeHandSync):
 *   — «поздний щипок»: посмотрел на цель, решил нажать — и глаза уже ушли дальше, пока пальцы сводились
 *     (плюс камера видит щипок с опозданием на кадр-два). Поэтому берём не взгляд в момент щипка, а последнюю
 *     устойчивую фиксацию за lookbackMs до него — цель, на которой взгляд простоял дольше всего;
 *   — «ранний щипок»: пальцы сведены раньше, чем взгляд доехал до цели. Тогда ждём цель, на которой взгляд
 *     остановится в течение earlyMs после начала щипка.
 *  Признаки для поправки курсора берутся по кадрам этой фиксации, а не по тому, куда взгляд смотрел позже. */
export class GazeSync {
  constructor({ lookbackMs = 450, earlyMs = 350, minDwellMs = 90, keepMs = 1200 } = {}) {
    Object.assign(this, { lookbackMs, earlyMs, minDwellMs, keepMs });
    this.log = [];        // { ts, id, target, f, pt } — кадры взгляда
    this.pinchAt = null;
  }

  /** Кадр взгляда: target — цель под взглядом ({ id, … } или null), f — признаки, pt — точка модели (px). */
  push(ts, target, f = null, pt = null) {
    this.log.push({ ts, id: target ? target.id : null, target, f, pt });
    while (this.log.length && ts - this.log[0].ts > this.keepMs) this.log.shift();
  }

  /** Фиксации в окне [from, to]: подряд идущие кадры на одной цели. */
  fixations(from, to) {
    const out = [];
    let cur = null, prev = null;
    for (const e of this.log) {
      if (e.ts < from || e.ts > to) continue;
      const dt = prev === null ? 0 : Math.min(120, e.ts - prev);
      prev = e.ts;
      if (e.id === null) { cur = null; continue; }
      if (!cur || cur.id !== e.id) { cur = { id: e.id, target: e.target, ms: 0, end: e.ts, frames: [] }; out.push(cur); }
      else cur.ms += dt;
      cur.end = e.ts; cur.target = e.target; cur.frames.push(e);
    }
    return out.filter((x) => x.ms >= this.minDwellMs);
  }

  /** Пальцы сведены. */
  pinchStart(ts) { this.pinchAt = ts; }

  /** Щипок оказался нажатием (пальцы разведены): { target, f, pt, kind: "fixation" | "early" } или null. */
  resolve(ts) {
    const at = this.pinchAt ?? ts;
    this.pinchAt = null;
    const pack = (fx, kind) => {
      const fr = fx.frames.filter((e) => e.f);
      const avg = (get) => fr[0] && get(fr[0]).map((_, j) => fr.reduce((s, e) => s + get(e)[j], 0) / fr.length);
      return { target: fx.target, kind, ms: fx.ms, f: fr.length ? avg((e) => e.f) : null,
        pt: fr.length && fr[0].pt ? { x: mean(fr.map((e) => e.pt.x)), y: mean(fr.map((e) => e.pt.y)) } : null };
    };
    // до щипка: самая долгая фиксация; при равных — более поздняя
    const before = this.fixations(at - this.lookbackMs, at).sort((a, b) => b.ms - a.ms || b.end - a.end)[0];
    if (before) return pack(before, "fixation");
    // взгляд ещё ехал: первая фиксация после начала щипка
    const after = this.fixations(at, Math.min(ts, at + this.earlyMs))[0];
    return after ? pack(after, "early") : null;
  }
}
