// Сценарии ядра для iPhone: команды, Claude (фейковый клиент), синхронизация через GitHub (фейковый API).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { FALLBACK_BETA } from "../../jarvis/webapp/static/core/brain.js";
import { GitHub } from "../../jarvis/webapp/static/core/github.js";
import { GitHubStore, LocalStore, decodeBase64, encodeBase64 } from "../../jarvis/webapp/static/core/vault.js";

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
const CLOCK = () => new Date(2026, 10, 9, 9, 15);   // понедельник, 09:15
const offline = async () => { throw new TypeError("offline"); };
const settings = (extra = {}) => ({ title: "сэр", city: "Москва", lat: 55.75, lon: 37.62, currency: "RUB", ...extra });

async function makeJarvis(extra = {}, opts = {}) {
  const j = new Jarvis(settings(extra), { store: new LocalStore("t", template()), clock: CLOCK, fetchImpl: offline, ...opts });
  return j.init();
}

test("команды без Claude пишут в Obsidian", async () => {
  const j = await makeJarvis();
  let r = await j.handle("Джарвис, добавь задачу проверить оплату Stars для IPAStore сегодня, срочно");
  assert.equal(r.kind, "ok");
  assert.match(r.text, /добавлена на сегодня/);
  assert.match(j.vault.read("Tasks/Inbox.md"), /проверить оплату Stars #ipastore ⏫ ➕ 2026-11-09 📅 2026-11-09/);
  r = await j.handle("задачи на сегодня");
  assert.match(r.text, /проверить оплату Stars/);
  r = await j.handle("минус 28000 продукты");
  assert.equal(r.kind, "warn");
  assert.match(r.text, /Еда.*93%/);
  r = await j.handle("выполнил проверить оплату");
  assert.equal(r.kind, "ok");
  await j.handle("запомни, что IPAStore — главный проект");
  assert.match((await j.handle("что ты знаешь обо мне")).text, /главный проект/);
  r = await j.handle("напомни через 10 минут проверить почту");
  assert.equal(j.memory.reminders()[0].text, "проверить почту");
  assert.match((await j.handle("расскажи анекдот")).text, /ключа Claude/);
  assert.match(j.vault.read("Jarvis/Conversations/2026-11-09.md"), /минус 28000 продукты/);
  r = await j.handle("доброе утро");
  assert.equal(r.source, "protocol");
  assert.match(r.text, /Доброе утро, сэр\. Сейчас 09:15, понедельник, 9 ноября/);
  r = await j.handle("протокол Старт работы");
  assert.match(r.text, /Старт работы/);
  r = await j.handle("поручи IPAStore: экспорт в CSV");
  assert.equal(r.kind, "error"); // без токена GitHub — объясняет
  r = await j.handle("забудь главный проект");
  assert.equal(r.confirm.kind, "forget");
  r = await j.handle("подтверждаю");
  assert.match(r.text, /удалено фактов — 1/);
});

test("маршруты /api как у сервера", async () => {
  const j = await makeJarvis();
  const st = await j.request("GET", "/api/state");
  assert.equal(st.mode, "standalone");
  assert.ok(st.protocols.length >= 8);
  const t = await j.request("POST", "/api/tasks", { text: "через API", due: "2026-11-09" });
  const done = await j.request("POST", `/api/tasks/${encodeURIComponent(t.id)}/status`, { status: "done" });
  assert.equal(done.status, "done");
  const fin = await j.request("POST", "/api/finance", { amount: "-990", category: "Подписки", note: "Claude" });
  assert.equal(fin.amount, -99000);
  assert.equal((await j.request("GET", "/api/memory?q=оферта")).hits.length > 0, true);
  assert.ok((await j.request("GET", "/api/graph")).nodes.length >= 8);
  await assert.rejects(() => j.request("GET", "/api/note?path=../x.md"));
});

test("напоминание срабатывает в приложении и исчезает из Obsidian", async () => {
  let now = new Date(2026, 10, 9, 9, 15);
  const j = await new Jarvis(settings(), { store: new LocalStore("t", template()), clock: () => now, fetchImpl: offline }).init();
  const alerts = [];
  j.on((e) => { if (e.type === "alert") alerts.push(e.data.text); });
  await j.memory.addReminder("позвонить маме", new Date(Date.now() - 1000));
  await j.tick({ pollEvery: 1e9 });
  assert.deepEqual(alerts, ["Напоминание: позвонить маме"]);
  assert.equal(j.memory.reminders().length, 0);
});

// ---------- Claude ----------
const text = (t) => ({ type: "text", text: t });
const tool = (name, input, id) => ({ type: "tool_use", name, input, id });
const resp = (content, stop = "end_turn") => ({ content, stop_reason: stop });
function fakeClaude(script) {
  const calls = [];
  const client = { beta: { messages: { create: async (req) => { calls.push({ ...req, messages: [...req.messages] }); return script.shift(); } } } };
  const factory = async () => client;
  factory.fake = true;
  return { calls, factory };
}

test("мозг: инструменты, append-only история, фолбэк, отказ", async () => {
  const { calls, factory } = fakeClaude([
    resp([text("Сейчас."), tool("task_add", { text: "позвонить в банк", due: "2026-11-10" }, "t1"),
      tool("money_add", { amount_rub: -350.5, category: "Кафе", note: "латте" }, "t2")], "tool_use"),
    resp([text("Записал, сэр.")]),
    resp([], "refusal"),
    resp([text("Конечно.")]),
  ]);
  const j = await makeJarvis({ anthropicKey: "sk-test" }, { clientFactory: factory });
  let r = await j.handle("запиши звонок в банк на завтра и латте за 350,50");
  assert.equal(r.text, "Записал, сэр.");
  assert.match(j.vault.read("Tasks/Inbox.md"), /позвонить в банк/);
  assert.match(j.vault.read("Finance/2026-11.md"), /\| -350\.50 \| Кафе \| латте \|/);
  const [first, second] = calls;
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.betas, [FALLBACK_BETA]);
  assert.deepEqual(first.output_config, { effort: "low" });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.at(-1).content.map((x) => x.tool_use_id), ["t1", "t2"]);
  r = await j.handle("что-то недопустимое");
  assert.match(r.text, /не могу/);
  const before = j.brain.messages.length;
  await j.handle("обычный вопрос");
  assert.deepEqual(calls[3].messages.slice(0, before), j.brain.messages.slice(0, before));
  assert.equal(calls[3].system, first.system);
});

