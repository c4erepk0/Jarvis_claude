// Плавность: числа докручиваются (motion.js), раскладка 3D-карты расходов (fin-charts.js barGrid).
import assert from "node:assert/strict";
import { test } from "node:test";

import { barGrid } from "../../jarvis/webapp/static/fin-charts.js";
import { easeOutCubic, formatLike, splitNumber, tween } from "../../jarvis/webapp/static/motion.js";

test("замедление и промежуточные значения", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(2), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);              // быстро в начале, медленно в конце
  assert.equal(tween(100, 200, 1), 200);
  assert.equal(tween(100, 200, 0), 100);
});

test("число внутри денежной строки: докрутить, сохранив знак, копейки и «₽»", () => {
  const p = splitNumber("−10 812,50 ₽");
  assert.equal(p.value, -10812.5);
  assert.equal(p.frac, 2);
  assert.equal(p.suffix, " ₽");
  assert.equal(formatLike(-10812.5, p).replace(/\s/g, " "), "−10 812,50 ₽");
  const pct = splitNumber("24%");
  assert.deepEqual([pct.value, pct.suffix], [24, "%"]);
  assert.equal(splitNumber("—"), null);
  assert.equal(splitNumber("Капитал 315 тыс ₽").prefix, "Капитал ");
});

test("3D-карта: сетка категория × месяц, высоты от 0 до 1", () => {
  const g = barGrid({ months: ["2026-10", "2026-11"], categories: ["Еда", "Кафе", "Связь"],
    values: [[100, 400], [0, 200], [50, 0]] });
  assert.equal(g.bars.length, 6);
  assert.equal(g.max, 400);
  const top = g.bars.find((b) => b.value === 400);
  assert.deepEqual([top.category, top.month, top.h], ["Еда", "2026-11", 1]);
  assert.equal(g.bars.find((b) => b.category === "Кафе" && b.month === "2026-10").h, 0);
  assert.ok(Math.abs(g.bars.reduce((s, b) => s + b.x, 0)) < 1e-9);   // по центру
  assert.deepEqual(barGrid({}).bars, []);
});
