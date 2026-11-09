// Распознавание жестов по 21 точке руки MediaPipe (координаты кадра 0…1, y — вниз, кадр не отзеркален).
// Без зависимостей: используется голограммой, обучением и тестами (node --test).

export const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

const PINCH = 0.055;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const pinching = (lm) => dist(lm[4], lm[8]) < PINCH;
const extended = (lm, tip, pip) => lm[tip].y < lm[pip].y - 0.02;
export const openPalm = (lm) => [[8, 6], [12, 10], [16, 14], [20, 18]].every(([t, p]) => extended(lm, t, p)) && !pinching(lm);
export const pointing = (lm) => extended(lm, 8, 6) && !extended(lm, 12, 10) && !extended(lm, 16, 14) && !pinching(lm);

/** Что показывает рука (руки) в кадре. x/y — уже отзеркалены под экран (0…1).
 *  kind: none | pinch2 (щипок двумя руками, d — расстояние) | pinch | palm | point | hand (рука без жеста). */
export function classify(hands = []) {
  if (hands.length >= 2 && pinching(hands[0]) && pinching(hands[1])) {
    return { kind: "pinch2", hands: hands.length, d: dist(hands[0][9], hands[1][9]) };
  }
  const lm = hands[0];
  if (!lm) return { kind: "none", hands: 0 };
  if (pinching(lm)) return { kind: "pinch", hands: hands.length, x: 1 - lm[9].x, y: lm[9].y };
  if (openPalm(lm)) return { kind: "palm", hands: hands.length };
  if (pointing(lm)) return { kind: "point", hands: hands.length, x: 1 - lm[8].x, y: lm[8].y };
  return { kind: "hand", hands: hands.length };
}

export const KIND_LABEL = {
  none: "не вижу руку", hand: "рука", point: "указка", pinch: "щипок", pinch2: "щипок двумя руками", palm: "ладонь",
};

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
};

/** Поза в координатах кадра 0…1 (для тестов): масштаб и сдвиг. */
export function poseFrame(name, { scale = 0.4, x = 0.3, y = 0.3 } = {}) {
  return POSES[name].map((p) => ({ x: x + (p.x / 100) * scale, y: y + (p.y / 100) * scale, z: 0 }));
}
