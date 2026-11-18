// Активы и долги: «Finance/Assets.md» (таблицы «Активы» и «Долги»), история капитала — «Finance/Capital.md».
// Порт jarvis/assets.py — расчёт совпадает (общий тест — tests/js/fixtures/assets.json).
// Котировки без ключей прямо из браузера: Мосбиржа ISS, CoinGecko, ЦБ РФ (cbr-xml-daily).
import { money, parseMoneyCell } from "./ru.js";
import { pct } from "./finance.js";

export const KINDS = {
  stock: ["Акции", ["акци", "stock", "share"]],
  fund: ["Фонды", ["фонд", "etf", "бпиф", "пиф"]],
  bond: ["Облигации", ["облиг", "bond", "офз"]],
  crypto: ["Крипта", ["крипт", "crypto", "coin", "токен"]],
  fx: ["Валюта", ["валют", "fx", "currency"]],
  cash: ["Деньги", ["деньг", "налич", "вклад", "депозит", "счёт", "счет", "cash", "накоплен"]],
  realty: ["Недвижимость", ["недвиж", "квартир", "дом", "земл", "дач", "гараж"]],
  car: ["Транспорт", ["авто", "машин", "мото", "транспорт"]],
  tech: ["Техника", ["техник", "электрон", "телефон", "ноутбук", "компьютер", "гаджет"]],
  other: ["Имущество", []],
};
export const MARKET = ["stock", "fund", "bond", "crypto", "fx"];
export const PROPERTY = { realty: [5, 100], car: [-12, 25], tech: [-25, 10], other: [-10, 20] };
export const CRYPTO_IDS = { BTC: "bitcoin", ETH: "ethereum", USDT: "tether", USDC: "usd-coin", TON: "the-open-network",
  SOL: "solana", BNB: "binancecoin", XRP: "ripple", DOGE: "dogecoin", TRX: "tron", ADA: "cardano", LTC: "litecoin",
  DOT: "polkadot", NOT: "notcoin", AVAX: "avalanche-2" };
const ASSET_COLS = { name: ["актив", "название", "имущество"], kind: ["вид", "тип"], qty: ["количество", "кол-во", "штук"],
  buy: ["цена покупки", "куплено", "цена", "стоимость покупки"], ticker: ["тикер", "код"], date: ["дата"],
  price: ["оценка", "цена сейчас"] };
const DEBT_COLS = { name: ["кому", "долг", "кредитор"], amount: ["сумма", "остаток"], due: ["срок"],
  note: ["заметка", "описание", "комментарий"] };
export const TEMPLATE = `---
type: finance-assets
---
# Активы и долги

Цены — за единицу. Оценка обновляется сама: акции, фонды и облигации — Мосбиржа (тикер: SBER, TMOS, SU26238RMFS4),
крипта — CoinGecko (BTC, ETH, TON), валюта — ЦБ (USD, EUR, CNY). Имущество оценивается по виду: техника дешевеет
~25% в год, авто ~12%, недвижимость дорожает ~5%. Своя цена — в колонке «Оценка».
Виды: акция, фонд, облигация, крипто, валюта, деньги, недвижимость, авто, техника, имущество.

## Активы
| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |
|-------|-----|-----------:|-------------:|-------|--------------|-------:|

## Долги
| Кому | Сумма | Срок | Заметка |
|------|------:|------|---------|
`;
const CAPITAL_HEAD = "---\ntype: finance-capital\n---\n# Капитал — история\n\nСтрока в день: активы, долги и чистый капитал. "
  + "Пишет Atom, когда открывают «Активы».\n\n| Дата | Активы | Долги | Капитал |\n|------|-------:|------:|--------:|\n";

