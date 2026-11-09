// Жесты голограммы и первоначальное обучение им: node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, poseFrame } from "../../jarvis/webapp/static/gestures.js";
import { GestureCoach, STEPS } from "../../jarvis/webapp/static/gesture-coach.js";

test("эталонные позы из обучения распознаются как нарисованы", () => {
  assert.equal(classify([]).kind, "none");
  assert.equal(classify([poseFrame("palm")]).kind, "palm");
  assert.equal(classify([poseFrame("point")]).kind, "point");
  assert.equal(classify([poseFrame("pinch")]).kind, "pinch");
  const two = classify([poseFrame("pinch", { x: 0.05 }), poseFrame("pinch", { x: 0.55 })]);
  assert.equal(two.kind, "pinch2");
  assert.ok(two.d > 0.4);
  // курсор отзеркален под экран: палец слева в кадре — справа на экране
  const p = classify([poseFrame("point", { x: 0 })]);
  assert.ok(p.x > 0.8 && p.y > 0 && p.y < 1);
  // мелкая рука вдали тоже распознаётся
  assert.equal(classify([poseFrame("palm", { scale: 0.18 })]).kind, "palm");
});

function frames(coach, kind, from, to, every = 33) {
  let done = false;
  for (let t = from; t <= to; t += every) done = coach.feed({ type: "frame", kind }, t) || done;
  return done;
}

test("обучение: шаги засчитываются только настоящими жестами", () => {
  const c = new GestureCoach();
  assert.equal(c.step.id, "intro");
  assert.equal(c.feed({ type: "frame", kind: "palm" }, 0), false);   // вступление — только кнопкой
  assert.equal(c.next(0).id, "hand");
  assert.deepEqual(c.counter, { n: 1, total: STEPS.length - 2 });

  // рука: удержание 0,8 с, краткая потеря кадра не сбрасывает
  frames(c, "hand", 0, 400);
  c.feed({ type: "frame", kind: "none" }, 450);
  assert.ok(c.progress > 0.4);
  assert.equal(frames(c, "hand", 500, 900), true);

  // указка: другой жест не засчитывается, долгий перерыв сбрасывает удержание
  c.next(1000);
  frames(c, "palm", 1000, 3000);
  assert.equal(c.progress, 0);
  frames(c, "point", 3000, 3600);
  frames(c, "hand", 3633, 4200);
  assert.equal(c.progress, 0);
  assert.equal(frames(c, "point", 4300, 5400), true);

  // вращение щипком: копится угол
  c.next(6000);
  assert.equal(c.step.id, "rotate");
  assert.equal(c.feed({ type: "rotate", amount: 0.5 }, 6100), false);
  assert.equal(c.feed({ type: "zoom", amount: 99 }, 6150), false);          // чужое событие не помогает
  assert.equal(c.feed({ type: "rotate", amount: -1.1 }, 6200), true);

  // масштаб двумя руками
  c.next(7000);
  assert.equal(c.feed({ type: "zoom", amount: -25 }, 7100), false);
  assert.equal(c.feed({ type: "zoom", amount: 20 }, 7200), true);

  // ладонь: прогресс от удержания, но засчитывает только настоящий сброс вида
  c.next(8000);
  frames(c, "palm", 8000, 9500);
  assert.ok(c.progress > 0.9 && !c.complete);
  assert.equal(c.feed({ type: "reset" }, 9600), true);

  // выбор узла: кольцо задержки, затем выбор
  c.next(10000);
  assert.equal(c.step.id, "select");
  c.feed({ type: "dwell", progress: 0.6, id: "Projects/Jarvis.md" }, 10100);
  assert.equal(c.progress, 0.6);
  c.feed({ type: "frame", kind: "palm" }, 10150);                          // увёл палец — кольцо сброшено
  assert.equal(c.progress, 0);
  assert.equal(c.feed({ type: "select", id: "Projects/Jarvis.md" }, 10500), true);
  assert.equal(c.selected, "Projects/Jarvis.md");

  assert.equal(c.next(11000).id, "done");
  assert.ok(c.finished);
});

test("обучение: подсказка, когда руки не видно, и пропуск невозможного шага", () => {
  const c = new GestureCoach(STEPS, { hasNodes: false });
  c.next(0);
  assert.equal(c.handLost(2000), false);
  assert.equal(c.handLost(3500), true);                                    // 3 с без руки — подсказать про свет
  c.feed({ type: "frame", kind: "hand" }, 3600);
  assert.equal(c.handLost(4000), false);
  while (c.step.id !== "palm") c.skip(5000);
  assert.equal(c.next(5000).id, "done");                                   // заметок нет — выбор узла пропущен
});
