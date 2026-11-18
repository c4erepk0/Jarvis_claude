// Сфера ядра из частиц: точки и параметры анимации (sphere-points.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { MOODS, blendMood, corePoints, fibonacciSphere, rng } from "../../jarvis/webapp/static/sphere-points.js";

test("точки Фибоначчи лежат на сфере и покрывают её равномерно", () => {
  const p = fibonacciSphere(500, 2);
  let top = 0;
  for (let i = 0; i < 500; i++) {
    const r = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    assert.ok(Math.abs(r - 2) < 1e-6);
    if (p[i * 3 + 1] > 0) top++;
  }
  assert.ok(Math.abs(top - 250) <= 2);     // половина — в верхнем полушарии
});

test("частицы ядра: оболочка, облако внутри, кольцо; одинаковые при каждом запуске", () => {
  const a = corePoints({ shell: 100, inner: 50, ring: 30 }), b = corePoints({ shell: 100, inner: 50, ring: 30 });
  assert.equal(a.count, 180);
  assert.deepEqual([...a.positions], [...b.positions]);
  for (let i = 0; i < a.count; i++) {
    const r = Math.hypot(a.positions[i * 3], a.positions[i * 3 + 1], a.positions[i * 3 + 2]);
    if (a.layers[i] === 0) assert.ok(Math.abs(r - 1) < 1e-6);
    if (a.layers[i] === 1) assert.ok(r >= 0.25 && r <= 0.86);
    if (a.layers[i] === 2) assert.ok(r > 1.25 && r < 1.4);
    assert.ok(a.seeds[i] >= 0 && a.seeds[i] < 1);
  }
  const r = rng(3);
  assert.notEqual(r(), r());
});

test("настроение ядра меняется плавно", () => {
  const half = blendMood(MOODS.idle, MOODS.thinking, 0.5);
  assert.equal(half.swirl, 0.5);
  assert.ok(half.speed > MOODS.idle.speed && half.speed < MOODS.thinking.speed);
  assert.deepEqual(blendMood(MOODS.idle, MOODS.error, 1), MOODS.error);
});
