// Синтетическое лицо и записанная на нём калибровка — для тестов взгляда (не тест сам по себе: нет .test в имени).
import { Calibration, FACE, gazeFeatures, packFrame } from "../../jarvis/webapp/static/gaze.js";

/** Детерминированный «шум», чтобы тесты не мигали. */
export function rng(seed = 7) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
}

/** Лицо, которое смотрит в точку экрана (sx, sy) в долях. Камера над экраном, кадр не отзеркален: взгляд вправо
 *  по экрану сдвигает радужки влево в кадре. noise — дрожание точек MediaPipe, head — сдвиг головы в кадре,
 *  irisBias — систематический сдвиг радужек (другой свет, очки): модель начинает промахиваться. */
export function face(sx, sy, { noise = 0, rand = rng(), head = 0, irisBias = 0 } = {}) {
  const gx = -(sx - 0.5) * 1.6, gy = (sy - 0.5) * 1.6 + 0.3;
  const n = () => rand() * noise;
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x: x + n(), y: y + n(), z: 0 }; };
  set(FACE.left, 0.4 + head, 0.45); set(FACE.right, 0.6 + head, 0.45);
  set(FACE.top, 0.5 + head, 0.33); set(FACE.chin, 0.5 + head, 0.62); set(FACE.nose, 0.5 + head * 1.4, 0.47);
  set(FACE.rOuter, 0.43 + head, 0.42); set(FACE.rInner, 0.47 + head, 0.42);
  set(FACE.lOuter, 0.57 + head, 0.42); set(FACE.lInner, 0.53 + head, 0.42);
  set(FACE.rIris, 0.45 + head + gx * 0.008 + irisBias, 0.42 + gy * 0.005);
  set(FACE.lIris, 0.55 + head + gx * 0.008 + irisBias, 0.42 + gy * 0.005);
  const blend = {
    eyeLookInLeft: Math.max(0, -gx), eyeLookOutLeft: Math.max(0, gx), eyeLookInRight: Math.max(0, gx),
    eyeLookOutRight: Math.max(0, -gx), eyeLookUpLeft: Math.max(0, -gy), eyeLookUpRight: Math.max(0, -gy),
    eyeLookDownLeft: Math.max(0, gy), eyeLookDownRight: Math.max(0, gy), eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05,
  };
  return { lm, blend };
}

/** Прогнать калибровку на синтетическом лице (30 кадров/с) с записью кадров. */
export function runCalibration({ mode = "quick", noise = 0.0004, seed = 11, screen = { w: 390, h: 844 } } = {}) {
  const rand = rng(seed);
  const cal = new Calibration({ mode, screen, record: true });
  let ts = 0;
  while (!cal.done && ts < 120000) {
    const [x, y] = cal.point;
    const fc = face(x, y, { noise, rand });
    cal.feed(gazeFeatures(fc.lm, fc.blend), ts, packFrame(fc.lm, fc.blend));
    ts += 33;
  }
  return { cal, ms: ts };
}

// ---------- 3D: голова, глаза, камера телефона ----------
// Как у MediaPipe: камера в начале координат, x — вправо по кадру, y — вверх, лицо — на отрицательном z (см),
// матрица положения головы — 4×4 по столбцам (сдвиг — в элементах 12…14). Экран телефона — в плоскости камеры
// (z = 0), камера над его серединой: так движение телефона — это просто другое положение головы относительно камеры.
export const PHONE = { w: 390, h: 844, cmW: 6.4, cmH: 13.8, top: 0.8 };   // экран: px, см, отступ от камеры
const FOV = (63 * Math.PI) / 180, IMG = { w: 480, h: 640 };              // вертикальный обзор, кадр портретный

/** Точка экрана (px) → точка в плоскости камеры (см). */
export function screenToCm(sx, sy, ph = PHONE) {
  return { x: (sx / ph.w - 0.5) * ph.cmW, y: -(ph.top + (sy / ph.h) * ph.cmH), z: 0 };
}

function rot({ yaw = 0, pitch = 0, roll = 0 }) {   // поворот головы, градусы: yaw — к своему левому плечу, pitch — вверх
  const [a, b, c] = [yaw, pitch, roll].map((d) => (d * Math.PI) / 180);
  const Ry = [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const Rx = [[1, 0, 0], [0, Math.cos(b), Math.sin(b)], [0, -Math.sin(b), Math.cos(b)]];   // pitch > 0 — лицо вверх
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  return mul(mul(Ry, Rx), Rz);
}
const apply = (R, v) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);
const applyT = (R, v) => [0, 1, 2].map((i) => R[0][i] * v[0] + R[1][i] * v[1] + R[2][i] * v[2]);
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };

// голова (см): x — к левому плечу человека (вправо в кадре), y — вверх, z — вперёд, к камере
const HEAD = {
  eyeR: [-3.1, 3.0, 2.0], eyeL: [3.1, 3.0, 2.0], nose: [0, 0, 5], left: [-7, 1.5, -1], right: [7, 1.5, -1],
  top: [0, 9, 1], chin: [0, -9, 1.5],
};

/** Голова в позе pose ({ x, y, z } см и yaw/pitch/roll градусы относительно камеры) смотрит в точку экрана (sx, sy).
 *  kappa — индивидуальный сдвиг взгляда, градусы; noise — дрожание точек (доля кадра), poseNoise — шум позы. */
