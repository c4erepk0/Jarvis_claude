// Управление взглядом: признаки по точкам лица, калибровка, модель, сглаживание, магнит. node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import { AdaptiveGaze, BIG_CHECK, BIG_POINTS, BLEND_KEYS, CAL_POINTS, CHECK_POINTS, Calibration, FACE, GazeModel,
  OneEuro2D, RAW_LANDMARKS, evaluateSession, evaluateUsage, eyeFeatures, packFrame, pickTarget, snapRadius, targetDistance,
  unpackFrame } from "../../jarvis/webapp/static/gaze.js";
import { face, rng, runCalibration } from "./gaze-synthetic.mjs";

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
  // магнит: чем точнее взгляд и слабее настройка, тем меньше радиус; «выкл» — только то, что под взглядом
  assert.equal(snapRadius(cal.errorPx), 20);
  assert.equal(snapRadius(200, 3), 150);
  assert.equal(snapRadius(90, 0), 10);
  const radii = [0, 1, 2, 3].map((lvl) => snapRadius(90, lvl));
  assert.deepEqual(radii, [...radii].sort((a, b) => a - b));
  assert.ok(snapRadius(90) <= 50, "по умолчанию — слабый магнит");
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
  assert.equal(pickTarget({ x: 300, y: 375 }, [node], "Ideas/A.md", 70).id, "Ideas/A.md");   // чуть дальше радиуса — держится
  assert.equal(pickTarget({ x: 300, y: 395 }, [node], "Ideas/A.md", 70), null);               // но недолго: не «залипает»
  // строки списка ниже 24 px: взгляд перешёл внутрь соседней строки — курсор переходит, а не застревает
  const row1 = { id: "row1", x: 900, y: 188, w: 500, h: 27 }, row2 = { id: "row2", x: 900, y: 215, w: 500, h: 27 };
  assert.equal(pickTarget({ x: 910, y: 194 }, [row1, row2], "row2").id, "row1");
  assert.equal(pickTarget({ x: 910, y: 205 }, [row1, row2], "row2").id, "row2");
  // кнопка внутри строки (меньше) важнее строки
  const inner = { id: "link", x: 900, y: 188, w: 30, h: 16 };
  assert.equal(pickTarget({ x: 905, y: 190 }, [row1, inner]).id, "link");
  assert.equal(pickTarget({ x: 300, y: 420 }, [node], "Ideas/A.md", 70), null);
});

test("запись кадров: точки и коэффициенты сохраняются и дают те же признаки", () => {
  for (const i of Object.values(FACE)) assert.ok(RAW_LANDMARKS.includes(i), `точка ${i} нужна eyeFeatures`);
  const fc = face(0.3, 0.7, { noise: 0.0004 });
  const fr = packFrame(fc.lm, fc.blend, Float32Array.from({ length: 16 }, (_, k) => k / 10));
  assert.equal(fr.lm.length, RAW_LANDMARKS.length * 2);
  assert.equal(fr.b.length, BLEND_KEYS.length);
  assert.equal(fr.m.length, 16);
  const back = unpackFrame(JSON.parse(JSON.stringify(fr)));
  const a = eyeFeatures(fc.lm, fc.blend), b = eyeFeatures(back.lm, back.blend);
  a.forEach((v, j) => assert.ok(Math.abs(v - b[j]) < 0.02, `признак ${j}: ${v} → ${b[j]}`));   // округление до 1e-4
});

