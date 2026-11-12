// Управление взглядом: признаки по точкам лица, калибровка (темп, привязка), модель, поправка в работе,
// сглаживание, магнит. node --test tests/js   (на калибровках владельца — gaze-sessions.test.mjs)
import assert from "node:assert/strict";
import { test } from "node:test";

import { ANCHOR_POINTS, AdaptiveGaze, BIG_CHECK, BIG_POINTS, BLEND_KEYS, CAL_POINTS, CHECK_POINTS, Calibration, FACE,
  FEATURE_VERSION, GazeModel, GazeSync, LIVE_ALPHA, OneEuro2D, RAW_LANDMARKS, SPLIT, SplitModel, evaluateSession, evaluateUsage,
  eyeFeatures, gazeFeatures, headPose, packFrame, pickTarget, snapRadius, targetDistance, unpackFrame } from "../../jarvis/webapp/static/gaze.js";
import { BASE_POSE, MOVED_POSES, PHONE, face, face3d, poseError, rng, runCalibration, runCalibration3d } from "./gaze-synthetic.mjs";

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

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

test("признаки v3 — только глаза: по оси x свои, по оси y свои; положение головы не входит", () => {
  assert.equal(FEATURE_VERSION, 3);
  const c = face(0.5, 0.5), r = face(0.9, 0.5), d = face(0.5, 0.9);
  const fc = gazeFeatures(c.lm, c.blend), fr = gazeFeatures(r.lm, r.blend), fd = gazeFeatures(d.lm, d.blend);
  assert.equal(fc.length, SPLIT.x.length + SPLIT.y.length);
  assert.ok(fc.every(Number.isFinite));
  assert.ok(fr[0] < fc[0] && fr[1] < fc[1]);                              // вправо по экрану: радужки влево в кадре, eyeLook — к правому плечу
  assert.ok(fd[3] > fc[3] && fd[4] < fc[4]);                              // вниз: радужки ниже, eyeLook вниз
  // сдвиг головы в кадре (телефон сдвинули) признаки не меняет — их меняет только взгляд
  const moved = face(0.5, 0.5, { head: 0.05 });
  const fm = gazeFeatures(moved.lm, moved.blend);
  [0, 1, 3, 4].forEach((j) => assert.ok(Math.abs(fm[j] - fc[j]) < 1e-9, `признак ${j}`));
  assert.equal(gazeFeatures(c.lm, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }), null);
});

