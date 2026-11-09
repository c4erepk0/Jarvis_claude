// Синтетическое лицо и записанная на нём калибровка — для тестов взгляда (не тест сам по себе: нет .test в имени).
import { Calibration, FACE, eyeFeatures, packFrame } from "../../jarvis/webapp/static/gaze.js";

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
    cal.feed(eyeFeatures(fc.lm, fc.blend), ts, packFrame(fc.lm, fc.blend));
    ts += 33;
  }
  return { cal, ms: ts };
}
