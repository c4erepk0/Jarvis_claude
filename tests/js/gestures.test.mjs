// Жесты голограммы и первоначальное обучение им: node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { GestureTracker, POSES, classify, handSize, poseFrame } from "../../jarvis/webapp/static/gestures.js";
import { GestureCoach, NEW_STEPS_FROM, STEPS } from "../../jarvis/webapp/static/gesture-coach.js";
import { Trail, dictationLine, insertDictation, noteAction, noteHint } from "../../jarvis/webapp/static/note-gestures.js";

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

test("новые позы: два пальца, большой палец, кулак — на любом расстоянии", () => {
  for (const name of ["victory", "thumb", "fist"]) {
    for (const scale of [0.18, 0.4, 0.7]) assert.equal(classify([poseFrame(name, { scale })]).kind, name, `${name} ×${scale}`);
  }
  // каждая поза — ровно своя, все эталоны различимы
  const kinds = Object.keys(POSES).map((n) => classify([poseFrame(n)]).kind);
  assert.deepEqual(kinds, Object.keys(POSES));
  // в кулаке большой палец лежит на пальцах — кончики рядом, но это не щипок, и два кулака — не масштаб
  const f = poseFrame("fist");
  assert.ok(Math.hypot(f[4].x - f[8].x, f[4].y - f[8].y) < 0.3 * handSize(f));
  assert.equal(classify([poseFrame("fist", { x: 0.05 }), poseFrame("fist", { x: 0.55 })]).kind, "fist");
  // у позы есть точка на экране (для взмаха), отзеркаленная
  const v = classify([poseFrame("palm", { x: 0 })]);
  assert.ok(v.x > 0.6 && v.y > 0);
});

// Реальные руки: точки MediaPipe на кадрах HaGRID (люди в 0,5–2 м от камеры, рука — малая часть кадра).
// Нарисованные эталоны проходили и с прежними порогами в долях кадра, а живые жесты читались как щипок.
test("реальные руки: жесты распознаются, щипок не мерещится", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/hands-hagrid.json", import.meta.url), "utf8"));
  const WANT = { fist: ["fist"], like: ["thumb"], peace: ["victory"], palm: ["palm"], stop: ["palm"], one: ["point"],
    ok: ["pinch"], dislike: ["fist", "hand"] };     // 👎 — не наш жест: кулак или «просто рука»
  const per = {};
  let right = 0, wrongCommand = 0;
  for (const f of fx.frames) {
    const kind = classify(f.hands.map((h) => h.map(([x, y]) => ({ x, y })))).kind;
    const c = (per[f.label] ??= { right: 0, total: 0, as: {} });
    c.total += 1;
    c.as[kind] = (c.as[kind] || 0) + 1;
    if (WANT[f.label].includes(kind)) { right += 1; c.right += 1; } else if (kind !== "hand") wrongCommand += 1;
  }
  const report = JSON.stringify(per);
  assert.ok(fx.frames.length >= 170);
  assert.ok(right / fx.frames.length >= 0.92, `верно ${right} из ${fx.frames.length}: ${report}`);
  // неверная команда хуже «ничего»: щипок вместо ✌ крутит граф, вместо правки
  assert.ok(wrongCommand <= 4, `неверных команд ${wrongCommand}: ${report}`);
  for (const [label, c] of Object.entries(per)) assert.ok(c.right / c.total >= 0.8, `${label}: ${JSON.stringify(c)}`);
  for (const label of ["peace", "palm", "stop", "like"]) assert.ok(!per[label].as.pinch, `${label} — не щипок: ${report}`);
});

const G = (kind, x = 0.5, y = 0.5) => ({ kind, x, y });

