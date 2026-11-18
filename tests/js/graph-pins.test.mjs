// Граф памяти: закреплённые узлы, размеры точек, подписи, «упругие» соседи (graph-pins.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { PINS_KEY, degrees, follow, labelled, loadPins, nodeSize, pin, prune, savePins } from "../../jarvis/webapp/static/graph-pins.js";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test("закрепления: сохранить, прочитать, забыть удалённые", () => {
  const s = mem();
  let p = pin({}, "A.md", [1.234, -5.678, 9]);
  p = pin(p, "B.md", [0, 0, 0]);
  savePins(p, s);
  assert.deepEqual(loadPins(s), { "A.md": [1.23, -5.68, 9], "B.md": [0, 0, 0] });
  assert.deepEqual(Object.keys(prune(loadPins(s), ["B.md"])), ["B.md"]);
  s.setItem(PINS_KEY, "{битый json");
  assert.deepEqual(loadPins(s), {});
  s.setItem(PINS_KEY, JSON.stringify({ x: [1, 2], y: [1, 2, "3"], z: [1, 2, 3] }));
  assert.deepEqual(loadPins(s), { z: [1, 2, 3] });
  assert.deepEqual(loadPins(null), {});
});

test("перезакреплённый узел — в конце (старые забываются первыми)", () => {
  let p = pin({}, "a", [0, 0, 0]);
  p = pin(p, "b", [0, 0, 0]);
  p = pin(p, "a", [1, 1, 1]);
  assert.deepEqual(Object.keys(p), ["b", "a"]);
});

test("размер и подписи: проекты и хабы заметнее", () => {
  const nodes = [{ type: "project" }, { type: "note", size: 100 }, { type: "note", size: 100 }];
  const deg = degrees(3, [[0, 1], [1, 2], [1, 0]]);
  assert.deepEqual(deg, [2, 3, 1]);
  assert.ok(nodeSize(nodes[0], deg[0]) > nodeSize(nodes[1], deg[1]));
  assert.ok(nodeSize(nodes[1], deg[1]) > nodeSize(nodes[2], deg[2]));
  assert.deepEqual(labelled(nodes, deg), [0, 1, 2]);
  assert.deepEqual(labelled(nodes, deg, 2, 2), [0, 1]);
});

test("соседи тянутся за перетаскиваемым узлом, закреплённые — нет", () => {
  const pos = [[0, 0, 0], [40, 0, 0], [0, 40, 0], [5, 0, 0]];
  follow(pos, 0, [1, 2, 3], new Set([2]));
  assert.ok(pos[1][0] < 40 && pos[1][0] > 16);
  assert.deepEqual(pos[2], [0, 40, 0]);
  assert.deepEqual(pos[3], [5, 0, 0]);        // уже ближе длины нити
});
