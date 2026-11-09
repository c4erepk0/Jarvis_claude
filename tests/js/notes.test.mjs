// Заметки в голограмме в ядре для iPhone: версия (как в Python), правка без затирания чужих изменений,
// маршруты /api/note, «открой заметку …», инструменты мозга для заметок. node --test tests/js
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { speechText } from "../../jarvis/webapp/static/core/ru.js";
import { LocalStore, VaultConflict, contentVersion } from "../../jarvis/webapp/static/core/vault.js";

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
const CLOCK = () => new Date(2026, 10, 9, 9, 15);
const offline = async () => { throw new TypeError("offline"); };

async function makeJarvis(extra = {}, opts = {}) {
  const j = new Jarvis({ title: "сэр", city: "Москва", lat: 55.75, lon: 37.62, currency: "RUB", ...extra },
    { store: new LocalStore("t", template()), clock: CLOCK, fetchImpl: offline, ...opts });
  return j.init();
}

test("версия содержимого совпадает с Python (jarvis/vault.py)", () => {
  assert.equal(contentVersion(""), "0-811c9dc5");
  assert.equal(contentVersion("привет"), "12-8148137f");
  assert.equal(contentVersion("# Заметка\n- [ ] задача\n"), "36-402b75cb");
});

test("правка из голограммы не затирает изменения из Obsidian", async () => {
  const j = await makeJarvis();
  const n = await j.request("GET", "/api/note?path=Projects/IPAStore.md");
  assert.equal(n.title, "IPAStore");
  assert.ok(n.editable);
  assert.equal(n.version, contentVersion(n.content));
  const text = `${n.content}\n## Идеи\n- экспорт в CSV\n`;
  const saved = await j.request("PUT", "/api/note", { path: n.path, content: text, base: n.version });
  assert.equal(saved.version, contentVersion(text));
  await j.vault.write("Projects/IPAStore.md", `${text}- правка с телефона\n`);   // тем временем — Obsidian
  await assert.rejects(() => j.request("PUT", "/api/note", { path: n.path, content: "затёр", base: saved.version }),
    (e) => e.status === 409 && e.data.conflict && /правка с телефона/.test(e.data.current.content));
  assert.match(j.vault.read("Projects/IPAStore.md"), /правка с телефона/);

  const created = await j.request("POST", "/api/note", { path: "Ideas/Голограмма", content: "# Идея\n" });
  assert.equal(created.path, "Ideas/Голограмма.md");
  await assert.rejects(() => j.request("POST", "/api/note", { path: "Ideas/Голограмма.md", content: "x" }), (e) => e.status === 409);
  await assert.rejects(() => j.request("POST", "/api/note", { path: "../etc/passwd", content: "x" }));
  await assert.rejects(() => j.request("POST", "/api/note", { path: "a.canvas", content: "{}" }));
  await assert.rejects(() => j.request("PUT", "/api/note", { path: "Home.md", content: "x" }), (e) => e.status === 400);
  await assert.rejects(() => j.vault.save("Home.md", "x", null), (e) => e instanceof VaultConflict);
  assert.equal(j.vault.findNote("ipastore"), "Projects/IPAStore.md");
  assert.equal(j.vault.findNote("Projects/Jarvis"), "Projects/Jarvis.md");
  assert.equal(j.vault.findNote("несуществующее-слово-xyz"), null);
});

test("«открой заметку» показывает её в голограмме", async () => {
  const j = await makeJarvis();
  const seen = [];
  j.on((e) => seen.push(e));
  const r = await j.handle("Джарвис, открой заметку IPAStore");
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.data, { open_note: "Projects/IPAStore.md" });
  assert.ok(seen.some((e) => e.type === "open_note" && e.data.path === "Projects/IPAStore.md"));
  assert.equal((await j.handle("открой заметку квантовый-телепорт-xyz")).kind, "error");
});

test("речь без markdown — как speech_text в Python", () => {
  assert.equal(speechText("**Готово**, сэр. Задачи:\n- [ ] купить молоко\n- позвонить _маме_\n\n"
    + "См. [[Projects/IPAStore|IPAStore]] и [сайт](https://x.ru)"),
  "Готово, сэр. Задачи: купить молоко. позвонить маме. См. IPAStore и сайт");
  assert.equal(speechText("## План\n1. Шаг один\n2) Шаг два"), "План. Шаг один. Шаг два");
  assert.equal(speechText("файл snake_case_name и 2*3=6"), "файл snake_case_name и 2*3=6");
});

test("мозг правит открытую заметку инструментами", async () => {
  const calls = [];
  const tool = (name, input, id) => ({ type: "tool_use", name, input, id });
  const script = [
    { content: [tool("note_read", { path: "IPAStore" }, "t1")], stop_reason: "tool_use" },
    { content: [tool("note_edit", { path: "Projects/IPAStore.md", find: "status: active", replace: "status: paused" }, "t2"),
      tool("note_edit", { path: "Projects/IPAStore.md", find: "нет такого фрагмента", replace: "x" }, "t3")], stop_reason: "tool_use" },
    { content: [tool("notes_list", { folder: "Projects" }, "t4"), tool("note_show", { path: "Jarvis" }, "t5"),
      tool("note_create", { path: "Ideas/План", text: "# План\n" }, "t6")], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "**Готово**, сэр:\n- статус — пауза" }], stop_reason: "end_turn" },
  ];
  const client = { beta: { messages: { create: async (req) => { calls.push({ ...req, messages: [...req.messages] }); return script.shift(); } } } };
  const factory = async () => client;
  factory.fake = true;
  const j = await makeJarvis({ anthropicKey: "sk-test" }, { clientFactory: factory });
  const seen = [];
  j.on((e) => seen.push(e));
  const r = await j.request("POST", "/api/command", { text: "поставь этот проект на паузу", note: "Projects/IPAStore.md" });
  assert.equal(r.speech, "Готово, сэр: статус — пауза");
  assert.match(j.vault.read("Projects/IPAStore.md"), /status: paused/);
  assert.equal(j.vault.read("Ideas/План.md"), "# План\n");
  assert.match(calls[0].messages[0].content, /\[В голограмме открыта заметка: Projects\/IPAStore\.md\]/);
  const results = calls.at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result");
  assert.ok(results.some((b) => b.is_error && /фрагмент не найден/.test(b.content)));
  assert.ok(seen.some((e) => e.type === "open_note" && e.data.path === "Projects/Jarvis.md"));
});
