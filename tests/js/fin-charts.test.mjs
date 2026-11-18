// Графики финансов (fin-charts.js): строки SVG без DOM.
import assert from "node:assert/strict";
import { test } from "node:test";

import { donut, esc, money, monthShort, sparkline, trendBars } from "../../jarvis/webapp/static/fin-charts.js";

test("столбики по месяцам: пара на месяц, подписи, линия сбережений", () => {
  const trend = [
    { month: "2026-10", income: 6000000, expense: 1500000, net: 4500000, count: 4 },
    { month: "2026-11", income: 0, expense: 300000, net: -300000, count: 2 },
    { month: "2026-12", income: 0, expense: 0, net: 0, count: 0 },
  ];
  const svg = trendBars(trend);
  assert.equal((svg.match(/class="fc-inc"/g) || []).length, 3);
  assert.equal((svg.match(/class="fc-exp"/g) || []).length, 3);
  assert.match(svg, />окт<\/text>.*>ноя<\/text>.*>дек<\/text>/s);
  assert.match(svg, /<polyline class="fc-net"/);
  assert.doesNotMatch(svg, /NaN/);
  assert.equal(trendBars([]), "");
});

test("линия капитала и кольцо долей", () => {
  assert.equal(sparkline([5]), "");
  assert.match(sparkline([1, 3, 2, 4]), /spark up/);
  assert.match(sparkline([4, 1]), /spark down/);
  const d = donut([{ label: "Акции <b>", value: 30 }, { label: "Крипта", value: 70 }]);
  assert.equal((d.match(/<circle/g) || []).length, 2);
  assert.match(d, /Акции &lt;b&gt;/);
  assert.equal(donut([{ label: "x", value: 0 }]), "");
});

test("деньги и мелочи", () => {
  assert.equal(money(-45000), "−450 ₽");
  assert.equal(money(45050, "RUB", { signed: true }), "+450,5 ₽");
  assert.match(money(1250000000, "RUB", { short: true }), /^12,5 млн ₽$/);
  assert.match(money(5600000, "RUB", { short: true }), /^56 тыс ₽$/);
  assert.equal(monthShort("2026-05"), "май");
  assert.equal(esc("<a href='x'>"), "&lt;a href=&#39;x&#39;&gt;");
});
