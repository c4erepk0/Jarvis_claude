// Менеджер окон: ленивая загрузка, одно окно на экране, Esc и отказ закрыться (несохранённая правка).
// Проверяется без DOM — окна подменяются объектами с show/close/escape.
import assert from "node:assert/strict";
import { test } from "node:test";

import { WindowManager } from "../../jarvis/webapp/static/windows.js";

function fake(name, log, { refuses = false } = {}) {
  return {
    name, isOpen: false, arg: undefined,
    async show(arg) { this.isOpen = true; this.arg = arg; },
    close() { if (refuses) return false; this.isOpen = false; log.push(`close:${name}`); },
  };
}

test("окно создаётся лениво и один раз", async () => {
  const wins = new WindowManager();
  let loads = 0;
  wins.register("a", { load: async () => { loads += 1; return fake("a", []); } });
  const first = await wins.open("a");
  const second = await wins.open("a");
  assert.equal(loads, 1);
  assert.equal(first, second);
  assert.equal(wins.isOpen("a"), true);
  assert.equal(wins.get("a"), first);
});

test("открытие другого окна закрывает прежнее и передаёт аргумент", async () => {
  const log = [];
  const wins = new WindowManager();
  wins.register("a", { load: async () => fake("a", log) });
  wins.register("b", { load: async () => fake("b", log) });
  await wins.open("a");
  await wins.open("b", { tab: "meet" });
  assert.deepEqual(log, ["close:a"]);
  assert.equal(wins.isOpen("a"), false);
  assert.equal(wins.isOpen("b"), true);
  assert.equal(wins.get("b").arg.tab, "meet");
});

test("Esc закрывает верхнее; окно, закрытое само, из стека уходит", async () => {
  const log = [];
  const wins = new WindowManager();
  wins.register("a", { load: async () => fake("a", log) });
  await wins.open("a");
  wins.get("a").isOpen = false;                 // окно закрылось своей кнопкой
  assert.equal(wins.dismiss(), false);          // закрывать нечего
  assert.equal(wins.anyOpen(), false);
  assert.deepEqual(log, []);

  await wins.open("a");                         // открывается снова тем же экземпляром
  assert.equal(wins.isOpen("a"), true);
  assert.equal(wins.dismiss(), true);
  assert.deepEqual(log, ["close:a"]);
  assert.equal(wins.anyOpen(), false);
});

test("окно с несохранённой правкой не закрывается — и новое не открывается", async () => {
  const log = [];
  const wins = new WindowManager();
  wins.register("files", { load: async () => fake("files", log, { refuses: true }) });
  wins.register("finance", { load: async () => fake("finance", log) });
  await wins.open("files");
  assert.equal(await wins.open("finance"), null);
  assert.equal(wins.isOpen("files"), true);
  assert.equal(wins.isOpen("finance"), false);
  assert.equal(wins.close("files"), false);
});

test("неизвестное окно — понятная ошибка, а isOpen/get не падают", async () => {
  const wins = new WindowManager();
  await assert.rejects(() => wins.open("нет-такого"), /Неизвестное окно/);
  assert.equal(wins.isOpen("нет-такого"), false);
  assert.equal(wins.get("нет-такого"), null);
  assert.equal(wins.has("нет-такого"), false);
});
