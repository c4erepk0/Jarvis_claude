// Финансы: «Finance/2026-11.md» с таблицей операций, лимиты — «Finance/Budget.md». Порт jarvis/finance.py.
import { MONTHS_NOM, money, parseMoneyCell, plural } from "./ru.js";

export const CATEGORY_HINTS = {
  "Еда": ["еда", "продукт", "магазин", "пятёрочк", "пятерочк", "перекрёст", "перекрест", "вкусвилл", "ашан", "лавк",
    "самокат", "рынок"],
  "Кафе": ["кафе", "кофе", "ресторан", "обед", "ужин", "завтрак", "бар", "пицц", "суши", "шаурм", "доставк"],
  "Транспорт": ["такси", "метро", "бензин", "заправк", "автобус", "каршеринг", "парковк", "электричк", "поезд",
    "транспорт"],
  "Подписки": ["подписк", "spotify", "netflix", "youtube", "icloud", "claude", "chatgpt", "яндекс плюс", "apple",
    "telegram premium", "github"],
  "Связь": ["связь", "телефон", "интернет", "мобильн"],
  "Дом": ["квартир", "аренд", "коммунал", "жкх", "ремонт", "дом", "мебел"],
  "Здоровье": ["аптек", "врач", "здоров", "лекарств", "стоматолог", "анализ"],
  "Спорт": ["спорт", "зал", "фитнес", "тренир"],
  "Развлечения": ["кино", "игр", "концерт", "развлеч", "steam", "театр"],
  "Одежда": ["одежд", "обув", "кроссовк", "куртк"],
  "Образование": ["курс", "книг", "обучен", "учеб"],
  "Бизнес": ["ipastore", "сервер", "хостинг", "домен", "реклам", "vps", "сертификат apple"],
  "Подарки": ["подар"],
};
const INCOME_HINTS = ["зарплат", "доход", "получил", "заработ", "перевели", "кэшбэк", "кешбэк", "продаж", "выплат",
  "аванс", "премия", "вернули", "пришло", "пришли"];
const HEADER = "| Дата | Сумма | Категория | Описание | Счёт |\n|------|------:|-----------|----------|------|";

export function guessCategory(text, income = false) {
  const low = text.toLowerCase();
  if (income) return low.includes("ipastore") ? "Бизнес" : "Доход";
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) if (hints.some((h) => low.includes(h))) return cat;
  return "Прочее";
}
export const looksLikeIncome = (t) => INCOME_HINTS.some((h) => t.toLowerCase().includes(h));
const cell = (s) => String(s || "").replace(/\|/g, "/").replace(/\n/g, " ").trim();
const rowCells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export class Ledger {
  constructor(vault, folder = "Finance", currency = "RUB") {
    this.vault = vault;
    this.folder = folder.replace(/\/+$/, "");
    this.currency = currency;
  }

  monthPath(month) { return `${this.folder}/${month}.md`; }

  entries(month) {
    const path = this.monthPath(month);
    if (!this.vault.exists(path)) return [];
    const out = [];
    for (const line of this.vault.read(path).split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const c = rowCells(line);
      if (c.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0])) continue;
      const amount = parseMoneyCell(c[1]);
      if (amount === null) continue;
      out.push({ date: c[0], amount, category: c[2] || "Прочее", note: c[3] || "", account: c[4] || "", path });
    }
    return out;
  }

  async add(amount, category, note, day, account = "") {
    if (!amount) throw new Error("сумма не может быть нулевой");
    const month = day.slice(0, 7);
    const path = this.monthPath(month);
    const rub = Math.abs(amount) / 100;
    const value = (amount < 0 ? "-" : "+") + (Number.isInteger(rub) ? String(rub) : rub.toFixed(2));
    const row = `| ${day} | ${value} | ${cell(category)} | ${cell(note)} | ${cell(account)} |`;
    await this.vault.update(path, (cur) => {
      let text = cur;
      if (text === undefined) {
        const [y, m] = month.split("-").map(Number);
        const t = MONTHS_NOM[m - 1];
        text = `---\ntype: finance-ledger\nmonth: ${month}\n---\n# Финансы — ${t[0].toUpperCase() + t.slice(1)} ${y}\n\n${HEADER}\n`;
      }
      const lines = text.replace(/\n+$/, "").split("\n");
      let last = -1;
      lines.forEach((l, i) => { if (l.trim().startsWith("|")) last = i; });
      if (last < 0) lines.push("", ...HEADER.split("\n"), row);
      else lines.splice(last + 1, 0, row);
      return lines.join("\n") + "\n";
    }, `Atom: ${amount < 0 ? "расход" : "доход"} ${note || category}`);
    return { date: day, amount, category, note, account, path };
  }

  budgets() {
    const path = `${this.folder}/Budget.md`;
    if (!this.vault.exists(path)) return {};
    const out = {};
    for (const line of this.vault.read(path).split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const c = rowCells(line);
      if (c.length >= 2 && c[0] && !c[0].startsWith("-")) {
        const v = parseMoneyCell(c[1]);
        if (v !== null) out[c[0]] = Math.abs(v);
      }
    }
    return out;
  }

  summary(month, ref) {
    const items = this.entries(month);
    const income = items.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const expense = -items.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const byCat = {};
    for (const e of items) if (e.amount < 0) byCat[e.category] = (byCat[e.category] || 0) - e.amount;
    const [y, m] = month.split("-").map(Number);
    const daysIn = new Date(y, m, 0).getDate();
    const refMonth = ref ? ref.slice(0, 7) : null;
    const dayNo = refMonth === month ? Number(ref.slice(8)) : refMonth && refMonth < month ? 0 : daysIn;
    const daily = dayNo ? Math.floor(expense / dayNo / 100) * 100 : 0;
    const forecast = dayNo ? daily * daysIn : expense;
    const budgets = this.budgets();
    const cats = [...new Set([...Object.keys(byCat), ...Object.keys(budgets)])]
      .sort((a, b) => (byCat[b] || 0) - (byCat[a] || 0))
      .map((c) => ({ category: c, spent: byCat[c] || 0, limit: budgets[c] ?? null,
        percent: budgets[c] ? Math.round((byCat[c] || 0) * 100 / budgets[c]) : null }));
    const total = Object.values(budgets).reduce((s, v) => s + v, 0);
    return { month, currency: this.currency, income, expense, net: income - expense, daily_average: daily, forecast,
      budget_total: total || null, budget_percent: total ? Math.round(expense * 100 / total) : null,
      categories: cats, recent: [...items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12),
      count: items.length };
  }

  budgetAlert(category, month) {
    const limit = this.budgets()[category];
    if (!limit) return null;
    const spent = -this.entries(month).filter((e) => e.amount < 0 && e.category === category)
      .reduce((s, e) => s + e.amount, 0);
    const pct = Math.floor(spent * 100 / limit);
    if (pct >= 100) return `Бюджет «${category}» исчерпан: ${money(spent, this.currency)} из ${money(limit, this.currency)} (${pct}%).`;
    if (pct >= 80) return `Бюджет «${category}» израсходован на ${pct}%: осталось ${money(limit - spent, this.currency)}.`;
    return null;
  }
}