test("удержание позы: прогресс, одно срабатывание, дрожание кадра не сбрасывает", () => {
  const t = new GestureTracker();
  let out = t.update(G("fist"), 0);
  assert.deepEqual(out, [{ type: "hold", kind: "fist", progress: 0 }]);
  out = t.update(G("fist"), 400);
  assert.equal(out[0].progress, 0.5);
  assert.deepEqual(t.update(G("hand"), 500), []);                  // кадр-другой «рука» — удержание живо
  out = t.update(G("fist", 0.52), 820);
  assert.deepEqual(out.map((e) => e.type), ["hold", "pose"]);
  assert.equal(out[1].kind, "fist");
  assert.deepEqual(t.update(G("fist"), 2000), []);                 // держит дальше — не повторяется
  t.update(G("hand"), 2100);
  assert.deepEqual(t.update(G("hand"), 2400), []);                 // разжал руку
  t.update(G("fist"), 2500);
  assert.equal(t.update(G("fist"), 3300).at(-1).type, "pose");     // сжал снова — сработало снова

  // рука поехала — удержание начинается заново; смена позы — тоже
  const m = new GestureTracker();
  m.update(G("thumb", 0.2), 0);
  m.update(G("thumb", 0.2), 600);
  assert.equal(m.update(G("thumb", 0.45), 700)[0].progress, 0);
  assert.equal(m.update(G("victory", 0.45), 750)[0].kind, "victory");
  // указка, щипок — не позы для удержания
  assert.deepEqual(new GestureTracker().update(G("point"), 0), []);
});

test("взмах ладонью: направление по экрану, возврат руки — не взмах, сброс вида не срабатывает", () => {
  const t = new GestureTracker();
  const events = [];
  let ts = 0;
  const run = (kind, from, to, frames = 8) => {
    for (let i = 0; i <= frames; i++, ts += 33) events.push(...t.update(G(kind, from + ((to - from) * i) / frames, 0.5), ts));
  };
  run("palm", 0.2, 0.7);
  assert.deepEqual(events.filter((e) => e.type === "swipe"), [{ type: "swipe", dir: "right" }]);
  run("palm", 0.7, 0.25);                                           // рука вернулась сразу же
  assert.equal(events.filter((e) => e.type === "swipe").length, 1);
  ts += 1500;
  events.length = 0;
  run("palm", 0.8, 0.3);
  assert.deepEqual(events.filter((e) => e.type === "swipe"), [{ type: "swipe", dir: "left" }]);
  // после взмаха ладонь остановилась — сброс вида не сразу, а только после честной секунды удержания
  events.length = 0;
  for (let i = 0; i < 20; i++, ts += 50) events.push(...t.update(G("palm", 0.3), ts));
  assert.ok(!events.some((e) => e.type === "pose"));
  for (let i = 0; i < 25; i++, ts += 50) events.push(...t.update(G("palm", 0.3), ts));
  assert.ok(events.some((e) => e.type === "pose" && e.kind === "palm"));

  // медленно провести рукой или водить вверх-вниз — не взмах
  const slow = new GestureTracker();
  const evs = [];
  for (let i = 0; i <= 40; i++) evs.push(...slow.update(G("palm", 0.2 + i * 0.012), i * 50));
  for (let i = 0; i <= 8; i++) evs.push(...slow.update(G("palm", 0.5, 0.1 + i * 0.08), 3000 + i * 33));
  assert.ok(!evs.some((e) => e.type === "swipe"));
  // путь обрывается, если рука сменила позу
  const cut = new GestureTracker();
  cut.update(G("palm", 0.2), 0);
  cut.update(G("fist", 0.3), 50);
  assert.deepEqual(cut.update(G("palm", 0.5), 100).filter((e) => e.type === "swipe"), []);
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

  // нажатие пальцем: кольцо на узле не в счёт, на кнопке — в счёт
  assert.equal(c.next(11000).id, "press");
  c.feed({ type: "dwell", progress: 0.7, id: "Ideas/x.md", press: false }, 11100);
  assert.equal(c.progress, 0);
  c.feed({ type: "dwell", progress: 0.7, id: null, press: true }, 11200);
  assert.equal(c.progress, 0.7);
  assert.equal(c.feed({ type: "press", label: "НАЖМИ МЕНЯ" }, 11300), true);

  // позы: засчитывает только удержанная своя поза
  for (const [i, kind] of ["victory", "thumb", "fist"].entries()) {
    const t0 = 12000 + i * 1000;
    assert.equal(c.next(t0).id, kind);
    assert.equal(c.feed({ type: "pose", kind: "palm" }, t0 + 10), false);
    c.feed({ type: "frame", kind }, t0 + 20);
    c.feed({ type: "hold", kind, progress: 0.5 }, t0 + 30);
    assert.equal(c.progress, 0.5);
    c.feed({ type: "frame", kind: "hand" }, t0 + 40);                     // рука сменила позу — сначала
    assert.equal(c.progress, 0);
    assert.equal(c.feed({ type: "pose", kind }, t0 + 900), true);
  }

  // взмах
  assert.equal(c.next(16000).id, "swipe");
  assert.equal(c.feed({ type: "rotate", amount: 3 }, 16100), false);
  assert.equal(c.feed({ type: "swipe", dir: "left" }, 16200), true);

  assert.equal(c.next(17000).id, "done");
  assert.ok(c.finished);
});

