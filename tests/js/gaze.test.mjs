// Управление взглядом: признаки по точкам лица, калибровка, модель, сглаживание, магнит. node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import { CAL_POINTS, CHECK_POINTS, Calibration, FACE, GazeModel, OneEuro2D, eyeFeatures, pickTarget, snapRadius,
  targetDistance } from "../../jarvis/webapp/static/gaze.js";

// Детерминированный «шум», чтобы тесты не мигали.
function rng(seed = 7) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
}

/** Синтетическое лицо: смотрит в точку экрана (sx, sy) в долях. Камера над экраном и кадр не отзеркален:
 *  взгляд вправо по экрану сдвигает радужки влево в кадре. noise — дрожание точек MediaPipe. */
export function face(sx, sy, { noise = 0, rand = rng(), head = 0 } = {}) {
  const gx = -(sx - 0.5) * 1.6, gy = (sy - 0.5) * 1.6 + 0.3;
  const n = () => rand() * noise;
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x: x + n(), y: y + n(), z: 0 }; };
  set(FACE.left, 0.4 + head, 0.45); set(FACE.right, 0.6 + head, 0.45);
  set(FACE.top, 0.5 + head, 0.33); set(FACE.chin, 0.5 + head, 0.62); set(FACE.nose, 0.5 + head * 1.4, 0.47);
  set(FACE.rOuter, 0.43 + head, 0.42); set(FACE.rInner, 0.47 + head, 0.42);
  set(FACE.lOuter, 0.57 + head, 0.42); set(FACE.lInner, 0.53 + head, 0.42);
  set(FACE.rIris, 0.45 + head + gx * 0.008, 0.42 + gy * 0.005);
  set(FACE.lIris, 0.55 + head + gx * 0.008, 0.42 + gy * 0.005);
  const blend = {
    eyeLookInLeft: Math.max(0, -gx), eyeLookOutLeft: Math.max(0, gx), eyeLookInRight: Math.max(0, gx),
    eyeLookOutRight: Math.max(0, -gx), eyeLookUpLeft: Math.max(0, -gy), eyeLookUpRight: Math.max(0, -gy),
    eyeLookDownLeft: Math.max(0, gy), eyeLookDownRight: Math.max(0, gy), eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05,
  };
  return { lm, blend };
}

test("признаки взгляда: радужка внутри глаза, моргание и отсутствие лица", () => {
  const center = eyeFeatures(face(0.5, 0.5).lm, face(0.5, 0.5).blend);
  const right = eyeFeatures(face(0.9, 0.5).lm, face(0.9, 0.5).blend);
  const down = eyeFeatures(face(0.5, 0.9).lm, face(0.5, 0.9).blend);
  assert.equal(center.length, 17);
  assert.ok(center.every(Number.isFinite));
  assert.ok(right[0] < center[0] && right[2] < center[2]);               // взгляд вправо — обе радужки влево в кадре
  assert.ok(down[1] > center[1] && down[3] > center[3]);                 // вниз — ниже линии уголков
  assert.equal(eyeFeatures(face(0.5, 0.5).lm, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 }), null);
  assert.ok(eyeFeatures(face(0.5, 0.5).lm, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1 }));   // подмигнул — глаз ещё есть
  assert.equal(eyeFeatures(null), null);
  assert.equal(eyeFeatures(face(0.5, 0.5).lm.slice(0, 468)), null);      // без радужек взгляд не понять
});

