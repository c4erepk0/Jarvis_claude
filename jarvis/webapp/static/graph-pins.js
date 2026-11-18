// Закреплённые узлы графа памяти: куда владелец перетащил точку, там она и остаётся (localStorage).
// Без DOM и без three.js — тест: tests/js/graph-pins.test.mjs. Позиция — [x, y, z] в координатах графа.
export const PINS_KEY = "jarvis.holo_pins";
const MAX_PINS = 2000;

export function loadPins(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(PINS_KEY) || "{}");
    const out = {};
    for (const [id, p] of Object.entries(raw || {})) {
      if (Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v))) out[id] = p;
    }
    return out;
  } catch { return {}; }
}

export function savePins(pins, storage = globalThis.localStorage) {
  try {
    const ids = Object.keys(pins);
    const keep = ids.length > MAX_PINS ? Object.fromEntries(ids.slice(-MAX_PINS).map((k) => [k, pins[k]])) : pins;
    storage?.setItem(PINS_KEY, JSON.stringify(keep));
  } catch { /* приватный режим — закрепления живут до перезагрузки */ }
}

/** Закрепить узел (позиция округляется до сотых — меньше места в хранилище). Возвращает новый объект. */
export function pin(pins, id, [x, y, z]) {
  const r = (v) => Math.round(v * 100) / 100;
  const next = { ...pins };
  delete next[id];              // свежие — в конец: при переполнении забываются самые старые
  next[id] = [r(x), r(y), r(z)];
  return next;
}

/** Только закрепления существующих узлов: переименованные и удалённые заметки забываются. */
export function prune(pins, ids) {
  const alive = new Set(ids);
  return Object.fromEntries(Object.entries(pins).filter(([id]) => alive.has(id)));
}

/** Сколько связей у каждого узла — по нему размер точки и подписи «узлов-хабов». */
export function degrees(count, edges) {
  const d = new Array(count).fill(0);
  for (const [a, b] of edges) { d[a]++; d[b]++; }
  return d;
}

/** Размер точки: проекты крупнее, хабы — чуть крупнее заметок-листьев. */
export function nodeSize(node, degree) {
  const base = node.type === "project" ? 9 : 4.2;
  return base + Math.min(6, Math.sqrt(degree) * 1.6) + Math.min(1.5, Math.log10(1 + (node.size || 0)) * 0.4);
}

/** Какие узлы подписывать: все, если их немного, иначе проекты и самые связанные. */
export function labelled(nodes, deg, limit = 80, top = 36) {
  if (nodes.length <= limit) return nodes.map((_, i) => i);
  const order = nodes.map((n, i) => i).sort((a, b) => (nodes[b].type === "project") - (nodes[a].type === "project") || deg[b] - deg[a]);
  return order.slice(0, top).sort((a, b) => a - b);
}

/** Мягко подтянуть соседей перетаскиваемого узла: нить тянется, но не рвётся. Меняет pos на месте. */
export function follow(pos, i, neighbors, fixed, rest = 16, k = 0.18) {
  for (const j of neighbors) {
    if (fixed.has(j)) continue;
    const d = [pos[j][0] - pos[i][0], pos[j][1] - pos[i][1], pos[j][2] - pos[i][2]];
    const len = Math.hypot(...d);
    if (len <= rest || !len) continue;
    const s = ((len - rest) / len) * k;
    for (let c = 0; c < 3; c++) pos[j][c] -= d[c] * s;
  }
}
