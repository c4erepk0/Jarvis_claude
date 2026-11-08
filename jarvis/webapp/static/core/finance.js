// Финансы: «Finance/2026-11.md» с таблицей операций, лимиты — «Finance/Budget.md». Порт jarvis/finance.py.
import { MONTHS_NOM, money, parseMoneyCell } from "./ru.js";

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
    }, `Jarvis: ${amount < 0 ? "расход" : "доход"} ${note || category}`);
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