test("большая калибровка: 33 точки, запись для хранилища и её оценка совпадает с приложением", () => {
  assert.equal(BIG_POINTS.length, 25);
  assert.equal(BIG_CHECK.length, 8);
  // «змейка»: соседние точки сетки — соседи на экране, глазу не прыгать через весь экран
  for (let k = 1; k < BIG_POINTS.length; k++) {
    const [a, b] = [BIG_POINTS[k - 1], BIG_POINTS[k]];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3);
  }
  const { cal, ms } = runCalibration({ mode: "big" });
  assert.ok(cal.done && ms < 60000, `большая калибровка — около минуты (${ms} мс)`);
  const s = JSON.parse(JSON.stringify(cal.toSession({ created: "2026-11-09T12:00:00Z", device: "test" })));
  assert.equal(s.kind, "jarvis-gaze-session");
  assert.equal(s.points.length, 33);
  assert.equal(s.points.filter((p) => p.check).length, 8);
  assert.ok(s.frames.length > 33 * 20 && s.frames.every((f) => f.p >= 0 && f.p < 33 && f.lm.length === RAW_LANDMARKS.length * 2));
  assert.ok(JSON.stringify(s).length < 900000, "запись не раздута");
  const ev = evaluateSession(s);
  assert.ok(ev.errorPx < 20, `ошибка ${ev.errorPx}`);
  assert.ok(Math.abs(ev.errorPx - s.result.errorPx) < 10, `${ev.errorPx} против ${s.result.errorPx} в приложении`);
  assert.ok(ev.looPx < 30 && ev.jitterPx < 30, JSON.stringify(ev));
  assert.equal(ev.perPoint.length, 8);
});

test("модель доучивается на нажатиях: свет поменялся — промахи уменьшаются; переживает сохранение", () => {
  const { cal } = runCalibration();
  const ad = cal.adaptive();
  assert.ok(ad.ready && ad.base.length <= 400);
  const screen = { w: 390, h: 844 }, rand = rng(5);
  const miss = (x, y) => {
    const fc = face(x, y, { noise: 0.0004, rand, irisBias: 0.003 });      // радужки «уехали» — взгляд промахивается
    const f = eyeFeatures(fc.lm, fc.blend), p = ad.predict(f);
    return { f, err: Math.hypot((p.x - x) * screen.w, (p.y - y) * screen.h) };
  };
  const targets = Array.from({ length: 24 }, (_, k) => [0.15 + (k % 6) * 0.14, 0.2 + Math.floor(k / 6) * 0.2]);
  const before = targets.map(([x, y]) => miss(x, y).err);
  for (const [x, y] of targets) { const { f, err } = miss(x, y); ad.learn(f, x, y, err); }
  const after = targets.map(([x, y]) => miss(x, y).err);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(avg(after) < avg(before) * 0.6, `промах ${avg(before).toFixed(0)} → ${avg(after).toFixed(0)} px`);
  assert.ok(ad.liveErrorPx() > 0);
  const again = AdaptiveGaze.fromJSON(JSON.parse(JSON.stringify(ad)));
  const f = miss(0.4, 0.5).f;
  assert.deepEqual(again.predict(f), ad.predict(f));
  // нажатий хранится не больше limit — свежие важнее старых
  const small = new AdaptiveGaze({ base: ad.base, limit: 5 });
  for (let k = 0; k < 9; k++) small.learn(f, 0.4, 0.5, 10);
  assert.equal(small.usage.length, 5);
  assert.equal(new AdaptiveGaze().liveErrorPx(), null);
});

test("журнал нажатий: оценка моделью калибровки, с доучиванием — точнее", () => {
  const { cal } = runCalibration();
  const session = cal.toSession();
  const rand = rng(9), w = 390, h = 844;
  const clicks = Array.from({ length: 30 }, (_, k) => {
    const x = 0.1 + ((k * 7) % 10) * 0.08, y = 0.15 + ((k * 3) % 8) * 0.09;
    const fc = face(x, y, { noise: 0.0004, rand, irisBias: 0.003 });
    return { t: k, target: { x: x * w, y: y * h, w: 40, h: 30, kind: "button" }, label: { x: x * w, y: y * h }, ...packFrame(fc.lm, fc.blend) };
  });
  const usage = { kind: "jarvis-gaze-usage", version: 1, screen: { w, h }, landmarks: RAW_LANDMARKS, blend: BLEND_KEYS, clicks };
  const plain = evaluateUsage(session, usage), learned = evaluateUsage(session, usage, { learn: true });
  assert.equal(plain.clicks, 30);
  assert.ok(learned.errorPx < plain.errorPx, `${plain.errorPx} → ${learned.errorPx}`);
});