test("обучение только новым жестам — для тех, кто прошёл прежнее", () => {
  const c = new GestureCoach(STEPS, { start: NEW_STEPS_FROM });
  assert.equal(c.step.id, "press");
  assert.deepEqual(c.counter, { n: 1, total: 5 });
  assert.equal(c.next(0).id, "victory");
  assert.deepEqual(c.counter, { n: 2, total: 5 });
  assert.equal(new GestureCoach(STEPS, { start: "нет такого" }).step.id, "intro");
});

test("обучение: подсказка, когда руки не видно, и пропуск невозможного шага", () => {
  const c = new GestureCoach(STEPS, { hasNodes: false });
  c.next(0);
  assert.equal(c.handLost(2000), false);
  assert.equal(c.handLost(3500), true);                                    // 3 с без руки — подсказать про свет
  c.feed({ type: "frame", kind: "hand" }, 3600);
  assert.equal(c.handLost(4000), false);
  while (c.step.id !== "palm") c.skip(5000);
  assert.equal(c.next(5000).id, "press");                                  // заметок нет — выбор узла пропущен
});

// ---------- жесты для заметки ----------
const S = (over = {}) => ({ mode: "view", dirty: false, editable: true, armed: false, back: false, forward: false,
  dictation: true, ...over });
const act = (g, over) => noteAction(g, S(over))?.act ?? null;

test("жесты заметки: закрыть, править, сохранить, диктовать, листать", () => {
  // просмотр
  assert.equal(act("fist"), "close");
  assert.equal(act("victory"), "edit");
  assert.equal(act("victory", { editable: false }), null);              // большую заметку правят в Obsidian
  assert.equal(act("thumb"), null);
  assert.equal(act("swipe-right"), null);                               // истории нет — взмах повернёт граф
  assert.equal(act("swipe-right", { back: true }), "back");
  assert.equal(act("swipe-left", { forward: true }), "forward");
  assert.equal(act("palm"), null);                                      // ладонь — сброс вида, её делает голограмма
  // правка
  assert.equal(act("thumb", { mode: "edit" }), "save");
  assert.equal(act("victory", { mode: "edit" }), "dictate");
  assert.equal(act("victory", { mode: "edit", dictation: false }), null);
  assert.equal(act("fist", { mode: "edit" }), "cancel");                // правок нет — просто выйти
  assert.equal(act("fist", { mode: "edit", dirty: true }), "arm");      // правки есть — сначала предупредить
  assert.equal(act("fist", { mode: "edit", dirty: true, armed: true }), "cancel");
  assert.match(noteAction("fist", S({ mode: "edit", dirty: true, armed: true })).label, /выбросить/);
  assert.equal(act("swipe-left", { mode: "edit", forward: true }), null);
  // новая заметка и конфликт версий
  assert.equal(act("thumb", { mode: "create" }), "submit");
  assert.equal(act("victory", { mode: "create" }), "dictate-name");
  assert.equal(act("fist", { mode: "create" }), "leave");
  assert.equal(act("fist", { mode: "conflict" }), "back-edit");
  assert.equal(act("thumb", { mode: "conflict" }), null);               // перезаписать чужую версию — только кнопкой
});

