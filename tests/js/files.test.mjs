// Менеджер заметок и проектов в ядре для iPhone — те же сценарии, что tests/test_files.py.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { fillTemplate, noteTags, rewriteLinks } from "../../jarvis/webapp/static/core/notes.js";
import { GitHubStore, LocalStore, setFrontmatterField } from "../../jarvis/webapp/static/core/vault.js";
import { buildTree, filterFiles, moveTarget, pushRecent, renameTarget } from "../../jarvis/webapp/static/file-tree.js";

const ROOT = new URL("../../", import.meta.url).pathname;
function template() {
  const base = join(ROOT, "vault-template");
  const out = {};
  const walk = (d) => readdirSync(d).forEach((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p); else out[relative(base, p)] = readFileSync(p, "utf8");
  });
  walk(base);
  return out;
}
const CLOCK = () => new Date(2026, 10, 16, 9, 5);
const offline = async () => { throw new TypeError("offline"); };
async function makeJarvis() {
  const j = new Jarvis({ title: "сэр", city: "Москва", lat: 55.75, lon: 37.62, currency: "RUB" },
    { store: new LocalStore("t", template()), clock: CLOCK, fetchImpl: offline });
  return j.init();
}

test("ссылки, теги, шаблон и поле frontmatter — как в Python", () => {
  const text = "[[IPAStore]] · [[Projects/IPAStore#Задачи|задачи]] · [[ipastore.md]] · [[IPAStore 2]] · [[Other/IPAStore]]";
  assert.equal(rewriteLinks(text, "Projects/IPAStore.md", "Archive/IPA Store.md"),
    "[[IPA Store]] · [[Archive/IPA Store#Задачи|задачи]] · [[IPA Store]] · [[IPAStore 2]] · [[Other/IPAStore]]");
  const t = "---\ntags: [Работа, идея]\n---\n# X\nтекст #ipastore и #идея, не #123 и не `#код`\n```\n#код\n```\nhttp://a.ru/#frag\n";
  assert.deepEqual(noteTags(t), ["работа", "идея", "ipastore"]);
  assert.equal(fillTemplate("# {{title}}\n{{date}} {{time}}", "Встреча", CLOCK()), "# Встреча\n2026-11-16 09:05");
  const src = "---\ntype: project\nstatus: active\ntags:\n  - a\nrepo: x/y\n---\n# P\n";
  assert.equal(setFrontmatterField(src, "status", "paused"), src.replace("active", "paused"));
  assert.equal(setFrontmatterField(src, "tags", ["b"]), "---\ntype: project\nstatus: active\ntags: [b]\nrepo: x/y\n---\n# P\n");
  assert.equal(setFrontmatterField("# P\n", "status", "done"), "---\nstatus: done\n---\n# P\n");
});