test("модель по осям: учится на точках и угадывает новые; сохраняется и загружается", () => {
  const rand = rng(3);
  for (const M of [GazeModel, SplitModel]) {
    const m = new M();
    const feat = M === GazeModel ? (f) => eyeFeatures(f.lm, f.blend) : (f) => gazeFeatures(f.lm, f.blend);
    for (const [x, y] of CAL_POINTS) for (let k = 0; k < 20; k++) { const f = face(x, y, { noise: 0.0004, rand }); m.add(feat(f), x, y); }
    m.fit();
    for (const [x, y] of [...CHECK_POINTS, [0.2, 0.8], [0.85, 0.15]]) {
      const p = m.predict(feat(face(x, y, { noise: 0.0004, rand })));
      assert.ok(Math.hypot(p.x - x, p.y - y) < 0.06, `${M.name} (${x}, ${y}) → (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
    }
    const again = M.fromJSON(JSON.parse(JSON.stringify(m)));
    const f = feat(face(0.3, 0.6));
    assert.deepEqual(again.predict(f), m.predict(f));
    assert.throws(() => new M().fit(), /мало точек/);
  }
});

test("калибровка: спокойный темп — пишем, только когда взгляд устоялся; лицо пропало — время стоит", () => {
  const rand = rng(11);
  const cal = new Calibration({ screen: { w: 390, h: 844 } });
  assert.deepEqual(cal.counter, { n: 1, total: CAL_POINTS.length + CHECK_POINTS.length });
  let ts = 0;
  for (; ts < 2000; ts += 33) cal.feed(null, ts);                         // лица нет 2 с — точка ждёт
  assert.equal(cal.counter.n, 1);
  assert.equal(cal.progress, 0);
  assert.equal(cal.faceLost(ts), false);                                   // лица ещё ни разу не было
  // взгляд «едет» к точке (радужки движутся) — замер не начинается, пока не устоится (но не дольше settleMaxMs)
  const [x0, y0] = cal.point;
  const start = ts;
  for (let k = 0; ts - start < 1300; k++, ts += 33) {
    const fc = face(0.9 - Math.min(1, k / 40) * (0.9 - x0), y0, { rand });
    cal.feed(gazeFeatures(fc.lm, fc.blend), ts);
  }
  assert.equal(cal.sampling, false, "взгляд ещё двигался — рано писать");
  const seen = [];
  let paused = false;
  while (!cal.done && ts < 90000) {
    const [x, y] = cal.point;
    if (!seen.length || seen.at(-1) !== `${x},${y}`) seen.push(`${x},${y}`);
    const fc = face(x, y, { noise: 0.0004, rand });
    cal.feed(gazeFeatures(fc.lm, fc.blend), ts);
    ts += 33;
    if (!paused && cal.counter.n === 3 && cal.sampling) {                  // посреди замера отвернулся
      paused = true;
      const before = cal.progress;
      for (let k = 0; k < 30; k++, ts += 33) cal.feed(null, ts);
      assert.equal(cal.progress, before);
      assert.ok(cal.faceLost(ts));
    }
  }
  assert.ok(cal.done && cal.model.ready);
  assert.equal(seen.length, cal.list.length);
  assert.ok(cal.errorPx < 30, `ошибка ${cal.errorPx} px`);
  const perPoint = (ts - 2000) / cal.list.length;
  assert.ok(perPoint > 1800 && perPoint < 2800, `на точку ${perPoint.toFixed(0)} мс — не «очень быстро»`);
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

test("большая калибровка: 25 точек «змейкой» и 8 проверочных; запись для хранилища и её оценка — как в приложении", () => {
  assert.equal(BIG_POINTS.length, 25);
  assert.equal(BIG_CHECK.length, 8);
  for (let k = 1; k < BIG_POINTS.length; k++) {                           // глазу не прыгать через весь экран
    const [a, b] = [BIG_POINTS[k - 1], BIG_POINTS[k]];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3);
  }
  const { cal, ms } = runCalibration({ mode: "big" });
  assert.ok(cal.done && ms < 80000, `большая калибровка — около минуты с небольшим (${ms} мс)`);
  const s = JSON.parse(JSON.stringify(cal.toSession({ created: "2026-11-09T12:00:00Z", device: "test" })));
  assert.equal(s.kind, "jarvis-gaze-session");
  assert.equal(s.points.length, 33);
  assert.equal(s.points.filter((p) => p.check).length, 8);
  assert.equal(s.featureVersion, FEATURE_VERSION);
  assert.ok(s.frames.length > 33 * 20 && s.frames.every((f) => f.p >= 0 && f.p < 33 && f.lm.length === RAW_LANDMARKS.length * 2));
  assert.ok(JSON.stringify(s).length < 900000, "запись не раздута");
  const ev = evaluateSession(s);
  assert.ok(ev.errorPx < 20, `ошибка ${ev.errorPx}`);
  assert.ok(Math.abs(ev.errorPx - s.result.errorPx) < 10, `${ev.errorPx} против ${s.result.errorPx} в приложении`);
  assert.ok(ev.looPx < 30 && ev.jitterPx < 30 && ev.livePx < 30, JSON.stringify(ev));
  assert.equal(ev.perPoint.length, 8);
});

test("в работе: нажали щипком по цели — курсор сразу сдвигается туда, где был взгляд; переживает сохранение", () => {
  const { cal } = runCalibration();
  const ad = cal.adaptive();
  assert.ok(ad.ready && ad.base.length <= 400);
  assert.equal(ad.alpha, LIVE_ALPHA);
  const rand = rng(5);
  const miss = (x, y) => {
    const fc = face(x, y, { noise: 0.0004, rand, irisBias: 0.003 });      // радужки «уехали» (свет, другая сессия)
    const f = gazeFeatures(fc.lm, fc.blend), p = ad.predict(f);
    return { f, err: Math.hypot((p.x - x) * PHONE.w, (p.y - y) * PHONE.h) };
  };
  const targets = Array.from({ length: 12 }, (_, k) => [0.15 + (k % 4) * 0.23, 0.2 + Math.floor(k / 4) * 0.3]);
  const before = avg(targets.map(([x, y]) => miss(x, y).err));
  // три нажатия — и промах уже меньше вдвое
  for (const [x, y] of targets.slice(0, 3)) { const { f, err } = miss(x, y); ad.learn(f, x, y, err); }
  const after = avg(targets.map(([x, y]) => miss(x, y).err));
  assert.ok(after < before * 0.5, `промах ${before.toFixed(0)} → ${after.toFixed(0)} px`);
  assert.ok(ad.liveErrorPx() > 0);
  const again = AdaptiveGaze.fromJSON(JSON.parse(JSON.stringify(ad)));
  const f = miss(0.4, 0.5).f;
  const p1 = again.predict(f), p2 = ad.predict(f);
  assert.ok(Math.abs(p1.x - p2.x) < 1e-3 && Math.abs(p1.y - p2.y) < 1e-3);   // поправка сохраняется (округление 1e-4)
  const small = new AdaptiveGaze({ base: ad.base, limit: 5 });
  for (let k = 0; k < 9; k++) small.learn(f, 0.4, 0.5, 10);
  assert.equal(small.usage.length, 5);
  assert.equal(new AdaptiveGaze().liveErrorPx(), null);
});

test("привязка: 3 точки при включении взгляда убирают сдвиг новой сессии, модель не переучивается", () => {
  const { cal } = runCalibration();
  const ad = cal.adaptive();
  const rand = rng(7);
  const errAt = (x, y) => { const fc = face(x, y, { noise: 0.0004, rand, irisBias: 0.003 }); const p = ad.predict(gazeFeatures(fc.lm, fc.blend)); return Math.hypot((p.x - x) * PHONE.w, (p.y - y) * PHONE.h); };
  const pts = [[0.2, 0.2], [0.8, 0.3], [0.5, 0.6], [0.2, 0.85], [0.8, 0.85]];
  const before = avg(pts.map(([x, y]) => errAt(x, y)));
  // привязка — та же калибровка, но 3 точки и без обучения модели
  const anchorCal = new Calibration({ mode: "anchor", screen: PHONE });
  assert.deepEqual(anchorCal.list.map((e) => e.p), ANCHOR_POINTS);
  let ts = 0;
  while (!anchorCal.done) { const [x, y] = anchorCal.point; const fc = face(x, y, { noise: 0.0004, rand, irisBias: 0.003 }); anchorCal.feed(gazeFeatures(fc.lm, fc.blend), ts); ts += 33; }
  assert.ok(ts < 9000, `привязка — несколько секунд (${ts} мс)`);
  assert.equal(anchorCal.model.ready, false, "модель привязки не обучается");
  const weights = JSON.stringify(ad.model);
  ad.anchor(anchorCal.anchorSamples);
  assert.equal(JSON.stringify(ad.model), weights);
  const after = avg(pts.map(([x, y]) => errAt(x, y)));
  assert.ok(after < before * 0.4, `промах ${before.toFixed(0)} → ${after.toFixed(0)} px`);
});

test("журнал нажатий: оценка моделью калибровки, с поправкой по нажатиям — точнее", () => {
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
  assert.ok(learned.errorPx < plain.errorPx * 0.6, `${plain.errorPx} → ${learned.errorPx}`);
});

// ---------- телефон двигают: поза головы относительно камеры меняется ----------
test("поза головы по матрице MediaPipe (4×4 по столбцам, см) — для подсказки «поза изменилась»", () => {
  const pose = { x: 3, y: -5, z: -30, yaw: 10, pitch: -8, roll: 12 };
  const { matrix } = face3d(195, 400, pose, { poseNoise: 0 });
  const hp = headPose(matrix);
  assert.ok(Math.abs(hp.x - 3) < 0.01 && Math.abs(hp.y + 5) < 0.01 && Math.abs(hp.z - 30) < 0.01);
  assert.ok(Math.abs(hp.roll - 12) < 3 && Math.abs(hp.yaw - 10) < 3 && Math.abs(hp.pitch + 8) < 3, JSON.stringify(hp));
  assert.equal(headPose(null), null);
});

test("телефон сдвинули, наклонили, поднесли ближе: привязка и поправка по нажатиям возвращают точность", () => {
  const { cal } = runCalibration3d({ mode: "quick" });
  const ad = cal.adaptive();
  const same = poseError(ad, BASE_POSE);
  assert.ok(same < 30, `та же поза: ${same.toFixed(0)} px`);
  const res = MOVED_POSES.map((pose, k) => {
    const m = AdaptiveGaze.fromJSON(JSON.parse(JSON.stringify(ad)));
    const before = poseError(m, pose, { seed: 30 + k });
    // привязка в новой позе
    const rand = rng(40 + k);
    const samples = [];
    for (const [x, y] of ANCHOR_POINTS) for (let n = 0; n < 20; n++) {
      const fc = face3d(x * PHONE.w, y * PHONE.h, pose, { rand });
      samples.push([gazeFeatures(fc.lm, fc.blend), x, y]);
    }
    m.anchor(samples);
    return { before, after: poseError(m, pose, { seed: 30 + k }) };
  });
  const b = avg(res.map((r) => r.before)), a = avg(res.map((r) => r.after));
  assert.ok(a < b * 0.6, `после сдвига ${b.toFixed(0)} px, после привязки ${a.toFixed(0)} px`);
  // поза далеко за пределами калибровки — модель это видит (голограмма предложит привязку)
  assert.equal(ad.outOfRange(headPose(face3d(195, 400, BASE_POSE).matrix)), false);
  const far = headPose(face3d(195, 400, { ...BASE_POSE, z: -60 }).matrix);
  assert.equal(ad.outOfRange(far), true);
  ad.learn(gazeFeatures(face3d(195, 400, BASE_POSE).lm, face3d(195, 400, BASE_POSE).blend), 0.5, 0.47, 10, far);
  assert.equal(ad.outOfRange(far), false, "после поправки в этой позе подсказка больше не нужна");
});

test("взгляд и щипок синхронно: нажимается последняя устойчивая фиксация, а не взгляд в момент щипка", () => {
  const A = { id: "A" }, B = { id: "B" };
  const feed = (g, from, to, target, f = [1]) => { for (let t = from; t < to; t += 33) g.push(t, target, f, { x: t, y: 0 }); };
  // поздний щипок: смотрел на A 300 мс, взгляд ушёл на B за 100 мс до щипка — нажимается A
  let g = new GazeSync();
  feed(g, 0, 300, A, [1]); feed(g, 300, 400, B, [9]);
  g.pinchStart(400);
  let hit = g.resolve(600);
  assert.equal(hit.target.id, "A");
  assert.equal(hit.kind, "fixation");
  assert.deepEqual(hit.f, [1]);                                            // поправка курсора — по кадрам фиксации на A
  // взгляд ушёл в пустоту перед щипком — всё равно A
  g = new GazeSync();
  feed(g, 0, 300, A); feed(g, 300, 420, null);
  g.pinchStart(420);
  assert.equal(g.resolve(500).target.id, "A");
  // давняя фиксация (секунду назад) не считается
  g = new GazeSync();
  feed(g, 0, 300, A); feed(g, 300, 1100, null);
  g.pinchStart(1100);
  assert.equal(g.resolve(1200), null);
  // ранний щипок: пальцы свели, пока взгляд ехал; остановился на B — нажимается B
  g = new GazeSync();
  feed(g, 0, 200, null);
  g.pinchStart(200);
  feed(g, 200, 260, null); feed(g, 260, 460, B);
  hit = g.resolve(470);
  assert.deepEqual([hit.target.id, hit.kind], ["B", "early"]);
  // мимолётный пролёт взгляда через цель (один-два кадра) — не фиксация
  g = new GazeSync();
  feed(g, 0, 200, null); feed(g, 200, 250, B); feed(g, 250, 400, null);
  g.pinchStart(400);
  assert.equal(g.resolve(450), null);
});
