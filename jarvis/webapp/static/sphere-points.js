// Точки для сферы ядра — без DOM и three.js (тест — tests/js/sphere-points.test.mjs).
// Сфера из частиц: оболочка (равномерно по «спирали Фибоначчи») + редкое облако внутри + орбитальное кольцо.

/** n точек равномерно по сфере радиуса r: Float32Array [x, y, z, …]. */
export function fibonacciSphere(n, r = 1) {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    out[i * 3] = Math.cos(th) * rad * r;
    out[i * 3 + 1] = y * r;
    out[i * 3 + 2] = Math.sin(th) * rad * r;
  }
  return out;
}

/** Детерминированный «случай» — одинаковая картинка при каждом запуске (и в тестах). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000; };
}

/**
 * Частицы ядра: { positions, seeds, layers } — layer 0 оболочка, 1 облако внутри, 2 орбитальное кольцо.
 * seeds — случайное число на частицу (фаза мерцания и шума).
 */
export function corePoints({ shell = 2400, inner = 500, ring = 360, seed = 7 } = {}) {
  const rand = rng(seed);
  const n = shell + inner + ring;
  const positions = new Float32Array(n * 3), seeds = new Float32Array(n), layers = new Float32Array(n);
  positions.set(fibonacciSphere(shell, 1));
  for (let i = 0; i < shell; i++) {
    // лёгкий разброс по поверхности — без него видна «сетка» спирали
    const x = positions[i * 3] + (rand() - 0.5) * 0.05, y = positions[i * 3 + 1] + (rand() - 0.5) * 0.05;
    const z = positions[i * 3 + 2] + (rand() - 0.5) * 0.05, len = Math.hypot(x, y, z) || 1;
    positions[i * 3] = x / len; positions[i * 3 + 1] = y / len; positions[i * 3 + 2] = z / len;
    seeds[i] = rand(); layers[i] = 0;
  }
  for (let k = 0; k < inner; k++) {
    const i = shell + k;
    // равномерно по объёму: радиус ~ кубический корень, ближе к центру гуще не надо
    const u = rand(), v = rand(), w = rand();
    const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1), r = 0.25 + 0.6 * Math.cbrt(w);
    positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
    positions[i * 3 + 1] = r * Math.cos(ph);
    positions[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    seeds[i] = rand(); layers[i] = 1;
  }
  for (let k = 0; k < ring; k++) {
    const i = shell + inner + k;
    const a = (k / ring) * Math.PI * 2, r = 1.32 + (rand() - 0.5) * 0.06;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = (rand() - 0.5) * 0.03;
    positions[i * 3 + 2] = Math.sin(a) * r;
    seeds[i] = rand(); layers[i] = 2;
  }
  return { positions, seeds, layers, count: n };
}

/** Параметры анимации по состоянию ядра: скорость, «волнение» поверхности, завихрение, яркость. */
export const MOODS = {
  idle: { speed: 0.35, noise: 0.06, swirl: 0.0, glow: 0.75 },
  listening: { speed: 0.7, noise: 0.1, swirl: 0.0, glow: 0.95 },
  thinking: { speed: 1.4, noise: 0.08, swirl: 1.0, glow: 0.9 },
  speaking: { speed: 0.9, noise: 0.12, swirl: 0.15, glow: 1.0 },
  alert: { speed: 0.9, noise: 0.1, swirl: 0.0, glow: 1.0 },
  error: { speed: 1.1, noise: 0.16, swirl: 0.0, glow: 1.0 },
};

/** Плавный переход параметров (k — доля за кадр). */
export function blendMood(cur, goal, k) {
  const out = {};
  for (const key of Object.keys(goal)) out[key] = cur[key] + (goal[key] - cur[key]) * k;
  return out;
}