test("индекс, шаблоны, обратные ссылки, переименование с правкой ссылок, папки, корзина", async () => {
  const j = await makeJarvis();
  const idx = await j.request("GET", "/api/files");
  assert.ok(idx.templates.includes("Templates/Встреча.md"));
  assert.ok(idx.folders.includes("Projects") && idx.tags[0].tag === "ipastore");

  const r = await j.request("POST", "/api/files/new", { path: "Встречи/Созвон", template: "Templates/Встреча.md" });
  assert.equal(r.path, "Встречи/Созвон.md");
  assert.match(j.vault.read(r.path), /# Созвон/);
  assert.doesNotMatch(j.vault.read(r.path), /\{\{/);
  await assert.rejects(() => j.request("POST", "/api/files/new", { path: "Встречи/Созвон.md" }), /уже есть/);
  await j.request("POST", "/api/files/new", { path: "Ideas/X", content: "см. [[Projects/IPAStore#Задачи|тут]] и [[IPAStore]] #идея\n" });

  const note = await j.request("GET", "/api/note?path=Projects/IPAStore.md");
  assert.ok(note.backlinks.some((b) => b.path === "Ideas/X.md") && note.tags.includes("ipastore"));

  const mv = await j.request("POST", "/api/files/move", { from: "Projects/IPAStore.md", to: "Projects/IPA Store" });
  assert.equal(mv.path, "Projects/IPA Store.md");
  assert.ok(mv.updated.includes("Home.md") && mv.updated.includes("Ideas/X.md"));
  assert.equal(j.vault.read("Ideas/X.md"), "см. [[Projects/IPA Store#Задачи|тут]] и [[IPA Store]] #идея\n");
  assert.ok(!j.vault.exists("Projects/IPAStore.md") && j.projects.get("IPA Store").repo === "c4erepk0/IPAStore");

  await j.request("POST", "/api/files/folder", { path: "Archive" });
  assert.ok((await j.request("GET", "/api/files")).folders.includes("Archive"));      // пустая папка видна
  await assert.rejects(() => j.request("POST", "/api/files/folder", { path: "Archive" }), /уже есть/);
  const mf = await j.request("POST", "/api/files/move", { from: "Ideas", to: "Archive/Ideas" });
  assert.equal(mf.moved, 1);
  assert.ok(j.vault.exists("Archive/Ideas/X.md") && !j.vault.isDir("Ideas"));
  await assert.rejects(() => j.request("POST", "/api/files/move", { from: "Archive", to: "Archive/Sub" }), /внутрь/);
  await assert.rejects(() => j.request("POST", "/api/files/move", { from: "Home.md", to: "Встречи/Созвон.md" }), /уже есть/);
  await assert.rejects(() => j.request("POST", "/api/files/move", { from: "Home.md", to: "../Home.md" }));

  const tr = await j.request("POST", "/api/files/trash", { path: "Archive/Ideas/X.md" });
  assert.equal(tr.trash, ".trash/Archive/Ideas/X.md");
  assert.ok(!j.vault.exists("Archive/Ideas/X.md"));
  await j.request("POST", "/api/files/new", { path: "Archive/Ideas/X.md", content: "второй\n" });
  assert.equal((await j.request("POST", "/api/files/trash", { path: "Archive/Ideas/X.md" })).trash, ".trash/Archive/Ideas/X 2.md");
  assert.ok(!(await j.request("GET", "/api/files")).folders.some((f) => f.startsWith(".")));
  await assert.rejects(() => j.request("POST", "/api/files/trash", { path: "нет.md" }), (e) => e.status === 404);
});

test("проекты: создание, задачи в заметке проекта, прогресс, статус, голос", async () => {
  const j = await makeJarvis();
  const p = await j.request("POST", "/api/projects", { name: "Сайт студии", description: "Лендинг", status: "idea" });
  assert.equal(p.note, "Projects/Сайт студии.md");
  assert.equal(p.tag, "сайт-студии");
  await assert.rejects(() => j.request("POST", "/api/projects", { name: "сайт студии" }), /уже есть/);
  const t = await j.request("POST", `/api/projects/${encodeURIComponent("Сайт студии")}/task`, { text: "сверстать главную" });
  assert.equal(t.path, "Projects/Сайт студии.md");
  await j.actAddTask("купить домен", null, null, "Сайт студии");
  await j.request("POST", "/api/files/new", { path: "Projects/Сайт студии/Бриф", content: "# Бриф\n- [ ] согласовать цвета\n" });
  await j.request("POST", "/api/files/new", { path: "Ideas/Логотип", content: "для [[Сайт студии]]\n" });
  await j.actCompleteTask(null, "купить домен");

  assert.deepEqual(j.projects.list().map((x) => x.name), ["IPAStore", "Jarvis", "Сайт студии"]);
  const ov = await j.request("GET", `/api/projects/${encodeURIComponent("сайт студии")}`);
  assert.deepEqual(ov.progress, { done: 1, total: 3, percent: 33 });
  assert.deepEqual(new Set(ov.tasks.map((x) => x.text)), new Set(["сверстать главную", "согласовать цвета"]));
  assert.deepEqual(ov.notes.map((n) => n.path), ["Projects/Сайт студии/Бриф.md", "Ideas/Логотип.md"]);
  assert.match(ov.journal[0], /Проект создан$/);

  const upd = await j.request("POST", `/api/projects/${encodeURIComponent("Сайт студии")}/update`, { key: "status", value: "active" });
  assert.equal(upd.status, "active");
  assert.match(j.vault.read("Projects/Сайт студии.md"), /status: active[\s\S]*Статус: в работе/);

  let r = await j.handle("создай проект «Кофейня»");
  assert.equal(r.kind, "ok");
  assert.ok(j.vault.exists("Projects/Кофейня.md"));
  assert.deepEqual((await j.handle("открой проект кофейня")).data, { open_project: "Кофейня" });
  assert.deepEqual((await j.handle("открой хранилище")).data, { open_files: true });
  r = await j.handle("удали заметку Кофейня");
  assert.equal(r.kind, "warn");
  assert.ok(j.vault.exists("Projects/Кофейня.md"));
  assert.equal((await j.confirm(r.confirm.id)).kind, "ok");
  assert.ok(!j.vault.exists("Projects/Кофейня.md"));
});

test("GitHub-склад: удаление и корзина — через Contents API", async () => {
  const calls = [];
  const gh = { async request(method, path, opts = {}) {
    calls.push([method, decodeURIComponent(path), opts.body && opts.body.sha]);
    if (method === "PUT") return { content: { sha: `sha-${calls.length}` } };
    return {};
  } };
  const store = new GitHubStore(gh, "me/vault");
  store.shas.set("Ideas/X.md", "old");
  await store.update(".trash/Ideas/X.md", () => "текст", "в корзину", undefined);
  await store.remove("Ideas/X.md", "в корзину");
  assert.deepEqual(calls, [["PUT", "/repos/me/vault/contents/.trash/Ideas/X.md", undefined],
    ["DELETE", "/repos/me/vault/contents/Ideas/X.md", "old"]]);
  assert.ok(!store.shas.has("Ideas/X.md") && store.has(".trash/Ideas/X.md"));
});

test("дерево хранилища для менеджера: папки, фильтр, недавние, новые пути", () => {
  const idx = { folders: ["Archive", "Projects", "Projects/IPAStore"], files: [
    { path: "Home.md", title: "Home", folder: "", tags: [] },
    { path: "Projects/IPAStore.md", title: "IPAStore", folder: "Projects", tags: ["ipastore"] },
    { path: "Projects/IPAStore/Бриф.md", title: "Бриф", folder: "Projects/IPAStore", tags: ["ipastore", "дизайн"] }] };
  const tree = buildTree(idx);
  assert.deepEqual(tree.children.map((n) => n.name), ["Archive", "Projects", "Home"]);       // папки — первыми
  const proj = tree.children[1];
  assert.equal(proj.count, 2);
  assert.deepEqual(proj.children.map((n) => n.name), ["IPAStore", "IPAStore"]);              // папка и заметка
  assert.deepEqual(filterFiles(idx.files, { tag: "дизайн" }).map((f) => f.title), ["Бриф"]);
  assert.deepEqual(filterFiles(idx.files, { query: "ipa" }).map((f) => f.title), ["Бриф", "IPAStore"]);   // и по пути
  assert.deepEqual(filterFiles(idx.files, { query: "БРИФ" }).map((f) => f.title), ["Бриф"]);
  assert.deepEqual(filterFiles(idx.files, { folder: "Projects" }).map((f) => f.title), ["IPAStore"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "c", 3), ["c", "a", "b"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
  assert.equal(moveTarget("Projects/IPAStore/Бриф.md", "Archive"), "Archive/Бриф.md");
  assert.equal(moveTarget("Projects/IPAStore", ""), "IPAStore");
  assert.equal(moveTarget("Archive", "Archive/Sub"), null);                                   // внутрь себя — нельзя
  assert.equal(renameTarget("Projects/IPAStore.md", "IPA Store"), "Projects/IPA Store.md");
  assert.equal(renameTarget("Projects/IPAStore", "Old/X"), null);                             // в имени нет «/»
});
