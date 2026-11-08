// Тесты ядра, которое работает прямо в Safari на iPhone: node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import * as ru from "../../jarvis/webapp/static/core/ru.js";
import { parse } from "../../jarvis/webapp/static/core/intents.js";
import { TaskBook, parseLine } from "../../jarvis/webapp/static/core/tasks.js";
import { Ledger, guessCategory } from "../../jarvis/webapp/static/core/finance.js";
import { Memory } from "../../jarvis/webapp/static/core/memory.js";
import { LocalStore, Vault, VaultError, checkPath, decodeBase64, encodeBase64, parseFrontmatter }
  from "../../jarvis/webapp/static/core/vault.js";

const REF = "2026-11-09"; // понедельник
const P = ["IPAStore", "Jarvis"];

async function memVault(seed = {}) {
  const v = new Vault(new LocalStore("t", seed));
  await v.load();
  return v;
}

test("русские даты, суммы, деньги", () => {
  assert.deepEqual(ru.parseDate("купить молоко завтра", REF), ["2026-11-10", "купить молоко"]);
  assert.equal(ru.parseDate("отчёт в пятницу", REF)[0], "2026-11-13");
  assert.equal(ru.parseDate("через неделю созвон", REF)[0], "2026-11-16");
  assert.equal(ru.parseDate("оплатить 5 января", REF)[0], "2027-01-05");
  assert.equal(ru.parseDate("до 12.11 сдать", REF)[0], "2026-11-12");
  assert.deepEqual(ru.parseDate("просто текст", REF), [null, "просто текст"]);
  assert.equal(ru.parseAmount("1 200,50 на кофе")[0], 120050);
  assert.equal(ru.parseAmount("1,5к такси")[0], 150000);
  assert.equal(ru.parseAmount("2 тыс за обед")[0], 200000);
  assert.equal(ru.parseMoneyCell("−1 200,5"), -120050);
  assert.equal(ru.money(-123456), "−1 234,56 ₽");
  assert.equal(ru.plural(21, "задача", "задачи", "задач"), "задача");
  assert.equal(ru.parseDuration("через 20 минут позвонить")[0], 1200);
  assert.equal(ru.humanDate("2026-11-10", REF), "завтра");
});

test("команды на русском", () => {
  const cases = {
    "Джарвис, добавь задачу купить молоко завтра": ["task_add", { text: "купить молоко", due: "2026-11-10" }],
    "добавь задачу срочно написать оферту для IPAStore в пятницу":
      ["task_add", { text: "написать оферту", priority: "high", project: "IPAStore", due: "2026-11-13" }],
    "потратил 450 на кофе": ["expense", { amount: -45000, category: "Кафе", note: "кофе" }],
    "купил кроссовки за 7990р": ["expense", { amount: -799000, note: "кроссовки" }],
    "получил 50 000 зарплата": ["income", { amount: 5000000, category: "Доход" }],
    "напомни через 20 минут позвонить маме": ["reminder", { text: "позвонить маме", seconds: 1200 }],
    "доброе утро": ["protocol", { name: "утро" }],
    "протокол «Старт работы»": ["protocol", { name: "старт работы" }],
    "поручи IPAStore: экспорт статистики в CSV": ["delegate", { project: "IPAStore", task: "экспорт статистики в CSV", mode: "github" }],
    "задеплой ipastore": ["deploy", { project: "IPAStore" }],
    "статус ipastore": ["project_status", { project: "IPAStore" }],
    "как дела у сервера? диагностика": ["protocol", { name: "диагностика" }],
    "задачи на завтра": ["tasks_list", { view: "tomorrow" }],
    "запомни что я пью эспрессо": ["remember", { fact: "я пью эспрессо" }],
    "подтверждаю": ["confirm", {}],
    "который час": ["time", {}],
  };
  for (const [text, [name, args]] of Object.entries(cases)) {
    const it = parse(text, REF, P);
    assert.ok(it && it.name === name, `${text} → ${JSON.stringify(it)}`);
    for (const [k, v] of Object.entries(args)) assert.equal(it.args[k], v, `${text}: ${k}`);
  }
  assert.equal(parse("расскажи анекдот", REF, P), null);
  assert.equal(parse("как дела", REF, P), null);
});

