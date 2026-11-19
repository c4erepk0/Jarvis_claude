// «Глобус»: суша по контурам, сфера из частиц, поворот и проекция, дуги, выбор маркера, фильтры (globe-geo.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { HOLES, LAND, ago, arc, arrow, centerOn, inPolygon, isLand, matches, mergeItems, pick, pressureClass, project,
  shortestTurn, spherePoints } from "../../jarvis/webapp/static/globe-geo.js";

test("суша и море — по контурам материков", () => {
  const land = [[55.75, 37.62, "Москва"], [40.71, -74.0, "Нью-Йорк"], [-23.5, -46.6, "Сан-Паулу"], [30.0, 31.2, "Каир"],
    [-33.9, 151.2, "Сидней"], [35.7, 139.7, "Токио"], [39.9, 116.4, "Пекин"], [51.5, -0.1, "Лондон"], [-80, 0, "Антарктида"],
    [28.6, 77.2, "Дели"], [24.7, 46.7, "Эр-Рияд"], [72, -40, "Гренландия"]];
  for (const [lat, lon, name] of land) assert.ok(isLand(lat, lon), name);
  const sea = [[0, -30, "Атлантика"], [0, -150, "Тихий"], [-20, 80, "Индийский"], [43.5, 34, "Чёрное море"],
    [42, 50.5, "Каспий"], [35, 18, "Средиземное"], [60, -35, "между Гренландией и Исландией"], [25, -90, "Мексиканский залив"]];
  for (const [lat, lon, name] of sea) assert.ok(!isLand(lat, lon), name);
  assert.ok(Object.values(LAND).every((p) => p.length >= 4) && Object.keys(HOLES).length === 2);
  assert.ok(inPolygon([0.5, 0.5], [[0, 0], [1, 0], [1, 1], [0, 1]]) && !inPolygon([2, 2], [[0, 0], [1, 0], [1, 1]]));
});

test("сфера Фибоначчи: равномерно, суши — около трети", () => {
  const pts = spherePoints(4000);
  assert.equal(pts.length, 4000);
  const north = pts.filter((p) => p.lat > 0).length;
  assert.ok(Math.abs(north - 2000) < 20);
  const share = pts.filter((p) => p.land).length / pts.length;
  assert.ok(share > 0.24 && share < 0.4, String(share));
});

test("поворот и проекция: точка вида — в центре, обратная сторона скрыта", () => {
  const view = { cx: 200, cy: 150, r: 100, ...centerOn(55.75, 37.62) };
  const moscow = project(55.75, 37.62, view);
  assert.ok(Math.abs(moscow.x - 200) < 1e-6 && Math.abs(moscow.y - 150) < 1e-6 && moscow.z > 0.999);
  assert.ok(project(-55.75, -142.38, view).z < -0.999);                    // антипод
  const up = project(55.75, 37.62, view, 0.2);
  assert.ok(Math.abs(up.x - 200) < 1e-6);                                    // высота — по радиусу
  assert.deepEqual(centerOn(80, 10), { yaw: 10, tilt: 60 });
  assert.equal(shortestTurn(350, 10), 20);
  assert.equal(shortestTurn(10, 350), -20);
});

test("дуга большого круга: от события к рынку, приподнята в середине", () => {
  const pts = arc([26.6, 56.3], [51.5, -0.1], 20);
  assert.equal(pts.length, 21);
  assert.ok(Math.abs(pts[0].lat - 26.6) < 1e-6 && Math.abs(pts[20].lon + 0.1) < 1e-6);
  assert.ok(pts[10].alt > pts[2].alt && pts[0].alt === 0);
  assert.equal(arc([10, 10], [10, 10], 4).length, 5);                        // одна и та же точка — без NaN
  assert.ok(arc([10, 10], [10, 10], 4).every((p) => Number.isFinite(p.lat)));
});

test("выбор маркера касанием — только видимые", () => {
  const view = { cx: 0, cy: 0, r: 100, yaw: 0, tilt: 0 };
  const near = { id: "a", place: { lat: 0, lon: 0 } }, back = { id: "b", place: { lat: 0, lon: 180 } };
  assert.equal(pick([back, near], view, 3, -2), near);
  assert.equal(pick([back], view, 0, 0), null);
  assert.equal(pick([near], view, 40, 40), null);
});

test("фильтры, подписи и слияние ленты", () => {
  const econ = { id: "1", kind: "energy", economic: true, ts: 10 }, quake = { id: "2", kind: "quake", economic: false, ts: 20 };
  assert.ok(matches(econ, "economic") && matches(econ, "economy") && !matches(econ, "conflict"));
  assert.ok(matches(quake, "disaster") && matches(quake, "all"));
  assert.equal(ago(1000, 1030), "только что");
  assert.equal(ago(1000, 1000 + 7200), "2 ч назад");
  assert.equal(ago(0, 100000), "вчера");
  assert.equal(arrow(1) + arrow(-1), "↑↓");
  assert.deepEqual([pressureClass(0.5), pressureClass(-0.3), pressureClass(0.1)], ["up", "down", "flat"]);
  const merged = mergeItems([econ], [quake, { ...econ, title: "дубль" }]);
  assert.deepEqual(merged.map((i) => i.id), ["2", "1"]);
});