test("жест распознан, но сейчас ни к чему — подсказка вместо тишины", () => {
  const hint = (g, over) => noteHint(g, S(over));
  assert.match(hint("thumb"), /сначала ✌/);                                // 👍 в просмотре
  assert.equal(hint("fist"), null);                                       // у ✊ в просмотре есть действие
  assert.match(hint("victory", { editable: false }), /Obsidian/);
  assert.match(hint("victory", { mode: "edit", dictation: false }), /речь/);
  assert.match(hint("thumb", { mode: "conflict" }), /кнопкой/);
  assert.equal(hint("swipe-left"), null);                                 // взмах без истории — поворот графа
  assert.equal(hint("palm"), null);
  // у каждой позы в каждом режиме — либо действие, либо подсказка (кроме конфликта: там ✊ — действие)
  for (const mode of ["view", "edit", "create", "conflict"]) {
    for (const g of ["fist", "victory", "thumb"]) {
      const s = S({ mode, dictation: false, editable: false });
      assert.ok(noteAction(g, s) || noteHint(g, s), `${mode}/${g}`);
    }
  }
});

test("история заметок для взмаха: назад, вперёд, новая ветка, удалённая заметка", () => {
  const t = new Trail();
  assert.equal(t.back, null);
  t.visit("a.md"); t.visit("b.md"); t.visit("b.md"); t.visit("c.md");
  assert.deepEqual(t.items, ["a.md", "b.md", "c.md"]);
  assert.equal(t.back, "b.md");
  assert.equal(t.forward, null);
  assert.equal(t.move(-1), "b.md");
  assert.equal(t.move(-1), "a.md");
  assert.equal(t.move(-1), null);
  assert.equal(t.forward, "b.md");
  t.visit("d.md");                                                      // открыли другую — «вперёд» обрезается
  assert.deepEqual(t.items, ["a.md", "d.md"]);
  t.drop("a.md");
  assert.deepEqual([t.items, t.at], [["d.md"], 0]);
  t.clear();
  assert.equal(t.forward, null);
  const lim = new Trail(3);
  ["1", "2", "3", "4"].forEach((p) => lim.visit(p));
  assert.deepEqual([lim.items, lim.back], [["2", "3", "4"], "3"]);
});

test("диктовка: строка с голоса встаёт в заметку в формате Obsidian", () => {
  assert.equal(dictationLine("  задача   купить молоко "), "- [ ] Купить молоко");
  assert.equal(dictationLine("Задачу: позвонить в банк"), "- [ ] Позвонить в банк");
  assert.equal(dictationLine("пункт цены для разработчиков"), "- Цены для разработчиков");
  assert.equal(dictationLine("заголовок итоги недели"), "## Итоги недели");
  assert.equal(dictationLine("обсудили оферту"), "Обсудили оферту");
  assert.equal(dictationLine("задачи"), "Задачи");                      // одно слово — просто текст
  assert.equal(dictationLine(""), "");

  // курсор на непустой строке — новой строкой после неё
  let r = insertDictation("# План\nпервое\nвторое", 9, "задача купить молоко");
  assert.deepEqual(r, { value: "# План\nпервое\n- [ ] Купить молоко\nвторое", cursor: 33 });
  // пустая строка — прямо в неё
  r = insertDictation("# План\n\n", 7, "итоги");
  assert.equal(r.value, "# План\nИтоги\n");
  // «☐ задача» нажали пальцем — маркер уже есть, второй не ставим
  r = insertDictation("# План\n- [ ] ", 13, "задача купить хлеб");
  assert.deepEqual(r, { value: "# План\n- [ ] Купить хлеб", cursor: 24 });
  r = insertDictation("- [ ] ", 6, "позвонить маме");
  assert.equal(r.value, "- [ ] Позвонить маме");
  // в конец текста по умолчанию; тишина — ничего
  assert.equal(insertDictation("абв", undefined, "где").value, "абв\nГде");
  assert.equal(insertDictation("абв", 3, "  "), null);
});