test("модель: учится на точках калибровки и угадывает новые, сохраняется и загружается", () => {
  const rand = rng(3);
  const m = new GazeModel();
  for (const [x, y] of CAL_POINTS) {
    for (let k = 0; k < 20; k++) { const f = face(x, y, { noise: 0.0004, rand }); m.add(eyeFeatures(f.lm, f.blend), x, y); }
  }
  m.fit();
  for (const [x, y] of [...CHECK_POINTS, [0.2, 0.8], [0.85, 0.15]]) {
    const f = face(x, y, { noise: 0.0004, rand });
    const p = m.predict(eyeFeatures(f.lm, f.blend));
    assert.ok(Math.hypot(p.x - x, p.y - y) < 0.06, `(${x}, ${y}) → (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  }
  const again = GazeModel.fromJSON(JSON.parse(JSON.stringify(m)));
  const f = face(0.3, 0.6);
  assert.deepEqual(again.predict(eyeFeatures(f.lm, f.blend)), m.predict(eyeFeatures(f.lm, f.blend)));
  assert.throws(() => new GazeModel().fit(), /мало точек/);
});

test("калибровка: точки по очереди, пока лица нет — время стоит, в конце — точность в пикселях", () => {
  const rand = rng(11);
  const cal = new Calibration({ screen: { w: 390, h: 844 } });
  assert.deepEqual(cal.counter, { n: 1, total: CAL_POINTS.length + CHECK_POINTS.length });
  let ts = 0;
  // лица нет 2 с — первая точка не проходит сама
  for (; ts < 2000; ts += 33) cal.feed(null, ts);
  assert.equal(cal.counter.n, 1);
  assert.equal(cal.progress, 0);
  assert.equal(cal.faceLost(ts), false);                                   // лица ещё ни разу не было
  const seen = [];
  let paused = false;
  while (!cal.done && ts < 60000) {
    const [x, y] = cal.point;
    if (!seen.length || seen.at(-1) !== `${x},${y}`) seen.push(`${x},${y}`);
    const f = face(x, y, { noise: 0.0004, rand });
    cal.feed(eyeFeatures(f.lm, f.blend), ts);
    ts += 33;
    if (!paused && cal.counter.n === 3 && cal.progress > 0.3) {             // посреди точки отвернулся
      paused = true;
      const before = cal.progress;
      for (let k = 0; k < 30; k++, ts += 33) cal.feed(null, ts);
      assert.equal(cal.progress, before);
      assert.ok(cal.faceLost(ts));
    }
  }
  assert.ok(cal.done);
  assert.equal(seen.length, CAL_POINTS.length + CHECK_POINTS.length);
  assert.ok(cal.model.ready);
  assert.ok(cal.errorPx < 30, `ошибка ${cal.errorPx} px`);
  assert.ok(ts < 25000, "калибровка не должна тянуться");
  assert.equal(snapRadius(cal.errorPx), 48);                               // точный взгляд — маленький магнит
  assert.equal(snapRadius(200), 150);
  assert.equal(snapRadius(null), 108);
});

test("сглаживание: дрожание гасится, переход на другую цель — быстро", () => {
  const rand = rng(5);
  const f = new OneEuro2D();
  const raw = [], out = [];
  let ts = 0;
  for (let k = 0; k < 90; k++, ts += 33) {
    const p = { x: 200 + rand() * 60, y: 400 + rand() * 60 };
    raw.push(p.x); out.push(f.filter(p, ts).x);
  }
  const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  assert.ok(sd(out.slice(30)) * 3 < sd(raw.slice(30)), `дрожание ${sd(raw)} → ${sd(out)}`);
  let x = 0;
  for (let k = 0; k < 9; k++, ts += 33) x = f.filter({ x: 1000, y: 400 }, ts).x;   // 0,3 с на новой цели
  assert.ok(x > 200 + 0.85 * 800, `за 0,3 с дошёл до ${x}`);
});

test("магнит: ближайшая цель в радиусе, кнопка целиком, без прыжков между соседями", () => {
  const btn = { id: "save", x: 100, y: 100, w: 120, h: 40 };
  const node = { id: "Ideas/A.md", x: 300, y: 300 };
  const near = { id: "Ideas/B.md", x: 340, y: 300 };
  assert.equal(targetDistance({ x: 150, y: 110 }, btn), 0);                 // внутри кнопки
  assert.equal(targetDistance({ x: 180, y: 100 }, btn), 20);
  assert.equal(pickTarget({ x: 170, y: 140 }, [btn, node]).id, "save");
  assert.equal(pickTarget({ x: 600, y: 600 }, [btn, node]), null);          // далеко от всего — курсор свободен
  assert.equal(pickTarget({ x: 315, y: 300 }, [node, near]).id, "Ideas/A.md");
  // держится за текущую, пока соседняя не ближе явно
  assert.equal(pickTarget({ x: 325, y: 300 }, [node, near], "Ideas/A.md").id, "Ideas/A.md");
  assert.equal(pickTarget({ x: 345, y: 300 }, [node, near], "Ideas/A.md").id, "Ideas/B.md");
  assert.equal(pickTarget({ x: 300, y: 395 }, [node], "Ideas/A.md", 70).id, "Ideas/A.md");   // чуть дальше радиуса — держится
  // строки списка ниже 24 px: взгляд перешёл внутрь соседней строки — курсор переходит, а не застревает
  const row1 = { id: "row1", x: 900, y: 188, w: 500, h: 27 }, row2 = { id: "row2", x: 900, y: 215, w: 500, h: 27 };
  assert.equal(pickTarget({ x: 910, y: 194 }, [row1, row2], "row2").id, "row1");
  assert.equal(pickTarget({ x: 910, y: 205 }, [row1, row2], "row2").id, "row2");
  // кнопка внутри строки (меньше) важнее строки
  const inner = { id: "link", x: 900, y: 188, w: 30, h: 16 };
  assert.equal(pickTarget({ x: 905, y: 190 }, [row1, inner]).id, "link");
  assert.equal(pickTarget({ x: 300, y: 420 }, [node], "Ideas/A.md", 70), null);
});
