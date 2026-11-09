// Распознавание жестов по 21 точке руки MediaPipe (координаты кадра 0…1, y — вниз, кадр не отзеркален).
// Без зависимостей: используется голограммой, обучением и тестами (node --test).

export const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

// Все пороги — в долях размера руки, а не кадра: рука в метре от камеры занимает десятую часть кадра,
// и абсолютный порог щипка принимал за щипок почти любой жест. Подобраны на реальных кадрах HaGRID
// (tests/js/fixtures/hands-hagrid.json): 166 из 176 верно, против 149 с прежними абсолютными порогами.
const PINCH = 0.3;          // кончики большого и указательного ближе 0,3 руки — щипок
const EXTEND = 0.15;        // кончик выше среднего сустава хотя бы на 0,15 руки — палец вытянут
const THUMB_UP = 0.4;       // большой палец выше всех остальных суставов на 0,4 руки — 👍
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];   // кончик и средний сустав: указательный … мизинец
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Размер руки: самое длинное из запястье—основания пальцев и ширины ладони — не «сжимается»,
 *  когда рука повёрнута к камере боком или ребром. */
export const handSize = (lm) => Math.max(dist(lm[0], lm[9]), dist(lm[0], lm[5]), dist(lm[0], lm[17]),
  dist(lm[5], lm[17]) * 1.4) || 1e-6;
const extended = (lm, tip, pip) => lm[tip].y < lm[pip].y - EXTEND * handSize(lm);
// палец сжат: кончик подвёрнут к ладони — ближе к запястью, чем средний сустав
const curled = (lm, tip, pip) => dist(lm[tip], lm[0]) < dist(lm[pip], lm[0]) * 0.9;

/** Кулак: все четыре пальца подвёрнуты к ладони (большой — как угодно). */
export const fist = (lm) => FINGERS.every(([t, p]) => curled(lm, t, p));
// В кулаке большой палец лежит поверх пальцев — кончики рядом, но это не щипок.
export const pinching = (lm) => dist(lm[4], lm[8]) < PINCH * handSize(lm) && !fist(lm);
export const openPalm = (lm) => FINGERS.every(([t, p]) => extended(lm, t, p)) && !pinching(lm);
export const pointing = (lm) => extended(lm, 8, 6) && !extended(lm, 12, 10) && !extended(lm, 16, 14) && !pinching(lm);
/** Два пальца (✌): указательный и средний вытянуты, безымянный и мизинец — нет. */
export const victory = (lm) => extended(lm, 8, 6) && extended(lm, 12, 10) && !extended(lm, 16, 14) && !extended(lm, 20, 18)
  && !pinching(lm);
/** Большой палец вверх (👍): остальные сжаты, большой торчит выше всех суставов руки. */
export const thumbUp = (lm) => {
  if (FINGERS.some(([t, p]) => extended(lm, t, p))) return false;
  const top = Math.min(...lm.slice(5).map((p) => p.y));
  return lm[4].y < lm[3].y && lm[3].y < lm[2].y && top - lm[4].y > handSize(lm) * THUMB_UP;
};

/** Что показывает рука (руки) в кадре. x/y — уже отзеркалены под экран (0…1).
 *  kind: none | pinch2 (щипок двумя руками, d — расстояние) | pinch | palm | point | victory | thumb | fist
 *  | hand (рука без жеста). */
export function classify(hands = []) {
  if (hands.length >= 2 && pinching(hands[0]) && pinching(hands[1])) {
    return { kind: "pinch2", hands: hands.length, d: dist(hands[0][9], hands[1][9]) };
  }
  const lm = hands[0];
  if (!lm) return { kind: "none", hands: 0 };
  const at = (i) => ({ hands: hands.length, x: 1 - lm[i].x, y: lm[i].y });
  if (pinching(lm)) return { kind: "pinch", ...at(9) };
  if (openPalm(lm)) return { kind: "palm", ...at(9) };
  if (pointing(lm)) return { kind: "point", ...at(8) };
  if (victory(lm)) return { kind: "victory", ...at(9) };
  if (thumbUp(lm)) return { kind: "thumb", ...at(9) };
  if (fist(lm)) return { kind: "fist", ...at(9) };
  return { kind: "hand", ...at(9) };
}

