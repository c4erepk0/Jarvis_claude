// Умный синтез проектов в ядре для iPhone — те же сценарии, что tests/test_synthesis.py.
// fixtures/synthesis.json — вход и ответ Python (jarvis/synthesis.py): JS должен ответить так же.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { parse } from "../../jarvis/webapp/static/core/intents.js";
import { description, synthesize, tagTitle } from "../../jarvis/webapp/static/core/synthesis.js";
import { LocalStore } from "../../jarvis/webapp/static/core/vault.js";
import { markSynthesis } from "../../jarvis/webapp/static/file-tree.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const FIX = JSON.parse(readFileSync(new URL("./fixtures/synthesis.json", import.meta.url), "utf8"));
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
const offline = async () => { throw new TypeError("offline"); };

test("синтез: тот же ответ, что у Python", () => {
  assert.deepEqual(synthesize(FIX.files, FIX.projects, FIX.tasks), FIX.expected);
  assert.equal(tagTitle("сайт-студии"), "Сайт студии");
  const c = FIX.expected.candidates.find((x) => x.name === "Ремонт");
  assert.match(description(c), /\[\[Ремонт\/Кухня\|Кухня\]\]/);
});

test("синтез: подсветка папок дерева", () => {
  const hl = FIX.expected.highlight;
  const marks = markSynthesis(hl);
  assert.deepEqual(marks.get("Ремонт/Кухня.md"), { kind: "candidate", project: "Ремонт" });
  assert.equal(marks.get("Ремонт").kind, "candidate");             // папка, где есть кандидат, тоже светится
  assert.equal(marks.get("Ideas").kind, "project");                  // проект важнее кандидата
  assert.equal(marks.get("Templates"), undefined);
});

test("синтез: голос, REST и оформление кандидата проектом", async () => {
  assert.equal(parse("Атом, синтез проектов", "2026-11-09").name, "synthesis");
  assert.equal(parse("статус проектов", "2026-11-09").name, "project_status");
  const j = await new Jarvis({ title: "сэр", city: "Москва", lat: 55.75, lon: 37.62, currency: "RUB" },
    { store: new LocalStore("t", template()), clock: () => new Date(2026, 10, 16, 9, 5), fetchImpl: offline }).init();
  for (const n of ["Кухня", "Ванная", "Смета"]) await j.actCreateNote(`Ремонт/${n}`, null, `# ${n}\n- [ ] замер #ремонт\n`);
  const seen = [];
  j.on((e) => seen.push(e.type));
  const r = await j.handle("атом, синтез проектов");
  assert.match(r.text, /Ремонт/);
  assert.ok(seen.includes("open_synthesis"));
  assert.equal(r.data.highlight["Ремонт/Кухня.md"].kind, "candidate");
  assert.ok(r.data.projects.find((p) => p.name === "Atom").notes.includes("Tasks/Inbox.md"));

  const syn = await j.request("GET", "/api/synthesis");
  assert.ok(syn.candidates.some((c) => c.name === "Ремонт"));
  const p = await j.request("POST", "/api/synthesis", { name: "ремонт" });
  assert.equal(p.note, "Projects/Ремонт.md");
  assert.equal(p.status, "idea");
  const text = j.vault.read("Projects/Ремонт.md");
  assert.match(text, /tag: ремонт/);
  assert.match(text, /\[\[Ремонт\/Кухня\|Кухня\]\]/);
  const after = await j.request("GET", "/api/synthesis");
  assert.ok(after.candidates.every((c) => c.name !== "Ремонт"));
  assert.deepEqual(after.highlight["Ремонт/Смета.md"], { kind: "project", project: "Ремонт" });
  const ov = await j.request("GET", `/api/projects/${encodeURIComponent("Ремонт")}`);
  assert.deepEqual(new Set(ov.notes.map((n) => n.path)), new Set(["Ремонт/Кухня.md", "Ремонт/Ванная.md", "Ремонт/Смета.md"]));
  assert.equal(ov.progress.total, 3);
  await assert.rejects(() => j.request("POST", "/api/synthesis", { name: "нет такого" }), /нет кандидата/);
});
