// Каталог приложений в интерфейсе: встроенные приложения, свои из каталога, поиск, встраивание (apps-catalog.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN, GROUPS, appIcon, embeddable, groupedBuiltin, launcherItems } from "../../jarvis/webapp/static/apps-catalog.js";

const CENNIKI = { name: "Ценники", note: "Apps/Ценники.md", kind: "app", icon: "🏷", url: "https://c4erepk0.github.io/cenniki/",
  description: "Ценники, прайс-листы и печатная продукция" };

test("карта, финансы и хранилище — в каталоге, а не в навигации", () => {
  const ids = BUILTIN.map((b) => b.id);
  for (const id of ["map", "finance", "files", "system"]) assert.ok(ids.includes(id), id);
  const r = launcherItems({ apps: [CENNIKI] });
  assert.equal(r.builtin.length, BUILTIN.length);
  assert.equal(r.own[0].name, "Ценники");
  assert.equal(r.own[0].embeddable, true);
  assert.equal(r.own[0].i, 0);
});

test("на iPhone без сервера — без «Команды»", () => {
  const r = launcherItems({ standalone: true });
  assert.ok(!r.builtin.some((b) => b.id === "team" || b.id === "globe"));     // ленты новостей — только с сервера
  assert.ok(launcherItems({}).builtin.some((b) => b.id === "globe"));
  assert.ok(r.builtin.some((b) => b.id === "system"));
});

test("поиск по названию и описанию, без учёта ё и регистра", () => {
  assert.deepEqual(launcherItems({ apps: [CENNIKI], query: "прайс" }).own.map((a) => a.name), ["Ценники"]);
  assert.deepEqual(launcherItems({ apps: [CENNIKI], query: "КАРТ" }).builtin.map((a) => a.id), ["map"]);
  assert.equal(launcherItems({ apps: [CENNIKI], query: "зачет" }).own.length, 0);
});

test("встраивать — только https; значок — эмодзи или буква", () => {
  assert.equal(embeddable("https://example.com/app/"), true);
  assert.equal(embeddable("http://example.com"), false);
  assert.equal(embeddable("javascript:alert(1)"), false);
  assert.equal(embeddable(""), false);
  assert.equal(appIcon(CENNIKI), "🏷");
  assert.equal(appIcon({ name: "студия" }), "С");
});

test("«Обмен файлами» — приложение каталога и только с сервером", () => {
  assert.ok(BUILTIN.some((b) => b.id === "exchange"));
  assert.ok(!launcherItems({ standalone: true }).builtin.some((b) => b.id === "exchange"));
});

test("приложения сгруппированы по делу: дела, люди, анализ, система", () => {
  const ids = GROUPS.map(([id]) => id);
  for (const b of BUILTIN) assert.ok(ids.includes(b.group), `${b.id}: ${b.group}`);
  const groups = groupedBuiltin(launcherItems({}).builtin);
  assert.deepEqual(groups.map((g) => g.id), ["deals", "people", "analysis", "system"]);
  assert.ok(groups.every((g) => g.items.length), "пустые группы не показываем");
});