export const KIND_LABEL = {
  none: "не вижу руку", hand: "рука", point: "указка", pinch: "щипок", pinch2: "щипок двумя руками", palm: "ладонь",
  victory: "два пальца", thumb: "большой палец вверх", fist: "кулак",
};

/** Значки жестов — для подсказок на голограмме. */
export const GESTURE_ICON = {
  palm: "✋", fist: "✊", thumb: "👍", victory: "✌", point: "☝", pinch: "🤏", pinch2: "🤏🤏", hand: "🖐",
  "swipe-left": "👋", "swipe-right": "👋",
};

// ---------- удержание поз и взмах ладонью ----------
/** Сколько держать позу, чтобы она сработала (мс). */
export const HOLD_MS = { palm: 1000, victory: 800, thumb: 800, fist: 800 };
/** Щипок, сдвинутый меньше чем на столько (доля кадра), — «нажатие», а не перетаскивание: граф не крутится. */
export const DRAG = 0.03;
/** Короткий щипок — «нажать» (для взгляда): свёл и развёл пальцы за это время (мс). */
export const TAP_MS = [40, 450];

/**
 * Следит за кадрами classify() и превращает их в команды. Без DOM — голограмма, обучение, тесты.
 * update(g, ts) возвращает события:
 *   { type: "hold", kind, progress } — поза держится (0…1), для индикатора;
 *   { type: "pose", kind }           — поза удержана; повтор — только если руку перестроить;
 *   { type: "swipe", dir }           — быстрый взмах раскрытой ладонью: dir = "left" | "right" (по экрану);
 *   { type: "tap" }                  — короткий щипок без движения: «нажать» то, на что смотрите.
 * Удержание засчитывается, только пока рука стоит на месте, — взмах ладонью не сбрасывает вид.
 */
export class GestureTracker {
  constructor({ hold = HOLD_MS, graceMs = 250, still = 0.1, swipe = {} } = {}) {
    this.holdMs = hold;
    this.graceMs = graceMs;      // MediaPipe иногда путает позу на кадр-другой — не сбрасываем удержание
    this.still = still;          // насколько можно сдвинуть руку во время удержания (доля кадра)
    this.swipe = { dx: 0.22, ms: 450, cooldown: 700, reverse: 1400, ...swipe };
    this.cur = null;             // какая поза сейчас удерживается
    this.since = 0;
    this.seen = 0;
    this.fired = false;
    this.anchor = null;
    this.path = [];              // недавние положения ладони — для взмаха
    this.lastSwipe = null;       // { dir, at }
    this.blockUntil = 0;         // сразу после взмаха позы не засчитываются
    this.pinch = null;           // текущий щипок — для «нажатия»
  }

  update(g, ts) {
    const out = [];
    const tap = this.detectTap(g, ts);
    if (tap) out.push(tap);
    const sw = this.detectSwipe(g, ts);
    if (sw) {
      out.push(sw);
      this.cur = null;
      this.blockUntil = ts + 1000;
      return out;
    }
    const k = this.holdMs[g.kind] ? g.kind : null;
    if (!k) {
      if (this.cur && ts - this.seen > this.graceMs) { this.cur = null; this.fired = false; }
      return out;
    }
    const moved = this.anchor && Math.hypot(g.x - this.anchor.x, g.y - this.anchor.y) > this.still;
    if (this.cur !== k || moved || ts < this.blockUntil) {
      if (this.cur !== k) this.fired = false;
      this.cur = k;
      this.since = ts;
      this.anchor = { x: g.x, y: g.y };
    }
    this.seen = ts;
    if (this.fired || ts < this.blockUntil) return out;
    const progress = Math.min(1, (ts - this.since) / this.holdMs[k]);
    out.push({ type: "hold", kind: k, progress });
    if (progress >= 1) {
      this.fired = true;
      out.push({ type: "pose", kind: k });
    }
    return out;
  }

