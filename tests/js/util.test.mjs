// Общие помощники интерфейса: экранирование и даты (util.js). Раньше esc был скопирован в шести файлах,
// а «сегодня» собиралось вручную в четырёх — тест держит один экземпляр и одинаковое поведение.
import assert from "node:assert/strict";
import { test } from "node:test";

import { esc, fmtDay, todayISO } from "../../jarvis/webapp/static/util.js";

test("esc закрывает пять опасных символов и не падает на null", () => {
  assert.equal(esc(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});

test("todayISO — всегда ГГГГ-ММ-ДД, из Date и из строки сервера", () => {
  assert.equal(todayISO(new Date(2026, 10, 28, 23, 59)), "2026-11-28");
  assert.equal(todayISO("2026-11-28T17:00:00+05:00"), "2026-11-28");
  assert.equal(todayISO("2026-03-01"), "2026-03-01");
  assert.equal(todayISO("не дата"), "");
  assert.equal(todayISO(null), "");
});

test("fmtDay — короткая дата для человека, пустая — свой текст", () => {
  const d = fmtDay("2026-11-28");
  assert.match(d, /28/);
  assert.notEqual(d, "2026-11-28");       // это дата для человека, а не ISO
  assert.equal(fmtDay("", { empty: "без даты" }), "без даты");
  assert.equal(fmtDay(null), "");
});
