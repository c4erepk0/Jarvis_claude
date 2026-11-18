// Хранилище: сортировка, избранное, обзор (хабы, сироты, несозданные заметки) — file-tree.js.
import assert from "node:assert/strict";
import { test } from "node:test";

import { renamePaths, sortFiles, toggleFav, vaultStats } from "../../jarvis/webapp/static/file-tree.js";

const f = (path, extra = {}) => ({ path, title: path.split("/").pop().replace(/\.md$/, ""), folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  ext: ".md", size: 700, mtime: 100, tags: [], links: [], ...extra });

test("сортировка по имени, изменению и размеру", () => {
  const files = [f("б.md", { mtime: 3, size: 10 }), f("а.md", { mtime: 1, size: 30 }), f("в.md", { mtime: 2, size: 20 })];
  assert.deepEqual(sortFiles(files).map((x) => x.title), ["а", "б", "в"]);
  assert.deepEqual(sortFiles(files, "mtime").map((x) => x.title), ["б", "в", "а"]);
  assert.deepEqual(sortFiles(files, "size").map((x) => x.title), ["а", "в", "б"]);
  assert.equal(files[0].title, "б");      // исходный список не меняется
});

test("избранное: добавить, убрать, пережить переименование папки", () => {
  let fav = toggleFav([], "A.md");
  fav = toggleFav(fav, "Dir/B.md");
  assert.deepEqual(fav, ["Dir/B.md", "A.md"]);
  assert.deepEqual(toggleFav(fav, "A.md"), ["Dir/B.md"]);
  assert.deepEqual(renamePaths(fav, "Dir", "New"), ["New/B.md", "A.md"]);
  assert.deepEqual(renamePaths(fav, "A.md", "Z.md"), ["Dir/B.md", "Z.md"]);
});

test("обзор: хабы, сироты, ссылки в никуда, служебное не в счёт", () => {
  const index = {
    folders: ["Projects", "Templates"], tags: [{ tag: "x", count: 1 }],
    files: [
      f("Projects/Atom.md", { links: ["Идеи", "Каталог приложений"], mtime: 50 }),
      f("Projects/Идеи.md", { links: ["Projects/Atom", "Atom|алиас"], mtime: 60 }),
      f("Journal/2026-11-18.md", { links: ["Atom#Задачи", "Каталог приложений", "Склад"], mtime: 70 }),
      f("Одинокая.md", { mtime: 10 }),
      f("Templates/День.md", { mtime: 99 }),
      { path: "data.csv", title: "data", folder: "", ext: ".csv", size: 5, mtime: 1, links: [] },
    ],
  };
  const s = vaultStats(index);
  assert.equal(s.notes, 5);
  assert.equal(s.folders, 2);
  assert.deepEqual(s.hubs.map((h) => [h.title, h.incoming]), [["Atom", 2], ["Идеи", 1]]);
  assert.deepEqual(s.orphans.map((o) => o.title), ["Одинокая"]);           // шаблоны — не сироты
  assert.deepEqual(s.missing, [{ name: "Каталог приложений", from: ["Projects/Atom.md", "Journal/2026-11-18.md"] },
    { name: "Склад", from: ["Journal/2026-11-18.md"] }]);
  assert.equal(s.recent[0].title, "2026-11-18");                           // Templates/ — не в «недавних»
  assert.ok(s.words > 0);
});
