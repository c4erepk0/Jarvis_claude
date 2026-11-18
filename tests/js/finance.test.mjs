// Финансы в ядре для iPhone — те же сценарии, что tests/test_assets.py.
// fixtures/finance.json — вход и ответ Python (jarvis/finance.py, jarvis/assets.py): JS должен ответить так же.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Portfolio, Quotes, moexPrice, parseDebtAmount, propertyValue, rubCell } from "../../jarvis/webapp/static/core/assets.js";
import { Ledger, analytics, opKey, pct } from "../../jarvis/webapp/static/core/finance.js";
import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { parse } from "../../jarvis/webapp/static/core/intents.js";
import { Projects } from "../../jarvis/webapp/static/core/projects.js";
import { LocalStore, Vault } from "../../jarvis/webapp/static/core/vault.js";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/finance.json", import.meta.url), "utf8"));
const plain = (x) => JSON.parse(JSON.stringify(x));

async function build() {
  const vault = new Vault(new LocalStore("fin", FIX.files));
  await vault.load();
  return [new Ledger(vault), new Portfolio(vault, "Finance", "RUB", new Projects(vault, "Projects", null))];
}

test("аналитика финансов: тот же ответ, что у Python", async () => {
  const [ledger] = await build();
  assert.deepEqual(plain(analytics(ledger, FIX.today, 6)), FIX.expected.analytics);
});

test("активы и долги: та же оценка, что у Python", async () => {
  const [, port] = await build();
  const [assets, debts] = port.read();
  assert.deepEqual(plain(port.valuate(assets, debts, FIX.quotes, FIX.today)), FIX.expected.assets);
});

test("мелочи: ключ операции, проценты, суммы долгов, имущество", () => {
  assert.equal(opKey("Spotify 11/2026"), "spotify");
  assert.equal(opKey("Ёлка №2"), "елка");
  assert.equal(pct(1, 8), 13);           // 12,5% → 13, как в Python
  assert.equal(pct(-1, 8), -12);
  assert.equal(parseDebtAmount("Отдать 165 000₽"), 16500000);
  assert.equal(parseDebtAmount("Вернуть 2 тыс до 4 декабря"), 200000);
  assert.equal(parseDebtAmount("Договориться"), null);
  assert.equal(propertyValue("tech", 100000, "2010-01-01", "2026-11-18"), 10000);
  assert.equal(rubCell(125000), "1250");
  assert.equal(rubCell(125050), "1250.5");
  assert.equal(rubCell(0), "0");
});

test("Мосбиржа: акции и облигации", () => {
  const d = { marketdata: { columns: ["SECID", "BOARDID", "LAST", "MARKETPRICE", "LASTTOPREVPRICE"],
    data: [["SBER", "SMAL", null, null, null], ["SBER", "TQBR", 310.5, 310.1, 1.25]] } };
  assert.deepEqual(moexPrice(d, "stock"), [31050, 1.25]);
  const bond = { marketdata: { columns: ["BOARDID", "LAST"], data: [["TQOB", 60.25]] },
    securities: { columns: ["BOARDID", "FACEVALUE"], data: [["TQOB", 1000]] } };
  assert.deepEqual(moexPrice(bond, "bond"), [60250, null]);
});

test("котировки: кэш и работа без сети", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("coingecko")) return { ok: true, json: async () => ({ bitcoin: { rub: 8500000, rub_24h_change: -2.1 } }) };
    if (url.includes("cbr")) return { ok: true, json: async () => ({ Valute: { USD: { Nominal: 1, Value: 81.5, Previous: 81 } } }) };
    throw new TypeError("offline");
  };
  const q = new Quotes(fetchImpl);
  const assets = [{ kind: "crypto", ticker: "BTC" }, { kind: "fx", ticker: "USD" }, { kind: "stock", ticker: "SBER" }];
  const got = await q.get(assets);
  assert.deepEqual(got["crypto:BTC"], [850000000, -2.1]);
  assert.equal(got["fx:USD"][0], 8150);
  assert.ok(!("stock:SBER" in got));
  const n = calls.length;
  await q.get(assets.slice(0, 2));
  assert.equal(calls.length, n);
});

test("история капитала и запись строк", async () => {
  const [, port] = await build();
  const rep = port.valuate(...port.read(), {}, FIX.today);
  let hist = await port.record(FIX.today, rep);
  assert.equal(hist.at(-1).net_worth, rep.net_worth);
  await port.addDebt("Данилу", 5000000, "2026-12-04");
  hist = await port.record(FIX.today, port.valuate(...port.read(), {}, FIX.today));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].debt, rep.debt + 5000000);
  assert.equal(port.vault.read("Finance/Capital.md").split("| 2026-11-18 |").length, 2);
  await port.addAsset("Яндекс", "акция", 2.5, 400000, "ydex", "2026-11-18");
  assert.match(port.vault.read(port.path), /\| Яндекс \| акция \| 2,5 \| 4000 \| YDEX \| 2026-11-18 \|  \|/);
  assert.ok(port.read()[0].some((a) => a.name === "Яндекс" && a.qty === 2.5));
});

test("ядро: маршруты /api/finance/… и команды", async () => {
  const j = await new Jarvis({ title: "сэр", currency: "RUB" },
    { store: new LocalStore("fin2", FIX.files), clock: () => new Date(2026, 10, 18, 12), fetchImpl: async () => { throw new TypeError("offline"); } }).init();
  const a = await j.request("GET", "/api/finance/analytics?months=4", {});
  assert.equal(a.trend.length, 4);
  const r = await j.request("GET", "/api/finance/assets", {});
  assert.equal(r.debt, 17500000);
  assert.equal(r.history.at(-1).date, "2026-11-18");
  const d = await j.request("POST", "/api/finance/assets", { action: "debt", name: "Данилу", amount: "50 000" });
  assert.equal(d.amount, 5000000);
  await assert.rejects(j.request("POST", "/api/finance/assets", { action: "asset", name: "x", buy: "abc" }));
  assert.equal(parse("какой у меня капитал", "2026-11-18").name, "assets_report");
  assert.equal(parse("проанализируй мои расходы", "2026-11-18").name, "finance_analytics");
  let reply = await j.handle("какой у меня капитал");
  assert.match(reply.text, /чистый капитал/);
  reply = await j.handle("проанализируй мои расходы");
  assert.match(reply.text, /регулярн|Сбережения/);
});

test("каталог приложений", async () => {
  const { catalog, setInCatalog } = await import("../../jarvis/webapp/static/core/apps.js");
  const [, port] = await build();
  const { vault, projects } = port;
  await vault.write("Apps/Таймер.md", "---\ntype: app\nurl: https://timer.example\nicon: ⏱\n---\n# Таймер\n\nПомидорный таймер.\n");
  let c = catalog(vault, projects);
  assert.deepEqual(c.apps.map((a) => a.name), ["Таймер"]);
  assert.equal(c.apps[0].description, "Помидорный таймер.");
  c = await setInCatalog(vault, projects, "Военный билет", true);
  assert.deepEqual(new Set(c.apps.map((a) => a.name)), new Set(["Таймер", "Военный билет"]));
  assert.match(vault.read("Projects/Военный билет.md"), /catalog: true/);
  c = await setInCatalog(vault, projects, "Военный билет", false);
  assert.deepEqual(c.apps.map((a) => a.name), ["Таймер"]);
  await assert.rejects(setInCatalog(vault, projects, "нет такого", true));
});