export function face3d(sx, sy, pose, { rand = rng(), noise = 0.0008, poseNoise = 0.4, kappa = { yaw: 2, pitch: -1.5 }, ph = PHONE } = {}) {
  const n = (k = 1) => rand() * k;
  const R = rot({ yaw: (pose.yaw || 0) + n(poseNoise * 2), pitch: (pose.pitch || 0) + n(poseNoise * 2), roll: (pose.roll || 0) + n(poseNoise * 2) });
  const t = [pose.x || 0, pose.y || 0, pose.z ?? -32];
  const toCam = (p) => apply(R, p).map((c, i) => c + t[i]);
  const F = (IMG.h / 2) / Math.tan(FOV / 2);
  const project = (P) => ({ x: (IMG.w / 2 + (F * P[0]) / -P[2]) / IMG.w + n(noise), y: (IMG.h / 2 - (F * P[1]) / -P[2]) / IMG.h + n(noise), z: 0 });
  const T = screenToCm(sx, sy, ph);
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const eyes = {};
  for (const [side, E] of [["R", HEAD.eyeR], ["L", HEAD.eyeL]]) {
    const C = toCam(E);
    let g = applyT(R, norm([T.x - C[0], T.y - C[1], T.z - C[2]]));                    // взгляд в осях головы
    const ky = (kappa.yaw * Math.PI) / 180, kp = (kappa.pitch * Math.PI) / 180;
    g = norm([g[0] + ky * g[2], g[1] + kp * g[2], g[2]]);
    eyes[side] = { yaw: Math.atan2(g[0], g[2]), pitch: Math.atan2(g[1], g[2]) };
    const iris = toCam(E.map((c, i) => c + 1.2 * g[i]));
    const sgn = side === "R" ? -1 : 1;                                                // наружный уголок — от носа
    const outer = toCam([E[0] + sgn * 1.4, E[1], E[2] + 0.9]), inner = toCam([E[0] - sgn * 1.4, E[1], E[2] + 0.9]);
    const ids = side === "R" ? [FACE.rOuter, FACE.rInner, FACE.rIris] : [FACE.lOuter, FACE.lInner, FACE.lIris];
    [outer, inner, iris].forEach((P, k) => { lm[ids[k]] = project(P); });
    for (let k = 469; k <= 477; k++) if ((side === "R") === (k < 473)) lm[k] = project(iris);
  }
  for (const [key, idx] of [["nose", FACE.nose], ["left", FACE.left], ["right", FACE.right], ["top", FACE.top], ["chin", FACE.chin]]) {
    lm[idx] = project(toCam(HEAD[key]));
  }
  const look = (v, k) => Math.max(0, Math.min(1, v / k + n(0.02)));
  const yaw = (eyes.R.yaw + eyes.L.yaw) / 2, pitch = (eyes.R.pitch + eyes.L.pitch) / 2;
  const blend = {
    eyeLookOutLeft: look(yaw, 0.7), eyeLookInLeft: look(-yaw, 0.7), eyeLookInRight: look(yaw, 0.7), eyeLookOutRight: look(-yaw, 0.7),
    eyeLookUpLeft: look(pitch, 0.5), eyeLookUpRight: look(pitch, 0.5), eyeLookDownLeft: look(-pitch, 0.5), eyeLookDownRight: look(-pitch, 0.5),
    eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05,
  };
  const tn = t.map((c) => c + n(poseNoise));
  const matrix = [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, tn[0], tn[1], tn[2], 1];
  return { lm, blend, matrix };
}

/** Обычная поза: телефон в руке перед лицом, глаза — напротив верхней половины экрана, голова чуть наклонена к нему. */
export const BASE_POSE = { x: 0, y: -4, z: -32, yaw: 0, pitch: -8, roll: 0 };
/** Телефон сдвинули, наклонили, поднесли ближе или отодвинули — голова относительно камеры уже другая. */
export const MOVED_POSES = [
  { ...BASE_POSE, x: 5, yaw: 6 }, { ...BASE_POSE, x: -5, yaw: -6 }, { ...BASE_POSE, y: 2, pitch: -14 },
  { ...BASE_POSE, y: -9, pitch: 0 }, { ...BASE_POSE, z: -24 }, { ...BASE_POSE, z: -42 }, { ...BASE_POSE, roll: 15 },
  { ...BASE_POSE, roll: -12, x: 3 },
];

/** Калибровка на 3D-голове (30 кадров/с, с записью кадров) в позе pose — с небольшим естественным дрожанием. */
export function runCalibration3d({ mode = "quick", seed = 21, features = gazeFeatures, pose = BASE_POSE } = {}) {
  const rand = rng(seed);
  const cal = new Calibration({ mode, screen: { w: PHONE.w, h: PHONE.h }, record: true });
  let ts = 0;
  while (!cal.done && ts < 240000) {
    const [x, y] = cal.point;
    const p = { ...pose, x: pose.x + rand() * 0.6, y: pose.y + rand() * 0.6, yaw: pose.yaw + rand(), pitch: pose.pitch + rand() };
    const fc = face3d(x * PHONE.w, y * PHONE.h, p, { rand });
    cal.feed(features(fc.lm, fc.blend, fc.matrix), ts, packFrame(fc.lm, fc.blend, fc.matrix));
    ts += 33;
  }
  return { cal, ms: ts };
}

/** Средняя ошибка модели (px) в позе pose на 40 точках экрана. */
export function poseError(model, pose, { seed = 5, features = gazeFeatures } = {}) {
  const rand = rng(seed);
  let e = 0;
  for (let k = 0; k < 40; k++) {
    const x = 0.1 + ((k * 37) % 81) / 100, y = 0.08 + ((k * 53) % 85) / 100;
    const fc = face3d(x * PHONE.w, y * PHONE.h, pose, { rand });
    const p = model.predict(features(fc.lm, fc.blend, fc.matrix));
    e += Math.hypot((p.x - x) * PHONE.w, (p.y - y) * PHONE.h);
  }
  return e / 40;
}