// ---------- GitHub как хранилище ----------
function fakeGitHub(files) {
  // минимальная модель репозитория: путь → текст; sha = номер версии
  let n = 0, head = "c0";
  const blobs = new Map(), tree = new Map();
  const put = (p, t) => { const sha = `b${++n}`; blobs.set(sha, t); tree.set(p, sha); head = `c${n}`; return sha; };
  for (const [p, t] of Object.entries(files)) put(p, t);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = init.method || "GET", path = decodeURIComponent(u.pathname);
    calls.push(`${method} ${path}`);
    const json = (status, data, headers = {}) => new Response(data === null ? null : JSON.stringify(data),
      { status, headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000", ...headers } });
    let m;
    if ((m = /^\/repos\/me\/vault\/commits\/main$/.exec(path))) {
      if (init.headers["If-None-Match"] === `"${head}"`) return json(304, null);
      return json(200, { sha: head, commit: { tree: { sha: `t-${head}` } } }, { etag: `"${head}"` });
    }
    if (/^\/repos\/me\/vault\/git\/trees\//.test(path)) {
      return json(200, { tree: [...tree].map(([p, sha]) => ({ path: p, sha, type: "blob", size: blobs.get(sha).length })) });
    }
    if ((m = /^\/repos\/me\/vault\/git\/blobs\/(.+)$/.exec(path))) return json(200, { content: encodeBase64(blobs.get(m[1])) });
    if ((m = /^\/repos\/me\/vault\/contents\/(.+)$/.exec(path))) {
      if (method === "GET") return tree.has(m[1]) ? json(200, { sha: tree.get(m[1]) }) : json(404, { message: "Not Found" });
      const body = JSON.parse(init.body);
      if ((body.sha || null) !== (tree.get(m[1]) || null)) return json(409, { message: "sha mismatch" });
      const sha = put(m[1], decodeBase64(body.content));
      return json(200, { content: { sha } });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetchImpl, calls, edit: (p, t) => put(p, t), read: (p) => blobs.get(tree.get(p)) };
}

test("GitHub-хранилище: загрузка, запись, правки с телефона, конфликт", async () => {
  const repo = fakeGitHub(template());
  const gh = new GitHub("ghp_test", { fetchImpl: repo.fetchImpl });
  const j = await new Jarvis(settings({ githubToken: "ghp_test", vaultRepo: "me/vault" }),
    { store: new GitHubStore(gh, "me/vault", "main"), github: gh, clock: CLOCK, fetchImpl: offline }).init();
  assert.ok(j.vault.exists("Tasks/Inbox.md"));
  await j.handle("добавь задачу из Jarvis завтра");
  assert.match(repo.read("Tasks/Inbox.md"), /из Jarvis/);

  // в Obsidian на iPhone дописали задачу → Jarvis видит её после опроса
  repo.edit("Tasks/Inbox.md", repo.read("Tasks/Inbox.md") + "- [ ] с телефона 📅 2026-11-09\n");
  const seen = [];
  j.on((e) => { if (e.type === "vault") seen.push(...e.data.paths); });
  await j.vault.poll();
  assert.deepEqual(seen, ["Tasks/Inbox.md"]);
  assert.ok(j.tasks.view("2026-11-09", "today").some((t) => t.text === "с телефона"));
  // без изменений — запрос с ETag, ответ 304, дерево не качается
  const before = repo.calls.length;
  await j.vault.poll();
  assert.deepEqual(repo.calls.slice(before), ["GET /repos/me/vault/commits/main"]);

  // конфликт: телефон изменил файл, а Jarvis ещё не опрашивал — правка применяется к свежей версии
  repo.edit("Tasks/Inbox.md", repo.read("Tasks/Inbox.md") + "- [ ] ещё одна с телефона\n");
  await j.handle("добавь задачу после конфликта");
  const final = repo.read("Tasks/Inbox.md");
  assert.match(final, /ещё одна с телефона/);
  assert.match(final, /после конфликта/);
});