  /** Щипок закончился (пальцы разведены дольше кадра-двух), был коротким и почти на месте — «нажать». */
  detectTap(g, ts) {
    const p = this.pinch;
    if (g.kind === "pinch") {
      if (!p) this.pinch = { since: ts, last: ts, x: g.x, y: g.y, moved: 0 };
      else { p.last = ts; p.moved = Math.max(p.moved, Math.hypot(g.x - p.x, g.y - p.y)); }
      return null;
    }
    if (!p) return null;
    if (g.kind === "pinch2") { this.pinch = null; return null; }
    if (ts - p.last < 90) return null;                // кадр без щипка посреди щипка — MediaPipe дрогнул
    this.pinch = null;
    const dur = p.last - p.since;
    return dur >= TAP_MS[0] && dur <= TAP_MS[1] && p.moved < DRAG ? { type: "tap" } : null;
  }

  detectSwipe(g, ts) {
    const s = this.swipe;
    if (g.kind !== "palm") {
      // на быстром взмахе ладонь смазывается: «рука» или пропавший кадр путь не обрывают
      if (g.kind !== "hand" && g.kind !== "none") this.path = [];
      return null;
    }
    this.path.push({ x: g.x, y: g.y, t: ts });
    while (this.path.length && ts - this.path[0].t > s.ms) this.path.shift();
    const a = this.path[0];
    const dx = g.x - a.x, dy = g.y - a.y;
    if (Math.abs(dx) < s.dx || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
    const dir = dx > 0 ? "right" : "left";
    const last = this.lastSwipe;
    // рука возвращается назад после взмаха — это не новый взмах в обратную сторону
    if (last && ts - last.at < (last.dir === dir ? s.cooldown : s.reverse)) return null;
    this.lastSwipe = { dir, at: ts };
    this.path = [];
    return { type: "swipe", dir };
  }
}

// Эталонные позы (правая рука ладонью к камере, координаты 0…100). Из них рисуются схемы в обучении,
// и на них же проверяется распознавание — что нарисовано, то и засчитывается.
const P = (pts) => pts.map(([x, y]) => ({ x, y }));
export const POSES = {
  palm: P([[50, 92], [36, 84], [27, 74], [21, 64], [17, 55], [38, 58], [36, 42], [35, 32], [34, 23], [49, 56], [49, 38],
    [49, 27], [49, 17], [60, 58], [62, 42], [63, 32], [64, 24], [70, 62], [74, 50], [77, 42], [79, 35]]),
  point: P([[50, 92], [36, 84], [33, 72], [38, 66], [44, 64], [38, 58], [36, 42], [35, 32], [34, 23], [49, 56], [50, 48],
    [46, 52], [44, 58], [60, 58], [60, 50], [57, 55], [55, 60], [70, 62], [72, 54], [69, 58], [67, 62]]),
  pinch: P([[50, 92], [36, 84], [28, 75], [24, 64], [25, 51], [38, 58], [33, 46], [27, 41], [25, 47], [49, 56], [50, 40],
    [50, 30], [50, 21], [60, 58], [62, 44], [63, 35], [64, 28], [70, 62], [74, 52], [76, 45], [78, 39]]),
  victory: P([[50, 92], [37, 84], [33, 73], [40, 67], [50, 65], [40, 58], [35, 42], [32, 32], [29, 22], [50, 56], [53, 40],
    [55, 29], [57, 19], [60, 58], [61, 50], [58, 55], [56, 60], [69, 62], [71, 55], [68, 59], [66, 63]]),
  // кулак боком к камере, большой палец смотрит вверх
  thumb: P([[61, 94], [48, 78], [40, 60], [38, 42], [36, 24], [51, 52], [30, 55], [27, 66], [38, 68], [53, 63], [32, 67],
    [31, 76], [40, 77], [56, 72], [36, 77], [35, 85], [44, 85], [58, 81], [42, 86], [40, 93], [48, 92]]),
  // пальцы подвёрнуты к ладони, большой лежит поверх них
  fist: P([[50, 92], [37, 84], [31, 75], [36, 66], [46, 62], [38, 58], [36, 46], [37, 52], [39, 60], [49, 56], [49, 44],
    [50, 51], [50, 59], [60, 58], [61, 47], [61, 53], [60, 60], [70, 62], [72, 53], [71, 58], [69, 63]]),
};

/** Поза в координатах кадра 0…1 (для тестов): масштаб и сдвиг. */
export function poseFrame(name, { scale = 0.4, x = 0.3, y = 0.3 } = {}) {
  return POSES[name].map((p) => ({ x: x + (p.x / 100) * scale, y: y + (p.y / 100) * scale, z: 0 }));
}