export function kindOf(text) {
  const low = String(text || "").toLowerCase().trim();
  if (KINDS[low]) return low;
  for (const [k, [, words]] of Object.entries(KINDS)) if (words.some((w) => low.includes(w))) return k;
  return "other";
}
export function parseQty(cell) {
  const s = String(cell || "").replace(/[\s ]/g, "").replace(",", ".");
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? v : null;
}
export function rubCell(kop) {
  const v = (Math.abs(kop) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return (kop < 0 ? "-" : "") + v;
}
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
function mapCols(header, names) {
  const out = {};
  header.forEach((h, i) => {
    const low = h.toLowerCase();
    for (const [key, words] of Object.entries(names)) {
      if (!(key in out) && words.some((w) => low.startsWith(w))) { out[key] = i; break; }
    }
  });
  return out;
}
export function tables(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length;) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const head = cells(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) rows.push(cells(lines[j++]));
      out.push([head, rows, j - 1]);
      i = j;
    } else i++;
  }
  return out;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export function propertyValue(kind, buy, since, today) {
  const [rate, floor] = PROPERTY[kind] || PROPERTY.other;
  const years = /^\d{4}-\d{2}-\d{2}$/.test(since || "") && !Number.isNaN(Date.parse(since))
    ? Math.max(0, daysBetween(since, today) / 365.25) : 0;
  const value = Math.floor(buy * (1 + rate / 100) ** years / 100 + 0.5) * 100;      // до рубля
  return rate < 0 ? Math.max(value, Math.floor(Math.floor(buy * floor / 100) / 100) * 100) : value;
}
const DEBT_AMOUNT = /(\d[\d\s ]*(?:[.,]\d{1,2})?)\s*(тыс(?![а-яё])\.?|к(?![а-яё\w]))?/giu;
/** «Отдать 165 000₽», «Отдать 50 000 в декабре» → копейки; без суммы — null. */
export function parseDebtAmount(text) {
  for (const m of String(text || "").matchAll(DEBT_AMOUNT)) {
    let v = Number(m[1].replace(/[\s ]/g, "").replace(",", "."));
    if (!Number.isFinite(v)) continue;
    if (m[2]) v *= 1000;
    if (v >= 100) return Math.round(v * 100);
  }
  return null;
}
const clean = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ").trim();
const fmtQty = (q) => (q ? q.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "1").replace(".", ",");

export class Portfolio {
  constructor(vault, folder = "Finance", currency = "RUB", projects = null) {
    this.vault = vault;
    this.folder = folder.replace(/\/+$/, "");
    this.currency = currency;
    this.projects = projects;
  }
  get path() { return `${this.folder}/Assets.md`; }
  get capitalPath() { return `${this.folder}/Capital.md`; }
  exists() { return this.vault.exists(this.path); }
  async init() {
    if (!this.exists()) await this.vault.write(this.path, TEMPLATE, "Atom: таблица активов");
    return this.path;
  }

  read() {
    const assets = [], debts = [];
    if (this.exists()) {
      for (const [head, rows] of tables(this.vault.read(this.path))) {
        const a = mapCols(head, ASSET_COLS), d = mapCols(head, DEBT_COLS);
        if ("name" in a && ("buy" in a || "qty" in a) && !("amount" in d)) {
          for (const r of rows) {
            const get = (k) => (k in a ? (r[a[k]] || "").trim() : "");
            const name = get("name");
            if (!name || /^[-:]+$/.test(name)) continue;
            const qty = parseQty(get("qty"));
            assets.push({ name, kind: kindOf(get("kind")), qty: qty === null ? 1 : qty,
              buy: Math.abs(parseMoneyCell(get("buy")) || 0), ticker: get("ticker").toUpperCase(), date: get("date"),
              price: get("price") ? parseMoneyCell(get("price")) : null });
          }
        } else if ("name" in d && "amount" in d) {
          for (const r of rows) {
            const amount = parseMoneyCell(r[d.amount] || "");
            if (!r[d.name] || amount === null) continue;
            debts.push({ name: r[d.name], amount: Math.abs(amount), due: "due" in d ? r[d.due] || "" : "",
              note: "note" in d ? r[d.note] || "" : "", source: this.path });
          }
        }
      }
    }
    debts.push(...this.projectDebts(new Set(debts.map((x) => x.name.toLowerCase()))));
    return [assets, debts];
  }

  projectDebts(known) {
    if (!this.projects) return [];
    const out = [];
    for (const p of this.projects.list()) {
      const tags = new Set(p.tag.split(/[,\s]+/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean));
      if (!tags.has("долг") || p.status === "done" || known.has(p.name.toLowerCase())) continue;
      const amount = parseDebtAmount(p.description);
      if (amount) out.push({ name: p.name, amount, due: "", note: p.description, source: p.note });
    }
    return out;
  }

