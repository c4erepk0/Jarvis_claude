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
export const FEATURE_VERSION = 2;

/** Признаки взгляда с учётом положения головы относительно камеры (матрица MediaPipe 4×4 по столбцам, см).
 *  Телефон сдвинули или наклонили — голова относительно камеры другая, и прежняя калибровка «съезжала».
 *  Здесь всё переводится в плоскость экрана (она же плоскость камеры, z = 0): куда упирается луч «вперёд из
 *  головы» (Hx, Hy) плюс поворот глаз, умноженный на расстояние до экрана, в осях головы (r — вправо, u — вверх).
 *  Модель сверху — линейная: она лишь переводит сантиметры этой плоскости в пиксели экрана, поэтому калибровка
 *  в одной позе переносится на другие. Нет матрицы — прежние признаки (eyeFeatures). */
export function gazeFeatures(lm, blend = {}, matrix = null) {
  const e = eyeFeatures(lm, blend);
  if (!e || !matrix || matrix.length < 16) return e;
  const m = matrix;
  const r = [m[0], m[1], m[2]], u = [m[4], m[5], m[6]], f = [m[8], m[9], m[10]], t = [m[12], m[13], m[14]];
  if (!(t[2] < -5) || !(f[2] > 0.2)) return e;            // поза неправдоподобна (лицо за камерой, отвернулся)
  const d = -t[2];
  const lam = d / f[2];
  const hx = t[0] + lam * f[0], hy = t[1] + lam * f[1];   // куда смотрит голова, см от камеры
  const eh = (e[0] + e[2]) / 2, ev = (e[1] + e[3]) / 2;   // радужки: вдоль глаза и поперёк
  const b = (k) => blend[k] ?? 0;
  const bh = (b("eyeLookOutLeft") - b("eyeLookInLeft") + b("eyeLookInRight") - b("eyeLookOutRight")) / 2;
  const bv = (b("eyeLookUpLeft") + b("eyeLookUpRight") - b("eyeLookDownLeft") - b("eyeLookDownRight")) / 2;
  return [hx, hy,
    d * eh * r[0], d * eh * r[1], d * ev * u[0], d * ev * u[1],     // поворот глаз по радужкам
    d * bh * r[0], d * bh * r[1], d * bv * u[0], d * bv * u[1],     // и по коэффициентам взгляда
    d * r[0], d * r[1], d * u[0], d * u[1],                         // постоянный сдвиг взгляда (у каждого свой)
    r[0], r[1], u[0], u[1]];                                        // глаза — не в центре головы
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
// Скан лица: смотрите на точку и водите телефоном — модель учится отличать «телефон сдвинули» от «перевели
// взгляд». Без скана калибровка верна только в той позе, в которой её прошли.
// Точки скана — в разных частях экрана: так модель видит, как движение телефона сказывается на взгляде и вверху,
// и внизу. Длительность важнее числа точек: на симуляции 2 точки по 6–7 с дают при сдвиге телефона ~30 px против ~60.
export const CALIBRATIONS = {
  quick: { points: CAL_POINTS, scan: [[0.5, 0.25], [0.5, 0.75]], check: CHECK_POINTS, settleMs: 650, sampleMs: 850 },
  big: { points: BIG_POINTS, scan: [[0.5, 0.2], [0.2, 0.6], [0.8, 0.8]], check: BIG_CHECK, settleMs: 600, sampleMs: 1000 },
};
/** Скан: сколько поводить телефоном (размах позы головы относительно камеры), сколько он длится и как весит. */
export const SCAN = { need: { x: 8, y: 8, z: 12, roll: 20 }, minMs: 6000, maxMs: 16000, noPoseMs: 5000, weight: 1, maxFrames: 150 };
export const SCAN_AXES = { x: "влево-вправо", y: "вверх-вниз", z: "ближе-дальше", roll: "наклон" };

/** Поза головы относительно камеры по матрице MediaPipe: сдвиг (см), расстояние (см), повороты (градусы). */
export function headPose(m) {
  if (!m || m.length < 16) return null;
  const deg = (a) => (a * 180) / Math.PI;
  return { x: m[12], y: m[13], z: -m[14], yaw: deg(Math.atan2(m[8], m[10])), pitch: deg(Math.atan2(m[9], m[10])),
    roll: deg(Math.atan2(m[1], m[0])) };
}

export class Calibration {
  /** screen — { w, h } в px (для точности в пикселях); settleMs — глаз доводится до точки, sampleMs — замер;
   *  record — сохранять «сырые» кадры (packFrame) для анализа: toSession() отдаёт их одной записью. */
  constructor({ screen = { w: 390, h: 844 }, mode = "quick", points, scan, check, settleMs, sampleMs, lambda = 1, record = false,
    maxPerPoint = 30, scanOpts = SCAN } = {}) {
    const preset = CALIBRATIONS[mode] || CALIBRATIONS.quick;
    points ??= preset.points; scan ??= preset.scan; check ??= preset.check;
    settleMs ??= preset.settleMs; sampleMs ??= preset.sampleMs;
    Object.assign(this, { screen, mode, settleMs, sampleMs, lambda, record, maxPerPoint, scanOpts });
    this.frames = [];       // записанные кадры: { t, p (номер точки), lm, b, m }
    this.perPoint = 0;
    this.t0 = null;
    this.list = [...points.map((p) => ({ p, check: false })), ...scan.map((p) => ({ p, check: false, scan: true })),
      ...check.map((p) => ({ p, check: true }))];
    this.fitCount = points.length + scan.length;
    this.span = null;       // размах позы на текущем скане: { x: [min, max], … }
    this.poseRange = null;  // в каких позах прошла калибровка — вне их точность падает
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
  get scanning() { return !this.done && Boolean(this.list[this.i].scan); }
  get progress() {
    if (!this.scanning) return Math.min(1, this.time / (this.settleMs + this.sampleMs));
    const o = this.scanOpts, c = this.coverage;
    return c ? Math.min(1, Math.min(c.total, 1) * 0.85 + 0.15 * Math.min(1, this.time / (o.minMs + this.settleMs)))
      : Math.min(1, this.time / (o.noPoseMs + this.settleMs));
  }
  /** Насколько поводили телефоном на скане: по каждой оси 0…1 и в среднем (null — поза головы неизвестна). */
  get coverage() {
    if (!this.span) return null;
    const out = {};
    for (const [k, need] of Object.entries(this.scanOpts.need)) out[k] = Math.min(1, (this.span[k][1] - this.span[k][0]) / need);
    out.total = Object.keys(this.scanOpts.need).reduce((s, k) => s + out[k], 0) / Object.keys(this.scanOpts.need).length;
    return out;
  }
  get counter() { return { n: Math.min(this.i + 1, this.list.length), total: this.list.length }; }
  /** Средняя ошибка на проверочных точках, px. */
  get errorPx() { return this.errors.length ? this.errors.reduce((s, e) => s + e, 0) / this.errors.length : null; }
  faceLost(ts, ms = 800) { return this.faceSeenAt === null ? false : ts - this.faceSeenAt > ms; }

  /** Кадр с камеры: f — eyeFeatures (null — лица не видно, время точки стоит); raw — packFrame того же кадра. */
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
    const { p, check, scan } = this.list[this.i];
    const pose = raw?.m ? headPose(raw.m) : null;
    if (pose) {
      this.poseRange ??= {};
      for (const k of ["x", "y", "z", "yaw", "pitch", "roll"]) {
        const r = this.poseRange[k] ??= [pose[k], pose[k]];
        r[0] = Math.min(r[0], pose[k]); r[1] = Math.max(r[1], pose[k]);
      }
    }
    if (this.time >= this.settleMs) {
      if (check) this.got.push(this.model.predict(f));
      else this.model.add(f, p[0], p[1], scan ? this.scanOpts.weight : 1);
      if (scan && pose) {
        this.span ??= {};
        for (const k of Object.keys(this.scanOpts.need)) {
          const r = this.span[k] ??= [pose[k], pose[k]];
          r[0] = Math.min(r[0], pose[k]); r[1] = Math.max(r[1], pose[k]);
        }
      }
      const cap = scan ? this.scanOpts.maxFrames : this.maxPerPoint;
      if (this.record && raw && this.perPoint < cap) {
        this.frames.push({ t: Math.round(ts - this.t0), p: this.i, ...raw });
        this.perPoint += 1;
      }
    }
    if (scan) {
      // скан идёт, пока не поводили телефоном по всем осям (но не меньше minMs и не дольше maxMs)
      const o = this.scanOpts, c = this.coverage, t = this.time - this.settleMs;
      const enough = c ? t >= o.minMs && c.total >= 0.999 : t >= o.noPoseMs;
      if (!enough && t < o.maxMs) return;
      this.span = null;
    } else if (this.time < this.settleMs + this.sampleMs) return;
    if (check) {
      const m = this.got.reduce((s, q) => ({ x: s.x + q.x / this.got.length, y: s.y + q.y / this.got.length }), { x: 0, y: 0 });
      this.errors.push(Math.hypot((m.x - p[0]) * this.screen.w, (m.y - p[1]) * this.screen.h));
      this.got = [];
    }
    this.i += 1;
    this.time = 0;
    this.perPoint = 0;
    if (this.i === this.fitCount) this.model.fit();
  }

  /** Модель, которая доучивается в работе, — на кадрах этой калибровки (не больше 400, равномерно). */
  adaptive(opts = {}) {
    const all = this.model.samples;
    const step = Math.max(1, Math.ceil(all.length / 400));
    return new AdaptiveGaze({ base: all.filter((_, k) => k % step === 0).map(([f, x, y, w]) => [f.map(r4), x, y, w ?? 1]),
      lambda: this.lambda, range: this.poseRange, ...opts });
  }

  /** Запись калибровки для хранилища (Jarvis/Gaze/sessions): точки, «сырые» кадры, итог. */
  toSession({ created = new Date().toISOString(), device = "" } = {}) {
    return {
      kind: "jarvis-gaze-session", version: 1, created, device, mode: this.mode,
      screen: { w: Math.round(this.screen.w), h: Math.round(this.screen.h) },
      settleMs: this.settleMs, sampleMs: this.sampleMs, lambda: this.lambda,
      landmarks: RAW_LANDMARKS, blend: BLEND_KEYS,
      featureVersion: FEATURE_VERSION, scan: this.scanOpts,
      points: this.list.map(({ p, check, scan }) => ({ x: p[0], y: p[1], check, ...(scan ? { scan: true } : {}) })),
      frames: this.frames,
      result: { errorPx: this.errorPx === null ? null : Math.round(this.errorPx * 10) / 10, errors: this.errors.map((e) => Math.round(e)) },
    };
  }
}

// ---------- доучивание в работе ----------
/** Модель, которая доучивается на нажатиях: нажали щипком по цели — значит, смотрели на неё; такой пример
 *  весит как несколько кадров калибровки. Хранятся последние limit нажатий — поза и свет со временем меняются.
 *  Заодно считает точность в работе: насколько взгляд промахивался мимо целей последних нажатий. */
export class AdaptiveGaze {
  /** range — в каких позах головы прошла калибровка (headPose: min/max по осям); featureVersion — признаки. */
  constructor({ base = [], usage = [], lambda = 1, usageWeight = 6, limit = 60, range = null, featureVersion = FEATURE_VERSION } = {}) {
    Object.assign(this, { base, usage, lambda, usageWeight, limit, range, featureVersion });
    this.refit();
  }

  /** Поза далеко за пределами калибровки — точность падает: голограмма подскажет пройти скан заново. */
  outOfRange(pose, slack = { x: 4, y: 4, z: 8, roll: 12 }) {
    if (!pose || !this.range) return false;
    return Object.entries(slack).some(([k, s]) => this.range[k] && (pose[k] < this.range[k][0] - s || pose[k] > this.range[k][1] + s));
  }

  refit() {
    const m = new GazeModel({ lambda: this.lambda });
    for (const [f, x, y, w] of this.base) m.add(f, x, y, w ?? 1);
    for (const [f, x, y] of this.usage) m.add(f, x, y, this.usageWeight);
    this.model = m.samples.length >= 3 ? m.fit() : null;
  }

  get ready() { return Boolean(this.model); }
  predict(f) { return this.model.predict(f); }

  /** Нажатие по цели: f — признаки, когда свели пальцы; x, y — где цель (доли экрана); errPx — промах взгляда. */
  learn(f, x, y, errPx = null) {
    this.usage.push([f.map(r4), r4(x), r4(y), errPx === null ? null : Math.round(errPx)]);
    if (this.usage.length > this.limit) this.usage.shift();
    this.refit();
  }

  /** Средний промах взгляда по последним n нажатиям, px (null — нажатий ещё не было). */
  liveErrorPx(n = 20) {
    const e = this.usage.slice(-n).map((u) => u[3]).filter((v) => v !== null && v !== undefined);
    return e.length ? Math.round(e.reduce((a, b) => a + b, 0) / e.length) : null;
  }

  toJSON() {
    return { featureVersion: this.featureVersion, lambda: this.lambda, usageWeight: this.usageWeight, limit: this.limit,
      range: this.range, base: this.base, usage: this.usage };
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
/** Примеры записи: признаки пересчитываются из «сырых» точек текущей gazeFeatures (или features из opts). */
export function sessionSamples(session, { features = gazeFeatures } = {}) {
  const out = [];
  for (const fr of session.frames) {
    const { lm, blend, matrix } = unpackFrame(fr, session);
    const f = features(lm, blend, matrix);
    const pt = session.points[fr.p];
    if (f && pt) out.push({ f, x: pt.x, y: pt.y, check: pt.check, scan: Boolean(pt.scan), point: fr.p, t: fr.t });
  }
  const len = out.length ? Math.max(...out.map((r) => r.f.length)) : 0;   // кадры без позы головы — другие признаки
  return out.filter((r) => r.f.length === len);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

/** Учимся на точках калибровки, проверяем на проверочных (как в приложении) и «по одной точке на проверку»
 *  (каждая точка калибровки по очереди убирается из обучения) — так видно и точность, и устойчивость.
 *  Ошибка — по среднему предсказанию на точке, px; jitterPx — разброс предсказаний внутри точки. */
export function evaluateSession(session, { lambda = 1, features = gazeFeatures } = {}) {
  const S = sessionSamples(session, { features });
  const { w, h } = session.screen;
  const sw = session.scan?.weight ?? SCAN.weight;
  const fitOn = (rows) => { const m = new GazeModel({ lambda }); rows.forEach((r) => m.add(r.f, r.x, r.y, r.scan ? sw : 1)); return m.fit(); };
  const pointError = (m, rows) => {
    const preds = rows.map((r) => m.predict(r.f));
    const mx = mean(preds.map((q) => q.x)), my = mean(preds.map((q) => q.y));
    return { err: Math.hypot((mx - rows[0].x) * w, (my - rows[0].y) * h),
      jitter: mean(preds.map((q) => Math.hypot((q.x - mx) * w, (q.y - my) * h))) };
  };
  const byPoint = (rows) => { const g = new Map(); rows.forEach((r) => { if (!g.has(r.point)) g.set(r.point, []); g.get(r.point).push(r); }); return [...g.values()]; };
  const train = S.filter((r) => !r.check), test = S.filter((r) => r.check);
  const grid = train.filter((r) => !r.scan), scan = train.filter((r) => r.scan);
  if (byPoint(grid).length < 4) return { frames: S.length, points: byPoint(train).length, errorPx: null, looPx: null, jitterPx: null, perPoint: [] };
  const m = fitOn(train);
  const perPoint = byPoint(test).map((rows) => ({ x: rows[0].x, y: rows[0].y, ...pointError(m, rows) }));
  const loo = byPoint(grid).map((rows) => pointError(fitOn(train.filter((r) => r.point !== rows[0].point)), rows).err);
  const round = (v) => (v === null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
  // устойчивость к движению телефона: учимся на первой половине каждого скана, проверяем на второй (другие позы);
  // и без скана вовсе — так видно, что он даёт
  const frameErr = (model, rows) => mean(rows.map((r) => { const q = model.predict(r.f); return Math.hypot((q.x - r.x) * w, (q.y - r.y) * h); }));
  let movePx = null, moveNoScanPx = null;
  if (scan.length) {
    const halves = byPoint(scan).map((rows) => { const s = [...rows].sort((a, b) => a.t - b.t); const k = Math.floor(s.length / 2); return [s.slice(0, k), s.slice(k)]; });
    movePx = round(frameErr(fitOn([...grid, ...halves.flatMap((x) => x[0])]), halves.flatMap((x) => x[1])));
    moveNoScanPx = round(frameErr(fitOn(grid), scan));
  }
  return {
    frames: S.length, points: byPoint(train).length + byPoint(test).length,
    errorPx: perPoint.length ? round(mean(perPoint.map((q) => q.err))) : null,
    looPx: round(mean(loo)),
    jitterPx: round(mean([...perPoint.map((q) => q.jitter), ...byPoint(grid).map((rows) => pointError(m, rows).jitter)])),
    movePx, moveNoScanPx,
    perPoint: perPoint.map((q) => ({ x: q.x, y: q.y, err: Math.round(q.err), jitter: Math.round(q.jitter) })),
  };
}

/** Проверка нажатий из журнала (Jarvis/Gaze/usage) моделью калибровки: насколько взгляд промахивался мимо цели. */
export function evaluateUsage(session, usage, { lambda = 1, features = gazeFeatures, learn = false, usageWeight = 6 } = {}) {
  const sw = session.scan?.weight ?? SCAN.weight;
  const base = sessionSamples(session, { features }).filter((r) => !r.check).map((r) => [r.f, r.x, r.y, r.scan ? sw : 1]);
  const ad = new AdaptiveGaze({ base, lambda, usageWeight });
  const { w, h } = usage.screen;
  const errs = [];
  for (const c of usage.clicks) {
    const { lm, blend, matrix } = unpackFrame(c, usage);
    const f = features(lm, blend, matrix);
    if (!f || f.length !== base[0]?.[0].length) continue;
    const p = ad.predict(f);
    const lx = c.label.x / w, ly = c.label.y / h;
    errs.push(Math.hypot((p.x - lx) * w, (p.y - ly) * h));
    if (learn) ad.learn(f, lx, ly);            // как в приложении: после нажатия модель доучивается
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