test("хранилище: пути и frontmatter", async () => {
  for (const bad of ["../x.md", "a/../../x.md", ".obsidian/app.json", "", ".git/config"]) {
    assert.throws(() => checkPath(bad, { write: true }), VaultError);
  }
  assert.throws(() => checkPath("script.sh", { write: true }), VaultError);
  const [meta, body] = parseFrontmatter("---\ntype: project\nrepo: c4erepk0/IPAStore\ntags: [a, b]\nhealth:\n---\nТекст");
  assert.deepEqual(meta, { type: "project", repo: "c4erepk0/IPAStore", tags: ["a", "b"], health: [] });
  assert.equal(body, "Текст");
  assert.equal(decodeBase64(encodeBase64("Привет, сэр ✅")), "Привет, сэр ✅");

  const v = await memVault({ "n.md": "# Заголовок\n\n## Задачи\n- a\n\n## Журнал\n- старое\n" });
  await v.appendToSection("n.md", "Задачи", "- b");
  await v.appendToSection("n.md", "Новый", "- c");
  const text = v.read("n.md");
  assert.ok(text.indexOf("- a") < text.indexOf("- b") && text.indexOf("- b") < text.indexOf("## Журнал"));
  assert.ok(text.trimEnd().endsWith("## Новый\n- c"));
  await v.write("Projects/IPAStore.md", "Сертификаты Apple. [[n]]");
  assert.equal(v.search("сертификат")[0].path, "Projects/IPAStore.md");
  assert.deepEqual(v.graph().links, [{ source: "Projects/IPAStore.md", target: "n.md" }]);
});

test("задачи в формате Obsidian Tasks", async () => {
  const t = parseLine("Tasks/Inbox.md", 3, "- [ ] Написать оферту #ipastore ⏫ ➕ 2026-11-01 📅 2026-11-10");
  assert.equal(t.text, "Написать оферту");
  assert.equal(t.priority, 4);
  assert.equal(t.due, "2026-11-10");
  assert.deepEqual(t.tags, ["ipastore"]);
  const v = await memVault({ "Journal/n.md": "```\n- [ ] в коде\n```\n- [ ] из дневника 📅 2026-11-01\n" });
  const book = new TaskBook(v, "Tasks/Inbox.md");
  const a = await book.add("купить молоко", REF, { due: REF });
  await book.add("бизнес-модель", REF, { tags: ["ipastore"], note: "Projects/IPAStore.md" });
  assert.deepEqual(book.view(REF, "today").map((x) => x.text), ["из дневника", "купить молоко"]);
  assert.deepEqual(book.view(REF, "all", "ipastore").map((x) => x.text), ["бизнес-модель"]);
  await v.write("Tasks/Inbox.md", "новая строка сверху\n" + v.read("Tasks/Inbox.md"));
  const done = await book.setStatus(a.id, "done", REF);
  assert.equal(done.status, "done");
  assert.ok(v.read("Tasks/Inbox.md").includes("✅ 2026-11-09"));
  assert.equal(book.summary(REF).done_today, 1);
});

test("финансы и бюджет", async () => {
  const v = await memVault({ "Finance/Budget.md": "| Категория | Лимит |\n|---|---:|\n| Еда | 10000 |\n| Кафе | 3 000 |\n" });
  const led = new Ledger(v);
  await led.add(-45000, "Кафе", "кофе | с молоком", REF);
  await led.add(-850050, "Еда", "продукты", REF);
  await led.add(12000000, "Доход", "зарплата", "2026-11-08");
  const e = led.entries("2026-11");
  assert.deepEqual(e.map((x) => x.amount), [-45000, -850050, 12000000]);
  assert.equal(e[0].note, "кофе / с молоком");
  const s = led.summary("2026-11", REF);
  assert.equal(s.expense, 895050);
  assert.equal(s.budget_total, 1300000);
  assert.equal(s.categories[0].percent, 85);
  assert.match(led.budgetAlert("Еда", "2026-11"), /85%/);
  assert.equal(guessCategory("такси до дома"), "Транспорт");
  assert.match(v.read("Finance/2026-11.md"), /# Финансы — Ноябрь 2026/);
});

test("память и напоминания", async () => {
  const v = await memVault();
  const m = new Memory(v);
  await m.remember("Пью эспрессо без сахара.", REF);
  assert.ok((await m.remember("пью эспрессо без сахара", REF)).duplicate);
  assert.deepEqual(m.facts(), [{ date: REF, text: "Пью эспрессо без сахара" }]);
  const at = new Date(2026, 10, 9, 14, 30);
  const r = await m.addReminder("позвонить маме", at);
  assert.equal(m.reminders()[0].text, "позвонить маме");
  assert.equal(m.reminders()[0].at, at.getTime() / 1000);
  await m.removeReminders([r.id]);
  assert.equal(m.reminders().length, 0);
  assert.equal(await m.forget("эспрессо"), 1);
});