// ---------- аналитика: тот же расчёт, что analytics() в jarvis/finance.py (общий тест — fixtures/finance.json) ----------
export const shiftMonth = (month, n) => {
  const [y, m] = month.split("-").map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${String(Math.floor(k / 12)).padStart(4, "0")}-${String((k % 12) + 1).padStart(2, "0")}`;
};
/** Ключ повторяющейся операции: «Spotify 11/2026» и «spotify» — одно и то же. */
export const opKey = (note) => String(note || "").toLowerCase().replace(/ё/g, "е").replace(/[\d.,:/#№-]+/g, " ")
  .replace(/\s+/g, " ").trim();
/** Процент с округлением половины вверх — как pct() в Python. */
export const pct = (part, whole) => Math.floor((part * 200 + whole) / (2 * whole));
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; };

export function analytics(ledger, ref, months = 6) {
  const cur = ref.slice(0, 7);
  months = Math.max(2, Math.min(24, months));
  const span = Array.from({ length: months }, (_, i) => shiftMonth(cur, i - months + 1));
  const byMonth = Object.fromEntries(span.map((m) => [m, ledger.entries(m)]));
  const trend = span.map((m) => {
    const items = byMonth[m];
    const inc = items.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const exp = -items.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    return { month: m, income: inc, expense: exp, net: inc - exp, count: items.length };
  });
  const now = trend[trend.length - 1];
  const prev = trend.slice(-4, -1).filter((t) => t.count);
  const avgExp = prev.length ? Math.floor(Math.floor(prev.reduce((s, t) => s + t.expense, 0) / prev.length) / 100) * 100 : 0;
  const cats = (items) => {
    const out = {};
    for (const e of items) if (e.amount < 0) out[e.category] = (out[e.category] || 0) - e.amount;
    return out;
  };
  const thisCats = cats(byMonth[cur]);
  // таблица «категория × месяц» для 3D-карты расходов: шесть самых затратных категорий за весь срок
  const per = Object.fromEntries(span.map((m) => [m, cats(byMonth[m])]));
  const totals = {};
  for (const m of span) for (const [c, v] of Object.entries(per[m])) totals[c] = (totals[c] || 0) + v;
  const topCats = Object.entries(totals).sort((a, b) => cmpTuple([-a[1], a[0]], [-b[1], b[0]])).slice(0, 6).map(([c]) => c);
  const matrix = { months: span, categories: topCats, values: topCats.map((c) => span.map((m) => per[m][c] || 0)) };
  const prevCats = prev.map((t) => cats(byMonth[t.month]));
  const names = [...new Set([...Object.keys(thisCats), ...prevCats.flatMap((pc) => Object.keys(pc))])]
    .sort((a, b) => cmpTuple([-(thisCats[a] || 0), a], [-(thisCats[b] || 0), b]));
  const categories = names.map((c) => {
    const avg = prevCats.length ? Math.floor(prevCats.reduce((s, pc) => s + (pc[c] || 0), 0) / prevCats.length) : 0;
    const spent = thisCats[c] || 0;
    return { category: c, spent, average: avg, change: avg ? pct(spent - avg, avg) : null,
      share: now.expense ? pct(spent, now.expense) : 0 };
  });

  const groups = new Map();
  for (const m of span.slice(-4)) {
    for (const e of byMonth[m]) {
      if (e.amount >= 0 || !opKey(e.note)) continue;
      const k = `${opKey(e.note)}\u0000${e.category}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
  }
  const recurring = [];
  for (const [k, items] of groups) {
    const seen = [...new Set(items.map((e) => e.date.slice(0, 7)))].sort();
    if (seen.length < 2) continue;
    const last = items.reduce((a, e) => (e.date > a.date ? e : a));
    recurring.push({ note: last.note, category: k.split("\u0000")[1], amount: median(items.map((e) => -e.amount)),
      months: seen.length, last: last.date, day: Number(last.date.slice(8)), paid: seen.includes(cur) });
  }
  recurring.sort((a, b) => cmpTuple([a.paid ? 1 : 0, -a.amount, a.note], [b.paid ? 1 : 0, -b.amount, b.note]));
  const pending = recurring.filter((r) => !r.paid).reduce((s, r) => s + r.amount, 0);

  const counter = new Map();
  for (const m of span.slice(-3)) {
    for (const e of byMonth[m]) {
      const key = [opKey(e.note) || e.category.toLowerCase(), e.category, e.amount > 0];
      const id = key.join("\u0000");
      if (!counter.has(id)) counter.set(id, { key, n: 0, sample: [], note: "" });
      const c = counter.get(id);
      c.n++; c.sample.push(e.amount); c.note = e.note || e.category;
    }
  }
  const frequent = [...counter.values()]
    .sort((a, b) => cmpTuple([-a.n, a.key[0], a.key[1], a.key[2] ? 1 : 0], [-b.n, b.key[0], b.key[1], b.key[2] ? 1 : 0]))
    .slice(0, 8).filter((c) => c.n >= 2)
    .map((c) => ({ note: c.note, category: c.key[1], amount: median(c.sample), count: c.n }));

  const [y, mo] = cur.split("-").map(Number);
  const daysIn = new Date(y, mo, 0).getDate();
  const day = Number(ref.slice(8, 10));
  const forecast = Math.floor(Math.floor(now.expense / day) / 100) * 100 * daysIn;
  const m = (k) => money(k, ledger.currency);
  const insights = [];
  if (now.income) {
    const rate = pct(now.net, now.income);
    insights.push(rate >= 0 ? `Сбережения месяца: ${rate}% дохода (${m(now.net)}).` : `Расходы превышают доходы на ${m(-now.net)}.`);
  }
  if (avgExp && forecast > avgExp * 1.15) insights.push(`Темп трат выше обычного: к концу месяца выйдет ~${m(forecast)} при среднем ${m(avgExp)}.`);
  else if (avgExp && forecast < avgExp * 0.85) insights.push(`Тратите меньше обычного: прогноз ${m(forecast)} при среднем ${m(avgExp)}.`);
  for (const c of categories) {
    if (c.change !== null && c.change >= 30 && c.spent - c.average >= 100000) {
      insights.push(`«${c.category}»: ${m(c.spent)} — на ${c.change}% больше среднего.`);
    }
  }
  if (pending) {
    const n = recurring.filter((r) => !r.paid).length;
    insights.push(`Ещё не было ${n} ${plural(n, "регулярного платежа", "регулярных платежей", "регулярных платежей")} на ${m(pending)}.`);
  }
  const top = byMonth[cur].filter((e) => e.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 5);
  return { month: cur, currency: ledger.currency, trend, average_expense: avgExp, forecast,
    savings_rate: now.income ? pct(now.net, now.income) : null, categories, recurring, recurring_pending: pending,
    frequent, top, insights: insights.slice(0, 6), matrix };
}
