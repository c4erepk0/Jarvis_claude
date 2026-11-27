// Версии ассетов в webapp: один номер ?v= во всех импортах и тот же в CACHE сервис-воркера.
//
// Зачем тест: модули импортируют друг друга с ?v=N. Если поднять версию только у входа (index/app.js),
// браузер продолжает отдавать старые копии модулей по старому URL — интерфейс обновляется наполовину
// (так «Диск» не появлялся в каталоге, хотя app.js уже был новый).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../../jarvis/webapp/", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(js|html)$/.test(e.name) ? [p] : [];
  });
}

test("во всех импортах и в CACHE — одна версия ассетов", () => {
  // static/core/ — ядро для iPhone без сборки: там свои импорты без ?v=, его грузит standalone.js
  const files = walk(ROOT).filter((f) => !f.includes("/core/"));
  const versions = new Set();
  const bare = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\?v=(\d+)/g)) versions.add(m[1]);
    // локальный импорт без версии — его потом не обновить
    for (const m of text.matchAll(/from\s+"(\.\/(?!core\/)[^"?]+\.js)"/g)) bare.push(`${f.slice(ROOT.length)}: ${m[1]}`);
  }
  assert.ok(versions.size > 0, "в webapp нет ни одного ?v=");
  assert.equal(versions.size, 1, `разные версии ассетов: ${[...versions].join(", ")}`);
  assert.deepEqual(bare, [], `импорты без ?v=:\n${bare.join("\n")}`);

  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const cacheVersion = sw.match(/const V = "(\d+)"/)?.[1];
  assert.ok(cacheVersion, "в sw.js нет const V");
  assert.equal(cacheVersion, [...versions][0], "версия CACHE и ?v= разошлись");
});