  valuate(assets, debts, quotes, today) {
    const items = assets.map((a) => {
      const cost = Math.round(a.buy * a.qty);
      let price, source, change = null;
      if (a.price !== null && a.price !== undefined) { price = Math.abs(a.price); source = "вручную"; }
      else if (a.kind === "cash") { price = a.buy; source = "по сумме"; }
      else if (MARKET.includes(a.kind) && a.ticker) {
        [price, change] = quotes[`${a.kind}:${a.ticker}`] || [null, null];
        source = price !== null && price !== undefined ? "рынок" : "нет котировки";
        if (price === null || price === undefined) price = a.buy;
      } else if (MARKET.includes(a.kind)) { price = a.buy; source = "без тикера"; }
      else { price = propertyValue(a.kind, a.buy, a.date, today); source = "по виду актива"; }
      const value = Math.round(price * a.qty);
      return { ...a, kind_label: KINDS[a.kind][0], cost, unit: price, value, pnl: value - cost,
        pnl_pct: cost ? pct(value - cost, cost) : null, change: change ?? null, source };
    });
    const total = items.reduce((s, i) => s + i.value, 0);
    const cost = items.reduce((s, i) => s + i.cost, 0);
    const debt = debts.reduce((s, d) => s + d.amount, 0);
    const kinds = {};
    for (const i of items) kinds[i.kind] = (kinds[i.kind] || 0) + i.value;
    const byKind = Object.entries(kinds).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => ({ kind: k, label: KINDS[k][0], value: v, share: total ? pct(v, total) : 0 }));
    return { currency: this.currency, exists: this.exists(), path: this.path,
      items: items.sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), debts,
      total, cost, pnl: total - cost, pnl_pct: cost ? pct(total - cost, cost) : null, debt, net_worth: total - debt,
      by_kind: byKind };
  }

  history() {
    if (!this.vault.exists(this.capitalPath)) return [];
    const out = [];
    for (const [, rows] of tables(this.vault.read(this.capitalPath))) {
      for (const r of rows) {
        if (r.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(r[0])) continue;
        const v = r.slice(1, 4).map(parseMoneyCell);
        if (!v.includes(null)) out.push({ date: r[0], total: v[0], debt: v[1], net_worth: v[2] });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async record(today, report) {
    const hist = this.history();
    if (!report.items.length && !report.debts.length) return hist;
    const row = { date: today, total: report.total, debt: report.debt, net_worth: report.net_worth };
    const last = hist[hist.length - 1];
    if (last && last.date === row.date && last.total === row.total && last.debt === row.debt && last.net_worth === row.net_worth) return hist;
    const line = `| ${row.date} | ${rubCell(row.total)} | ${rubCell(row.debt)} | ${rubCell(row.net_worth)} |`;
    await this.vault.update(this.capitalPath, (cur) => {
      const lines = (cur === undefined ? CAPITAL_HEAD : cur).replace(/\n+$/, "").split("\n");
      const rows = lines.map((l, i) => (l.trim().startsWith("|") ? i : -1)).filter((i) => i >= 0);
      const same = rows.find((i) => cells(lines[i])[0] === row.date);
      if (same !== undefined) lines[same] = line;
      else if (rows.length) lines.splice(rows[rows.length - 1] + 1, 0, line);
      else lines.push("", "| Дата | Активы | Долги | Капитал |", "|------|-------:|------:|--------:|", line);
      return lines.join("\n") + "\n";
    }, "Atom: капитал за день");
    return [...hist.filter((h) => h.date !== row.date), row];
  }

  async addAsset(name, kind, qty, buy, ticker = "", day = "", price = null) {
    if (!String(name || "").trim()) throw new Error("не указано название актива");
    const c = [name, kind || "имущество", fmtQty(qty), rubCell(buy), String(ticker || "").toUpperCase(), day,
      price !== null && price !== undefined ? rubCell(price) : ""];
    await this.insert("asset", `| ${c.map(clean).join(" | ")} |`, `Atom: актив ${name}`);
    return { name, kind: kindOf(kind), qty: qty || 1, buy, ticker: String(ticker || "").toUpperCase() };
  }

  async addDebt(name, amount, due = "", note = "") {
    if (!String(name || "").trim() || !amount) throw new Error("нужны «кому» и сумма");
    await this.insert("debt", `| ${[name, rubCell(Math.abs(amount)), due, note].map(clean).join(" | ")} |`, `Atom: долг ${name}`);
    return { name, amount: Math.abs(amount), due, note };
  }

  async insert(which, row, message) {
    await this.vault.update(this.path, (cur) => {
      const text = cur === undefined ? TEMPLATE : cur;
      for (const [head, , last] of tables(text)) {
        const a = mapCols(head, ASSET_COLS), d = mapCols(head, DEBT_COLS);
        const isDebt = "name" in d && "amount" in d;
        if ((which === "debt") === isDebt && (isDebt || "name" in a)) {
          const lines = text.split("\n");
          lines.splice(last + 1, 0, row);
          return lines.join("\n").replace(/\n*$/, "\n");
        }
      }
      const head = which === "debt"
        ? ["## Долги", "| Кому | Сумма | Срок | Заметка |", "|------|------:|------|---------|"]
        : ["## Активы", "| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |",
          "|-------|-----|-----------:|-------------:|-------|--------------|-------:|"];
      return `${text.replace(/\n+$/, "")}\n\n${[...head, row].join("\n")}\n`;
    }, message);
  }
}

/** Ответ ISS → [цена за бумагу в копейках, изменение за день в %]. Облигации — % от номинала. */
export function moexPrice(d, kind) {
  const rows = (block) => { const b = d[block] || {}; return (b.data || []).map((r) => Object.fromEntries((b.columns || []).map((c, i) => [c, r[i]]))); };
  const md = rows("marketdata"), sec = rows("securities");
  const pick = md.find((r) => r.LAST) || md.find((r) => r.MARKETPRICE) || null;
  let price = pick ? pick.LAST || pick.MARKETPRICE : null;
  let board = pick ? pick.BOARDID : null;
  if (price === null || price === undefined) {
    const s = sec.find((r) => r.PREVPRICE);
    price = s ? s.PREVPRICE : null; board = s ? s.BOARDID : null;
  }
  if (price === null || price === undefined) return [null, null];
  const change = pick && pick.LASTTOPREVPRICE !== null && pick.LASTTOPREVPRICE !== undefined
    ? Math.round(pick.LASTTOPREVPRICE * 100) / 100 : null;
  if (kind === "bond") {
    const s = sec.find((r) => r.BOARDID === board && r.FACEVALUE) || sec.find((r) => r.FACEVALUE);
    if (!s) return [null, null];
    price = price * s.FACEVALUE / 100;
  }
  return [Math.round(price * 100), change];
}

export class Quotes {
  constructor(fetchImpl = (...a) => fetch(...a), ttl = 600) {
    this.fetch = fetchImpl;
    this.ttl = ttl * 1000;
    this.cache = new Map();
  }
  async json(url, params = {}) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await this.fetch(u.toString());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async get(assets) {
    const want = [...new Set(assets.filter((a) => MARKET.includes(a.kind) && a.ticker).map((a) => `${a.kind}:${a.ticker}`))].sort();
    const now = Date.now(), out = {};
    for (const k of want) { const hit = this.cache.get(k); if (hit && now - hit.t < this.ttl) out[k] = hit.v; }
    const todo = want.filter((k) => !(k in out));
    if (!todo.length) return out;
    const jobs = todo.filter((k) => /^(stock|fund|bond):/.test(k)).map((k) => this.moex(k));
    const crypto = todo.filter((k) => k.startsWith("crypto:"));
    if (crypto.length) jobs.push(this.crypto(crypto));
    const fx = todo.filter((k) => k.startsWith("fx:"));
    if (fx.length) jobs.push(this.fx(fx));
    for (const res of await Promise.allSettled(jobs)) {
      if (res.status !== "fulfilled") continue;
      for (const [k, v] of Object.entries(res.value)) { this.cache.set(k, { t: now, v }); out[k] = v; }
    }
    return out;
  }
  async moex(key) {
    const [kind, ticker] = key.split(":");
    const market = kind === "bond" ? "bonds" : "shares";
    const d = await this.json(`https://iss.moex.com/iss/engines/stock/markets/${market}/securities/${encodeURIComponent(ticker)}.json`,
      { "iss.meta": "off", "iss.only": "securities,marketdata", "securities.columns": "SECID,BOARDID,FACEVALUE,PREVPRICE",
        "marketdata.columns": "SECID,BOARDID,LAST,MARKETPRICE,LASTTOPREVPRICE" });
    return { [key]: moexPrice(d, kind) };
  }
  async crypto(keys) {
    const ids = Object.fromEntries(keys.map((k) => { const t = k.split(":")[1]; return [k, CRYPTO_IDS[t] || t.toLowerCase()]; }));
    const d = await this.json("https://api.coingecko.com/api/v3/simple/price",
      { ids: [...new Set(Object.values(ids))].sort().join(","), vs_currencies: "rub", include_24hr_change: "true" });
    const out = {};
    for (const [k, id] of Object.entries(ids)) {
      const row = d[id] || {};
      out[k] = [row.rub !== undefined && row.rub !== null ? Math.round(row.rub * 100) : null,
        row.rub_24h_change !== undefined && row.rub_24h_change !== null ? Math.round(row.rub_24h_change * 100) / 100 : null];
    }
    return out;
  }
  async fx(keys) {
    const d = await this.json("https://www.cbr-xml-daily.ru/daily_json.js");
    const out = {};
    for (const k of keys) {
      const v = (d.Valute || {})[k.split(":")[1]];
      if (!v) { out[k] = [null, null]; continue; }
      const nominal = v.Nominal || 1;
      out[k] = [Math.round(v.Value / nominal * 100), v.Previous ? Math.round((v.Value - v.Previous) * 10000 / v.Previous) / 100 : null];
    }
    return out;
  }
}

export const assetsPhrase = (r, title, currency) => {
  if (!r.items.length && !r.debts.length) {
    return `Активы пока не заведены, ${title}. Откройте «Финансы → Активы» — я создам таблицу в ${r.path}.`;
  }
  let text = `Активы — ${money(r.total, currency)}, долги — ${money(r.debt, currency)}, чистый капитал — ${money(r.net_worth, currency)}.`;
  if (r.pnl_pct !== null && r.cost) text += ` К цене покупки: ${r.pnl >= 0 ? "+" : "−"}${money(Math.abs(r.pnl), currency)} (${r.pnl_pct}%).`;
  return text;
};
